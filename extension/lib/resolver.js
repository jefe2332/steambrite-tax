/*
 * lib/resolver.js — Ohio sales-tax jurisdiction resolver.
 * Pure logic, NO chrome.* references. All I/O (data, fetch, caches, config)
 * is injected, so the same file runs inside the MV3 service worker
 * (importScripts) and under plain `node` for tests (require).
 *
 * Resolution order for {street, city, state, zip}:
 *   1. normalize; non-OH -> legacy backend estimate
 *   2. zip5 unambiguous            -> exact
 *   3. ambiguous + ZIP+4 range     -> exact
 *   4. ambiguous + addr shard:
 *        override range hit (exact-then-directional-stripped street match)
 *                                   -> that combo, exact
 *        street in shard `streets` directory but no override
 *                                   -> ZIP default combo, exact (shards are
 *                                      lossless override-only compactions)
 *        street NOT in `streets`    -> Census, but its matched ZIP must equal
 *                                      the input ZIP (fuzzy-snap guard)
 *   5. Census geocoder county FIPS -> filter candidates: one left -> high;
 *      several (transit split)     -> default combo -> verify;
 *      matched-ZIP mismatch        -> ZIP default combo -> verify
 *   6. FCC area API (lat/lon from Census), then legacy backend -> estimate
 *   fallback when everything is unreachable: ZIP default combo -> verify
 */
(function (root, factory) {
  var N;
  if (typeof module === 'object' && module.exports) {
    N = require('./normalize.js');
    module.exports = factory(N);
  } else {
    N = root.TaxExtNormalize;
    root.TaxExtResolver = factory(N);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (N) {
  'use strict';

  var FINDER_URL = 'https://thefinder.tax.ohio.gov/?tab=rateSearch';

  // The business's ACTUAL current Jobber tax-group names, keyed by
  // "CountyName|TransitName" (transit name empty when none).
  // Anything not listed falls back to the data file's suggested label
  // + "(add this group in Jobber)".
  var HARDCODED_LABELS = {
    'Butler|': 'OH-Butler',
    'Champaign|': 'OH-Champaign',
    'Clark|': 'OH-Clark',
    'Delaware|': 'OH-Delaware',
    'Fayette|': 'OH-Fayette',
    'Franklin|COTA': 'OH-Franklin',
    'Greene|': 'OH-Greene',
    'Hamilton|SORTA': 'OH-Hamilton',
    'Highland|': 'OH-Highland',
    'Logan|': 'OH-Logan',
    'Miami|': 'OH-Miami',
    'Montgomery|MVRTA': 'OH-Montgomery-57000',
    'Preble|': 'OH-Preble',
    'Shelby|': 'OH-Shelby',
    'Warren|': 'OH-Warren'
  };

  /* ------------------------------------------------------------------ */
  /* fetch helper: 8s AbortController timeout, single retry on network   */
  /* error, structured failure causes.                                   */
  /* ------------------------------------------------------------------ */

  function makeFetchJson(fetchImpl, defaultTimeoutMs) {
    defaultTimeoutMs = defaultTimeoutMs || 8000;
    return async function fetchJson(url, opts) {
      opts = opts || {};
      var timeoutMs = opts.timeoutMs || defaultTimeoutMs;
      var retries = opts.retries !== undefined ? opts.retries : 1;
      var lastErr = null;
      for (var attempt = 0; attempt <= retries; attempt++) {
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
        try {
          var res = await fetchImpl(url, {
            method: opts.method || 'GET',
            headers: opts.headers,
            body: opts.body,
            signal: ctrl ? ctrl.signal : undefined
          });
          if (timer) clearTimeout(timer);
          if (!res.ok) {
            var e = new Error('HTTP ' + res.status + ' from ' + url);
            e.cause = 'http_' + res.status;
            throw e; // HTTP errors are not retried
          }
          var json = await res.json();
          return json;
        } catch (err) {
          if (timer) clearTimeout(timer);
          if (err && err.cause && String(err.cause).indexOf('http_') === 0) throw err;
          var isAbort = err && (err.name === 'AbortError' || String(err.message || '').indexOf('abort') !== -1);
          lastErr = new Error(isAbort ? 'Timed out after ' + timeoutMs + 'ms: ' + url
                                      : 'Network error: ' + (err && err.message ? err.message : String(err)));
          lastErr.cause = isAbort ? 'timeout' : 'offline';
          // retry only network/timeout failures
        }
      }
      throw lastErr;
    };
  }

  /* ------------------------------------------------------------------ */
  /* small pure helpers (exported for tests)                             */
  /* ------------------------------------------------------------------ */

  function computeTotal(stateRate, countyRate, transitRate) {
    return stateRate + countyRate + (transitRate || 0);
  }

  function matchZip4(ranges, plus4) {
    if (!ranges || !plus4) return null;
    var n = parseInt(plus4, 10);
    if (isNaN(n)) return null;
    for (var i = 0; i < ranges.length; i++) {
      if (n >= ranges[i].lo && n <= ranges[i].hi) return ranges[i];
    }
    return null;
  }

  /**
   * Match a parsed street ({number, name}) against addr-shard records
   * [{street, lo, hi, oddEven|oe, c, t}]. Case-insensitive, suffix-normalized
   * street compare; number in [lo,hi]; odd/even 'O'/'E'/'B' honored.
   * Two passes: exact street name first, then with leading/trailing
   * directionals stripped on BOTH sides — the state boundary file stores
   * "SUNBURY RD" while input may say "S Sunbury Rd".
   */
  function matchShardStreet(records, parsed) {
    if (!records || !parsed) return null;
    var hit = scanShardRecords(records, parsed, parsed.name, false);
    if (hit) return hit;
    var stripped = N.stripDirectionals(parsed.name);
    if (stripped === parsed.name) return null; // nothing to strip; no second pass
    return scanShardRecords(records, parsed, stripped, true);
  }

  function scanShardRecords(records, parsed, wantName, stripRecordSide) {
    if (!wantName) return null;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var rName = N.normalizeStreetName(r.street);
      if (stripRecordSide) rName = N.stripDirectionals(rName);
      if (rName !== wantName) continue;
      if (parsed.number < r.lo || parsed.number > r.hi) continue;
      var oe = String(r.oddEven !== undefined ? r.oddEven : (r.oe !== undefined ? r.oe : 'B')).toUpperCase();
      if (oe === 'O' && parsed.number % 2 === 0) continue;
      if (oe === 'E' && parsed.number % 2 === 1) continue;
      return r;
    }
    return null;
  }

  /**
   * Does the shard's street directory (`streets`: sorted unique names from ALL
   * of the ZIP's raw address records, not just overrides) contain this street?
   * Exact normalized compare first, then directional-stripped on both sides.
   * Returns true / false, or null when the shard predates the `streets` field
   * (old format — caller must keep legacy behavior).
   */
  function shardStreetKnown(shard, parsed) {
    if (!shard || !Array.isArray(shard.streets)) return null;
    if (!parsed) return null;
    var want = parsed.name;
    var wantStripped = N.stripDirectionals(want);
    for (var i = 0; i < shard.streets.length; i++) {
      var s = N.normalizeStreetName(shard.streets[i]);
      if (s === want) return true;
      if (N.stripDirectionals(s) === wantStripped) return true;
    }
    return false;
  }

  /** Countywide transit for a county (e.g. Franklin -> COTA 25000), if any. */
  function countywideTransitFor(data, countyFips) {
    var county = data.counties[countyFips];
    if (!county) return null;
    var wantCoverage = county.name + ' County';
    for (var tf in data.transits) {
      var t = data.transits[tf];
      if (t.countywide && t.coverage === wantCoverage) return tf;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* resolver factory                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * deps:
   *   getData()           -> Promise<{data, source}>   source 'bundled'|'remote'
   *   fetchJson(url,opts) -> Promise<json>  (throws {cause:'timeout'|'offline'|'http_NNN'})
   *   cacheGet(key)/cacheSet(key,val)       lookup-result cache (session-scoped)
   *   getShard(zip5, dataVersion) -> Promise<{addr:[...]}|null>  null = unavailable
   *   getConfig()         -> Promise<{backendUrl, shardBaseUrl, dataUrl}>
   *   getLabelOverrides() -> Promise<{ 'countyFips|transitFips': 'label' }>
   */
  function createResolver(deps) {

    async function resolve(input) {
      var street = String(input.street || '').trim();
      var city = String(input.city || '').trim();
      var stateAbbr = N.normalizeState(input.state);
      var zipParts = N.parseZip(input.zip);

      var addr = {
        street: street, city: city,
        state: stateAbbr || String(input.state || '').trim(),
        zip5: zipParts ? zipParts.zip5 : null,
        plus4: zipParts ? zipParts.plus4 : null
      };
      var key = 'lookup:' + N.addressKey(street, city, input.state, input.zip);

      try {
        var cached = await deps.cacheGet(key);
        if (cached) return Object.assign({}, cached, { fromCache: true });
      } catch (e) { /* cache is best-effort */ }

      var result = await doResolve(addr);
      result.address = addr;
      try { await deps.cacheSet(key, result); } catch (e) { /* best-effort */ }
      return result;
    }

    async function doResolve(addr) {
      var attempts = [];

      // ---- step 1: non-Ohio -> straight to legacy backend estimate ----
      if (addr.state && addr.state !== 'OH') {
        var nonOhio = await backendEstimate(addr, false, attempts);
        if (nonOhio) { nonOhio.note = 'Non-Ohio address — estimate from legacy backend'; return nonOhio; }
        return failed('non-ohio', 'Non-Ohio address (' + addr.state + ') — no local data; backend unreachable', attempts);
      }

      if (!addr.zip5) {
        var noZip = await backendEstimate(addr, true, attempts);
        if (noZip) return noZip;
        return failed('no-zip', 'No ZIP code found in address', attempts);
      }

      var got = await deps.getData();
      var data = got.data, dataSource = got.source;
      var entry = data.zip5[addr.zip5];

      // ---- step 2: unambiguous ZIP5 ----
      if (entry && entry.c !== undefined) {
        return finish(data, dataSource, { c: entry.c, t: entry.t }, 'exact', 'zip5', {});
      }

      if (entry) {
        var candidates = entry.ambiguous || [];

        // ---- step 3: ZIP+4 override ranges ----
        if (addr.plus4) {
          var range = matchZip4(data.zip4 ? data.zip4[addr.zip5] : null, addr.plus4);
          if (range) return finish(data, dataSource, { c: range.c, t: range.t }, 'exact', 'zip4', {});
          // no range hit -> the default combo remains a candidate; keep going
          attempts.push({ stage: 'zip4', cause: 'no-match', message: 'ZIP+4 ' + addr.plus4 + ' not in any override range' });
        }

        // ---- step 4: street-address shard ----
        var parsed = N.parseStreet(addr.street);
        var streetUnknown = false; // street absent from the shard's street directory
        if (parsed) {
          var shard = null;
          try { shard = await deps.getShard(addr.zip5, data.meta && data.meta.version); }
          catch (e) { shard = null; }
          if (shard && shard.addr) {
            var rec = matchShardStreet(shard.addr, parsed);
            if (rec) return finish(data, dataSource, { c: rec.c, t: rec.t }, 'exact', 'addr', {});
            var known = shardStreetKnown(shard, parsed);
            if (known === true && entry.d) {
              // The shards are lossless override-only compactions: a street
              // that exists in this ZIP but hits no override range IS the
              // ZIP's default jurisdiction (verified when the sidecar was built).
              return finish(data, dataSource, entry.d, 'exact', 'addr-default', {});
            }
            if (known === false) {
              // Unknown/typo'd/nonexistent street: Census is allowed to try,
              // but only trusted if it matches within THIS ZIP (see guard below).
              streetUnknown = true;
              attempts.push({ stage: 'addr-shard', cause: 'street-unknown', message: 'street not found in this ZIP\'s street directory' });
            } else {
              // known === null: old-format shard without `streets` — legacy behavior
              attempts.push({ stage: 'addr-shard', cause: 'no-match', message: 'street not in override ranges' });
            }
          } else {
            attempts.push({ stage: 'addr-shard', cause: 'unavailable', message: 'shard not hosted / fetch failed' });
          }
        }

        // ---- step 5: Census geocoder ----
        var geo = await censusCounty(addr, attempts);
        // Fuzzy-snap guard: Census silently "corrects" nonexistent/typo'd
        // addresses onto nearby streets — sometimes across a county line. If
        // its matched address landed in a DIFFERENT ZIP, its county says
        // nothing about the input address: fall back to the ZIP default.
        if (geo && geo.countyFips && geo.matchedZip && geo.matchedZip !== addr.zip5) {
          attempts.push({
            stage: 'census', cause: 'zip-mismatch',
            message: 'Census matched a different ZIP (' + geo.matchedZip + ') — likely a fuzzy snap onto another street'
          });
          if (entry.d) {
            return finish(data, dataSource, entry.d, 'verify', 'zip-default', {
              candidates: candidates,
              note: (streetUnknown ? 'Street not found in this ZIP; ' : '') +
                'Census matched a different ZIP — using ZIP default',
              attempts: attempts
            });
          }
          geo.countyFips = null; // no default to fall back on: distrust the county
        }
        if (geo && geo.countyFips) {
          var filtered = candidates.filter(function (c) { return c.c === geo.countyFips; });
          if (filtered.length === 1) {
            return finish(data, dataSource, filtered[0], 'high', 'census', {});
          }
          if (filtered.length > 1) {
            // combos differ only by transit — pick ZIP default if it's in the
            // filtered set, else the county's no-transit combo; flag for human check
            var pick = null;
            if (entry.d && filtered.some(function (c) { return c.c === entry.d.c && c.t === entry.d.t; })) pick = entry.d;
            if (!pick) pick = filtered.find(function (c) { return !c.t; }) || filtered[0];
            return finish(data, dataSource, pick, 'verify', 'census', { candidates: filtered });
          }
          // census county not among ZIP candidates — trust the county, flag verify
          var combo = { c: geo.countyFips, t: countywideTransitFor(data, geo.countyFips) };
          if (data.counties[combo.c]) {
            return finish(data, dataSource, combo, 'verify', 'census-county', { candidates: candidates });
          }
        }

        // ---- step 6: FCC (needs lat/lon from a census match), then backend ----
        if (geo && geo.lat != null && geo.lon != null && !geo.countyFips) {
          var fcc = await fccCounty(geo.lat, geo.lon, attempts);
          if (fcc && data.counties[fcc]) {
            var f2 = candidates.filter(function (c) { return c.c === fcc; });
            if (f2.length === 1) return finish(data, dataSource, f2[0], 'high', 'fcc', {});
            var pick2 = (entry.d && f2.some(function (c) { return c.c === entry.d.c && c.t === entry.d.t; })) ? entry.d
                      : (f2.find(function (c) { return !c.t; }) || f2[0] || { c: fcc, t: countywideTransitFor(data, fcc) });
            return finish(data, dataSource, pick2, 'verify', 'fcc', { candidates: f2.length ? f2 : candidates });
          }
        }

        var be = await backendEstimate(addr, true, attempts);
        if (be) return be;

        // ---- last resort: ZIP default combo, flagged for human verification ----
        if (entry.d) {
          return finish(data, dataSource, entry.d, 'verify', 'zip-default',
            { candidates: candidates, note: 'Boundary ZIP; online checks unavailable — using ZIP default' , attempts: attempts });
        }
        return failed('ambiguous-unresolved', 'ZIP ' + addr.zip5 + ' is ambiguous and no resolution source was reachable', attempts);
      }

      // ---- ZIP not in Ohio dataset (but state says OH / unknown) ----
      var geo2 = await censusCounty(addr, attempts);
      if (geo2 && geo2.countyFips && data.counties[geo2.countyFips]) {
        var combo2 = { c: geo2.countyFips, t: countywideTransitFor(data, geo2.countyFips) };
        return finish(data, dataSource, combo2, 'high', 'census-county', {});
      }
      if (geo2 && geo2.lat != null && geo2.lon != null) {
        var fcc2 = await fccCounty(geo2.lat, geo2.lon, attempts);
        if (fcc2 && data.counties[fcc2]) {
          var combo3 = { c: fcc2, t: countywideTransitFor(data, fcc2) };
          return finish(data, dataSource, combo3, 'high', 'fcc', {});
        }
      }
      var be2 = await backendEstimate(addr, addr.state === 'OH', attempts);
      if (be2) return be2;
      return failed('zip-unknown', 'ZIP ' + addr.zip5 + ' not in Ohio data and no lookup source was reachable', attempts);
    }

    /* ------------------------- sub-lookups --------------------------- */

    async function censusCounty(addr, attempts) {
      var oneline = [addr.street, addr.city, ((addr.state || 'OH') + ' ' + (addr.zip5 || ''))]
        .filter(Boolean).join(', ');
      var url = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress' +
        '?address=' + encodeURIComponent(oneline) +
        '&benchmark=Public_AR_Current&vintage=Current_Current&format=json';
      try {
        var j = await deps.fetchJson(url);
        var matches = j && j.result && j.result.addressMatches;
        if (!matches || !matches.length) {
          attempts.push({ stage: 'census', cause: 'no-match', message: 'Census geocoder found no address match' });
          return null;
        }
        var m = matches[0];
        var out = { lat: null, lon: null, countyFips: null, matchedZip: null };
        if (m.coordinates) { out.lat = m.coordinates.y; out.lon = m.coordinates.x; }
        // ZIP of the address Census actually matched (it fuzzy-snaps typos and
        // nonexistent numbers onto nearby streets, sometimes in another ZIP).
        if (m.addressComponents && m.addressComponents.zip) {
          out.matchedZip = String(m.addressComponents.zip).slice(0, 5);
        } else if (m.matchedAddress) {
          var zm = String(m.matchedAddress).match(/(\d{5})(?:-\d{4})?\s*$/);
          if (zm) out.matchedZip = zm[1];
        }
        var geos = m.geographies || {};
        var counties = geos['Counties'] || geos['counties'] || [];
        if (counties.length) {
          var c0 = counties[0];
          if (String(c0.STATE) === '39' && c0.COUNTY) {
            out.countyFips = String(c0.COUNTY).padStart(3, '0');
          } else {
            attempts.push({ stage: 'census', cause: 'out-of-state', message: 'Census placed address outside Ohio' });
          }
        }
        return out;
      } catch (err) {
        attempts.push({ stage: 'census', cause: err.cause || 'error', message: err.message });
        return null;
      }
    }

    async function fccCounty(lat, lon, attempts) {
      var url = 'https://geo.fcc.gov/api/census/area?lat=' + encodeURIComponent(lat) +
        '&lon=' + encodeURIComponent(lon) + '&format=json';
      try {
        var j = await deps.fetchJson(url);
        var r = j && j.results && j.results[0];
        if (r && r.county_fips && String(r.county_fips).slice(0, 2) === '39') {
          return String(r.county_fips).slice(2, 5);
        }
        attempts.push({ stage: 'fcc', cause: 'no-match', message: 'FCC area API returned no Ohio county' });
        return null;
      } catch (err) {
        attempts.push({ stage: 'fcc', cause: err.cause || 'error', message: err.message });
        return null;
      }
    }

    async function backendEstimate(addr, forceOhio, attempts) {
      var cfg;
      try { cfg = await deps.getConfig(); } catch (e) { cfg = {}; }
      if (!cfg.backendUrl) {
        attempts.push({ stage: 'backend', cause: 'unconfigured', message: 'No backend URL configured' });
        return null;
      }
      var url = cfg.backendUrl.replace(/\/+$/, '') + '/api/lookup';
      try {
        var j = await deps.fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: { street: addr.street, city: addr.city, state: addr.state, zip: addr.zip5 || '' },
            forceOhio: !!forceOhio
          })
        });
        if (!j || j.totalRate === undefined) {
          attempts.push({ stage: 'backend', cause: 'bad-response', message: 'Backend returned no totalRate' });
          return null;
        }
        var breakdown = [];
        if (j.state && j.state.rate) breakdown.push({ name: j.state.name || 'State', rate: j.state.rate });
        if (j.county && j.county.rate) {
          var cn = j.county.name || 'County';
          if (!/county/i.test(cn)) cn += ' County';
          breakdown.push({ name: cn, rate: j.county.rate });
        }
        (j.districts || []).forEach(function (d) {
          if (d && d.rate) breakdown.push({ name: d.name || 'District', rate: d.rate });
        });
        var countyName = j.county && j.county.name ? String(j.county.name).replace(/county/i, '').trim() : '';
        var label = countyName ? 'OH-' + countyName : (addr.state && addr.state !== 'OH' ? addr.state + '-Tax' : 'OH-Tax');
        // If the backend's county maps onto a known combo, reuse its mapped label.
        var mapped = null;
        try {
          var got = await deps.getData();
          var combo = (got.data.jobberCombos || []).find(function (jc) {
            return jc.county && countyName && jc.county.toLowerCase() === countyName.toLowerCase() &&
                   Math.abs(jc.total - j.totalRate) < 1e-9;
          });
          if (combo) {
            var lbl = await effectiveLabel(got.data, combo.countyFips, combo.transitFips);
            label = lbl.label; mapped = lbl.mapped;
          }
        } catch (e) { /* label mapping is best-effort here */ }
        return {
          status: 'resolved',
          confidence: 'estimate',
          method: 'backend',
          label: label,
          labelDisplay: label + (mapped ? '' : ' (verify group in Jobber)'),
          labelMapped: !!mapped,
          county: j.county ? { fips: null, name: countyName || null, rate: j.county.rate || 0 } : null,
          transit: null,
          stateRate: j.state ? j.state.rate : null,
          total: j.totalRate,
          totalPct: N.pctString(j.totalRate),
          breakdown: breakdown,
          breakdownText: breakdown.map(function (b) { return b.name + ' ' + N.pctString(b.rate) + '%'; }).join(' + '),
          note: 'Estimate (legacy backend)',
          finderUrl: FINDER_URL,
          dataVersion: null,
          dataSource: 'backend',
          attempts: attempts
        };
      } catch (err) {
        attempts.push({ stage: 'backend', cause: err.cause || 'error', message: err.message });
        return null;
      }
    }

    /* ------------------------- result assembly ----------------------- */

    async function effectiveLabel(data, countyFips, transitFips) {
      var county = data.counties[countyFips];
      var transit = transitFips ? data.transits[transitFips] : null;
      var comboKey = countyFips + '|' + (transitFips || '');
      var nameKey = (county ? county.name : '') + '|' + (transit ? transit.name : '');

      var overrides = {};
      try { overrides = (await deps.getLabelOverrides()) || {}; } catch (e) { }
      if (overrides[comboKey]) return { label: overrides[comboKey], mapped: true, source: 'user' };
      if (HARDCODED_LABELS[nameKey]) return { label: HARDCODED_LABELS[nameKey], mapped: true, source: 'builtin' };

      var dataCombo = (data.jobberCombos || []).find(function (jc) {
        return jc.countyFips === countyFips && (jc.transitFips || null) === (transitFips || null);
      });
      if (dataCombo && dataCombo.label) return { label: dataCombo.label, mapped: false, source: 'data' };
      var fallback = 'OH-' + (county ? county.name : countyFips) + (transit ? '-' + transit.name : '');
      return { label: fallback, mapped: false, source: 'constructed' };
    }

    async function describeCombo(data, combo) {
      var county = data.counties[combo.c];
      var transit = combo.t ? data.transits[combo.t] : null;
      var total = computeTotal(data.stateRate, county ? county.rate : 0, transit ? transit.rate : 0);
      var lbl = await effectiveLabel(data, combo.c, combo.t || null);
      return {
        county: county ? { fips: combo.c, name: county.name, rate: county.rate } : null,
        transit: transit ? { fips: combo.t, name: transit.name, rate: transit.rate } : null,
        total: total,
        totalPct: N.pctString(total),
        label: lbl.label,
        mapped: lbl.mapped
      };
    }

    async function finish(data, dataSource, combo, confidence, method, extra) {
      var d = await describeCombo(data, combo);
      var breakdown = [{ name: 'Ohio', rate: data.stateRate }];
      if (d.county) breakdown.push({ name: d.county.name + ' County', rate: d.county.rate });
      if (d.transit) breakdown.push({ name: d.transit.name, rate: d.transit.rate });

      var candidates = null;
      if (extra.candidates && extra.candidates.length) {
        candidates = [];
        for (var i = 0; i < extra.candidates.length; i++) {
          candidates.push(await describeCombo(data, extra.candidates[i]));
        }
      }

      return {
        status: 'resolved',
        confidence: confidence,          // 'exact' | 'high' | 'verify'
        method: method,                  // zip5|zip4|addr|addr-default|census|census-county|fcc|zip-default
        county: d.county,
        transit: d.transit,
        stateRate: data.stateRate,
        total: d.total,
        totalPct: d.totalPct,
        label: d.label,
        labelDisplay: d.label + (d.mapped ? '' : ' (add this group in Jobber)'),
        labelMapped: d.mapped,
        breakdown: breakdown,
        breakdownText: breakdown.map(function (b) { return b.name + ' ' + N.pctString(b.rate) + '%'; }).join(' + '),
        candidates: candidates,
        finderUrl: confidence === 'verify' ? FINDER_URL : null,
        dataVersion: data.meta ? data.meta.version : null,
        dataSource: dataSource,
        note: extra.note || null,
        attempts: extra.attempts && extra.attempts.length ? extra.attempts : null
      };
    }

    function failed(reason, message, attempts) {
      return {
        status: 'failed',
        reason: reason,
        message: message,
        attempts: attempts,
        finderUrl: FINDER_URL
      };
    }

    return { resolve: resolve };
  }

  return {
    FINDER_URL: FINDER_URL,
    HARDCODED_LABELS: HARDCODED_LABELS,
    makeFetchJson: makeFetchJson,
    computeTotal: computeTotal,
    matchZip4: matchZip4,
    matchShardStreet: matchShardStreet,
    shardStreetKnown: shardStreetKnown,
    countywideTransitFor: countywideTransitFor,
    createResolver: createResolver
  };
});
