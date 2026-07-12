/*
 * tests/resolver.test.js — run with plain `node tests/resolver.test.js`.
 * No dependencies. Exercises lib/resolver.js against the REAL bundled data
 * (data/ohio-tax-data.json) with injected fetch/cache/shard stubs.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const N = require(path.join(__dirname, '..', 'lib', 'normalize.js'));
const R = require(path.join(__dirname, '..', 'lib', 'resolver.js'));

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ohio-tax-data.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
}
function section(title) { console.log('\n== ' + title + ' =='); }

function makeDeps(overrides) {
  return Object.assign({
    getData: async () => ({ data, source: 'bundled' }),
    // default: all network dead (offline) — resolver must degrade gracefully
    fetchJson: async (url) => { const e = new Error('stub: network disabled for ' + url); e.cause = 'offline'; throw e; },
    cacheGet: async () => undefined,
    cacheSet: async () => { },
    getShard: async () => null,
    getConfig: async () => ({ backendUrl: 'https://backend.test', shardBaseUrl: 'https://shards.test' }),
    getLabelOverrides: async () => ({})
  }, overrides || {});
}

async function main() {
  console.log('resolver.test.js — data version ' + data.meta.version + ', stateRate ' + data.stateRate);

  /* ---------------------------------------------------------------- */
  section('1. 43215 (Columbus) -> Franklin + COTA 8.00% exact via zip5');
  {
    const r = await R.createResolver(makeDeps()).resolve(
      { street: '123 S High St', city: 'Columbus', state: 'OH', zip: '43215' });
    check('status resolved', r.status === 'resolved', JSON.stringify(r));
    check('confidence exact', r.confidence === 'exact', r.confidence);
    check('method zip5', r.method === 'zip5', r.method);
    check('county Franklin', r.county && r.county.name === 'Franklin', r.county && r.county.name);
    check('transit COTA', r.transit && r.transit.name === 'COTA', r.transit && r.transit.name);
    check('total 8.00%', r.totalPct === '8.00', r.totalPct);
    check('label OH-Franklin (business mapping overrides data label)', r.label === 'OH-Franklin', r.label);
    check('label is mapped (no "add this group" note)', r.labelMapped === true && r.labelDisplay === 'OH-Franklin', r.labelDisplay);
    check('breakdown Ohio 5.75 + Franklin County 1.25 + COTA 1.00',
      r.breakdownText === 'Ohio 5.75% + Franklin County 1.25% + COTA 1.00%', r.breakdownText);
  }

  /* ---------------------------------------------------------------- */
  section('2. 45040 (Mason) -> Warren 6.75% exact, label OH-Warren');
  {
    const r = await R.createResolver(makeDeps()).resolve(
      { street: '456 Reading Rd', city: 'Mason', state: 'Ohio', zip: '45040' });
    check('status resolved', r.status === 'resolved');
    check('confidence exact', r.confidence === 'exact', r.confidence);
    check('county Warren', r.county && r.county.name === 'Warren', r.county && r.county.name);
    check('no transit', r.transit === null, JSON.stringify(r.transit));
    check('total 6.75%', r.totalPct === '6.75', r.totalPct);
    check('label OH-Warren', r.label === 'OH-Warren', r.label);
    check('breakdown Ohio 5.75 + Warren County 1.00',
      r.breakdownText === 'Ohio 5.75% + Warren County 1.00%', r.breakdownText);
  }

  /* ---------------------------------------------------------------- */
  section('3. 43082 (Westerville) ambiguous, no +4/shard/census -> default d, verify');
  {
    const r = await R.createResolver(makeDeps()).resolve(
      { street: '789 Polaris Pkwy', city: 'Westerville', state: 'OH', zip: '43082' });
    const d = data.zip5['43082'].d;
    check('status resolved', r.status === 'resolved');
    check('confidence verify', r.confidence === 'verify', r.confidence);
    check('method zip-default', r.method === 'zip-default', r.method);
    check('uses default combo d (' + JSON.stringify(d) + ')',
      r.county.fips === d.c && ((r.transit && r.transit.fips) || null) === (d.t || null),
      JSON.stringify({ c: r.county.fips, t: r.transit && r.transit.fips }));
    check('default is Delaware no-transit 7.00%', r.county.name === 'Delaware' && r.totalPct === '7.00',
      r.county.name + ' ' + r.totalPct);
    check('candidates listed (3 combos)', Array.isArray(r.candidates) && r.candidates.length === 3,
      r.candidates && r.candidates.length);
    check('finder link included', typeof r.finderUrl === 'string' && r.finderUrl.includes('thefinder.tax.ohio.gov'));
  }

  /* ---------------------------------------------------------------- */
  section('4. 43082 with ZIP+4 inside an override range -> that combo, exact');
  {
    const ranges = data.zip4['43082'];
    const range = ranges[0]; // real range from the data (lo..hi -> c/t)
    const plus4 = String(range.lo).padStart(4, '0');
    const r = await R.createResolver(makeDeps()).resolve(
      { street: '1 Boundary Ln', city: 'Westerville', state: 'OH', zip: '43082-' + plus4 });
    check('status resolved', r.status === 'resolved');
    check('confidence exact', r.confidence === 'exact', r.confidence);
    check('method zip4', r.method === 'zip4', r.method);
    check('combo matches override range {c:' + range.c + ', t:' + range.t + '}',
      r.county.fips === range.c && ((r.transit && r.transit.fips) || null) === (range.t || null),
      JSON.stringify({ c: r.county.fips, t: r.transit && r.transit.fips }));
    const expTotal = N.pctString(R.computeTotal(data.stateRate, data.counties[range.c].rate,
      range.t ? data.transits[range.t].rate : 0));
    check('total matches combo rate math (' + expTotal + '%)', r.totalPct === expTotal, r.totalPct);
  }

  /* ---------------------------------------------------------------- */
  section('5. 43068 (Reynoldsburg) candidate set includes Franklin+COTA 8.00% and Licking+COTA 8.25%');
  {
    const r = await R.createResolver(makeDeps()).resolve(
      { street: '10 Main St', city: 'Reynoldsburg', state: 'OH', zip: '43068' });
    check('status resolved + verify', r.status === 'resolved' && r.confidence === 'verify',
      r.status + '/' + r.confidence);
    const cands = (r.candidates || []).map(c =>
      (c.county ? c.county.name : '?') + '+' + (c.transit ? c.transit.name : 'none') + '@' + c.totalPct);
    check('includes Franklin+COTA@8.00', cands.some(s => s === 'Franklin+COTA@8.00'), cands.join(', '));
    check('includes Licking+COTA@8.25', cands.some(s => s === 'Licking+COTA@8.25'), cands.join(', '));
  }

  /* ---------------------------------------------------------------- */
  section('6. Rate math matches jobberCombos totals for EVERY combo (' + data.jobberCombos.length + ' combos)');
  {
    let mismatches = [];
    for (const jc of data.jobberCombos) {
      const county = data.counties[jc.countyFips];
      const transit = jc.transitFips ? data.transits[jc.transitFips] : null;
      const total = R.computeTotal(data.stateRate, county.rate, transit ? transit.rate : 0);
      if (Math.abs(total - jc.total) > 1e-9) mismatches.push(jc.label + ': ' + total + ' vs ' + jc.total);
      if (N.pctString(total) !== N.pctString(jc.total)) mismatches.push(jc.label + ' display: ' + N.pctString(total));
    }
    check('all ' + data.jobberCombos.length + ' combo totals match stateRate+county+transit',
      mismatches.length === 0, mismatches.slice(0, 5).join('; '));
  }

  /* ---------------------------------------------------------------- */
  section('7. Address shard matching (43082, synthetic shard in documented shape)');
  {
    const shard = {
      zip: '43082', v: data.meta.version,
      addr: [
        { street: 'ABBEYCROSS LN', lo: 1, hi: 67, oddEven: 'O', c: '041', t: '96000' },
        { street: 'MAIN ST', lo: 100, hi: 200, oddEven: 'E', c: '049', t: '25000' }
      ]
    };
    const deps = makeDeps({ getShard: async (z) => (z === '43082' ? shard : null) });
    // odd number inside range, suffix spelled out -> matches the 'O' range
    const r1 = await R.createResolver(deps).resolve(
      { street: '15 Abbeycross Lane', city: 'Westerville', state: 'OH', zip: '43082' });
    check('odd 15 Abbeycross Lane -> exact via addr shard', r1.confidence === 'exact' && r1.method === 'addr',
      r1.confidence + '/' + r1.method);
    check('  -> Delaware + COTA 8.00%', r1.county.name === 'Delaware' && r1.transit && r1.transit.name === 'COTA' && r1.totalPct === '8.00',
      r1.county.name + '/' + (r1.transit && r1.transit.name) + '/' + r1.totalPct);
    // even number violates odd-only constraint -> falls through to default/verify
    const r2 = await R.createResolver(deps).resolve(
      { street: '16 Abbeycross Lane', city: 'Westerville', state: 'OH', zip: '43082' });
    check('even 16 (odd-only range) does NOT match shard', r2.method !== 'addr', r2.method);
    check('  -> degrades to zip-default verify', r2.method === 'zip-default' && r2.confidence === 'verify',
      r2.method + '/' + r2.confidence);
    // legacy 'oe' key form also supported
    const shardOe = { zip: '43082', v: data.meta.version, addr: [{ street: 'ABBEYCROSS LN', lo: 1, hi: 67, oe: 'O', c: '041', t: '96000' }] };
    const r3 = await R.createResolver(makeDeps({ getShard: async () => shardOe })).resolve(
      { street: '15 Abbeycross Ln', city: 'Westerville', state: 'OH', zip: '43082' });
    check("legacy 'oe' key + pre-abbreviated suffix also matches", r3.method === 'addr' && r3.totalPct === '8.00',
      r3.method + '/' + r3.totalPct);
  }

  /* ---------------------------------------------------------------- */
  section('8. Census disambiguation (stubbed Census response)');
  {
    const censusResp = {
      result: {
        addressMatches: [{
          coordinates: { x: -82.93, y: 40.11 },
          geographies: { Counties: [{ STATE: '39', COUNTY: '049', BASENAME: 'Franklin' }] }
        }]
      }
    };
    const deps = makeDeps({
      fetchJson: async (url) => {
        if (url.includes('geocoding.geo.census.gov')) return censusResp;
        const e = new Error('stub: other fetches disabled'); e.cause = 'offline'; throw e;
      }
    });
    const r = await R.createResolver(deps).resolve(
      { street: '921 Some St', city: 'Westerville', state: 'OH', zip: '43082' });
    check('census filters 43082 candidates to Franklin+COTA (single) -> high',
      r.confidence === 'high' && r.method === 'census', r.confidence + '/' + r.method);
    check('  -> 8.00% OH-Franklin', r.totalPct === '8.00' && r.label === 'OH-Franklin',
      r.totalPct + '/' + r.label);

    // Census says Delaware county (041) -> two 041 candidates remain (transit split) -> verify + default
    const censusDelaware = {
      result: {
        addressMatches: [{
          coordinates: { x: -82.9, y: 40.15 },
          geographies: { Counties: [{ STATE: '39', COUNTY: '041', BASENAME: 'Delaware' }] }
        }]
      }
    };
    const deps2 = makeDeps({
      fetchJson: async (url) => {
        if (url.includes('geocoding.geo.census.gov')) return censusDelaware;
        const e = new Error('stub'); e.cause = 'offline'; throw e;
      }
    });
    const r2 = await R.createResolver(deps2).resolve(
      { street: '922 Other St', city: 'Westerville', state: 'OH', zip: '43082' });
    check('census county with transit split -> verify, ZIP default picked',
      r2.confidence === 'verify' && r2.method === 'census' && r2.county.name === 'Delaware' && !r2.transit,
      r2.confidence + '/' + r2.method + '/' + r2.county.name + '/' + JSON.stringify(r2.transit));
    check('  candidate list = the 2 Delaware combos', (r2.candidates || []).length === 2,
      r2.candidates && r2.candidates.length);
  }

  /* ---------------------------------------------------------------- */
  section('9. Backend fallback + non-Ohio handling');
  {
    const backendResp = {
      state: { name: 'Kentucky', rate: 0.06 }, county: { name: 'Kenton', rate: 0 },
      districts: [], totalRate: 0.06
    };
    const deps = makeDeps({
      fetchJson: async (url, opts) => {
        if (url.includes('backend.test') && opts && opts.method === 'POST') return backendResp;
        const e = new Error('stub'); e.cause = 'offline'; throw e;
      }
    });
    const r = await R.createResolver(deps).resolve(
      { street: '1 River Rd', city: 'Covington', state: 'KY', zip: '41011' });
    check('non-Ohio -> backend estimate', r.status === 'resolved' && r.confidence === 'estimate' && r.method === 'backend',
      JSON.stringify({ s: r.status, c: r.confidence, m: r.method }));
    check('  totalPct 6.00', r.totalPct === '6.00', r.totalPct);
    check('  note marks it non-Ohio/legacy', /Non-Ohio/.test(r.note || ''), r.note);

    // everything offline, non-Ohio -> graceful failure with attempts trail
    const r2 = await R.createResolver(makeDeps()).resolve(
      { street: '1 River Rd', city: 'Covington', state: 'KY', zip: '41011' });
    check('non-Ohio + backend down -> failed gracefully with cause', r2.status === 'failed' &&
      Array.isArray(r2.attempts) && r2.attempts.some(a => a.stage === 'backend'),
      JSON.stringify(r2.attempts));
  }

  /* ---------------------------------------------------------------- */
  section('10. Lookup cache + label overrides');
  {
    const store = new Map();
    let resolves = 0;
    const deps = makeDeps({
      cacheGet: async k => store.get(k),
      cacheSet: async (k, v) => { store.set(k, v); resolves++; },
      getLabelOverrides: async () => ({ '165|': 'OH-Warren-CUSTOM' })
    });
    const res = R.createResolver(deps);
    const a = { street: '456 Reading Road', city: 'Mason', state: 'OH', zip: '45040' };
    const r1 = await res.resolve(a);
    // same address, different formatting -> served from cache (normalized key)
    const r2 = await res.resolve({ street: '456 Reading Rd', city: 'Mason', state: 'Ohio', zip: '45040' });
    check('user label override wins (storage.sync)', r1.label === 'OH-Warren-CUSTOM', r1.label);
    check('normalized-key cache hit (St/Street, OH/Ohio)', r2.fromCache === true && resolves === 1,
      'fromCache=' + r2.fromCache + ' sets=' + resolves);
  }

  /* ---------------------------------------------------------------- */
  console.log('\n================================');
  console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
