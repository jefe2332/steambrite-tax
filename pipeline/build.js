#!/usr/bin/env node
/*
 * Ohio Sales-Tax Data Pipeline
 * ----------------------------
 * Downloads Ohio Dept of Taxation "The Finder" Streamlined Sales Tax (SST)
 * boundary + rate files and compiles them into a compact ZIP -> jurisdiction
 * lookup for a Chrome extension.
 *
 * Usage:
 *   node build.js            # build from raw/ (downloads only if missing)
 *   node build.js --fresh    # re-download everything, then build
 *
 * Outputs (dist/):
 *   ohio-tax-data.json       zip5 + zip4(overrides) + counties/transits/combos
 *   ohio-tax-data.min.json   minified version of the above
 *   ohio-addr-ranges.json    address-range overrides for ambiguous ZIPs (sidecar)
 *   VERIFICATION.md          rate cross-checks against the state's own report
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROOT = __dirname;
const RAW = path.join(ROOT, 'raw');
const DIST = path.join(ROOT, 'dist');
const BOUNDARY_EXTRACT = path.join(RAW, 'boundary_extracted');

// Effective-date filter. Defaults to the current date so the quarterly GitHub
// Action automatically picks up whichever quarter is active when it runs
// (a hardcoded date would silently drop a newly-effective quarter's rows and
// emit an empty/broken data file). Override with BUILD_EFFECTIVE_DATE=YYYYMMDD
// to reproduce a specific quarter's build.
function todayYmd() {
  const env = process.env.BUILD_EFFECTIVE_DATE;
  if (env && /^\d{8}$/.test(env)) return env;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
const TODAY = todayYmd();                       // YYYYMMDD
const TODAY_ISO = `${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}`;
const STATE_RATE = 0.0575;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The Finder (rebuilt as a Next.js app, September 2026). The site lists its
// downloadable files as JSON and serves each file through a same-origin proxy;
// the direct api.thefinder.tax.ohio.gov URLs require authentication.
const FINDER = 'https://thefinder.tax.ohio.gov';
const LIST_URL = FINDER + '/api/file-downloads?type=salesAndUse';
const PROXY = FINDER + '/api/file-downloads/content?target=';
const proxied = (u) => PROXY + encodeURIComponent(u);
// Direct source URLs recorded during download(), written into meta.sources.
const SOURCES = [];

const FRESH = process.argv.includes('--fresh');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function log(...a) { console.log(...a); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function curl(url, outFile) {
  // -sS quiet but show errors, -L follow redirects, -f fail on HTTP errors.
  const args = ['-sS', '-fL', '-A', UA, '-o', outFile, url];
  execFileSync('curl', args, { stdio: ['ignore', 'inherit', 'inherit'] });
}

function curlText(url) {
  return execFileSync('curl', ['-sS', '-fL', '-A', UA, url], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

// round to 5 decimal places to kill FP noise
function r5(x) { return Math.round(x * 1e5) / 1e5; }

// ---------------------------------------------------------------------------
// Step 1: download
// ---------------------------------------------------------------------------
function download() {
  ensureDir(RAW);

  // Ask The Finder for its current sales-and-use download list. The quarterly
  // boundary/rate file names (OHB2026Q1NOV28.zip etc.) come from this JSON.
  let boundaryZipName, rateCsvName, urls = null;
  try {
    const list = JSON.parse(curlText(LIST_URL));
    urls = list.downloadUrls || {};
    const need = ['sstpRateDataZip', 'sstpRateDatabase', 'countyFips',
      'muniFips', 'transitFips', 'countyRateReportCsv'];
    const missing = need.filter(k => !urls[k]);
    if (missing.length) throw new Error(`file list missing ${missing.join(', ')}`);
    boundaryZipName = path.basename(new URL(urls.sstpRateDataZip).pathname);
    rateCsvName = path.basename(new URL(urls.sstpRateDatabase).pathname);
    log(`  discovered boundary file: ${boundaryZipName}`);
    log(`  discovered rate file:     ${rateCsvName}`);
  } catch (e) {
    // Fall back to whatever OHB*.zip / OHR*.csv already sits in raw/.
    log(`  file list unavailable (${e.message}); falling back to raw/ contents`);
    const files = fs.existsSync(RAW) ? fs.readdirSync(RAW) : [];
    boundaryZipName = files.find(f => /^OHB.*\.zip$/i.test(f));
    rateCsvName = files.find(f => /^OHR.*\.csv$/i.test(f));
    if (!boundaryZipName || !rateCsvName) throw e;
  }

  const jobs = urls ? [
    [boundaryZipName, proxied(urls.sstpRateDataZip), urls.sstpRateDataZip],
    [rateCsvName, proxied(urls.sstpRateDatabase), urls.sstpRateDatabase],
    ['OHCountyFIPSCodes.txt', proxied(urls.countyFips), urls.countyFips],
    ['OHMuniFIPSCodes.txt', proxied(urls.muniFips), urls.muniFips],
    ['OHTransitFIPSCodes.txt', proxied(urls.transitFips), urls.transitFips],
    ['CountySalesTaxRateReport.csv', proxied(urls.countyRateReportCsv), urls.countyRateReportCsv],
  ] : [];
  for (const j of jobs) SOURCES.push(j[2]);
  if (!urls) {
    for (const name of [boundaryZipName, rateCsvName, 'OHCountyFIPSCodes.txt',
      'OHMuniFIPSCodes.txt', 'OHTransitFIPSCodes.txt', 'CountySalesTaxRateReport.csv']) {
      if (!fs.existsSync(path.join(RAW, name))) throw new Error(`offline and ${name} is not cached in raw/`);
    }
  }

  for (const [name, url] of jobs) {
    const dest = path.join(RAW, name);
    if (!FRESH && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      log(`  skip (cached): ${name}`);
      continue;
    }
    log(`  downloading: ${name}`);
    curl(url, dest);
  }

  // Extract the boundary zip.
  const boundaryCsv = path.join(BOUNDARY_EXTRACT,
    boundaryZipName.replace(/\.zip$/i, '.csv'));
  if (FRESH || !fs.existsSync(boundaryCsv)) {
    ensureDir(BOUNDARY_EXTRACT);
    const zipPath = path.join(RAW, boundaryZipName);
    log(`  extracting: ${boundaryZipName}`);
    extractZip(zipPath, BOUNDARY_EXTRACT);
  } else {
    log(`  skip (cached): boundary CSV extracted`);
  }

  return {
    boundaryCsv,
    rateCsv: path.join(RAW, rateCsvName),
    version: (boundaryZipName.match(/OHB(\d{4}Q\d)/) || [, 'unknown'])[1],
    boundaryZipName, rateCsvName,
  };
}

function extractZip(zipPath, destDir) {
  // Prefer unzip (Git Bash), fall back to PowerShell Expand-Archive (Win11).
  try {
    execFileSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'ignore' });
    return;
  } catch (_) { /* try PowerShell */ }
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
    { stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Step 2: parse reference + rate files
// ---------------------------------------------------------------------------
function parseCountyNames() {
  // FIPS_CODE,COUNTY_NAME  (3-digit -> Title Case name)
  const txt = fs.readFileSync(path.join(RAW, 'OHCountyFIPSCodes.txt'), 'utf8');
  const map = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{3}),(.+?)\s*$/);
    if (!m) continue;
    map[m[1]] = titleCase(m[2]);
  }
  return map;
}

function parseTransitRef() {
  // TransitFIPSPlace,Abbr,Name,Description  (may carry a UTF-8 BOM)
  const txt = fs.readFileSync(path.join(RAW, 'OHTransitFIPSCodes.txt'), 'utf8')
    .replace(/^﻿/, '');
  const map = {};
  const lines = txt.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Description can contain commas ("Cities of Columbus, Westerville...").
    const parts = line.split(',');
    const fips = parts[0].trim();
    if (!/^\d{5}$/.test(fips)) continue;
    const abbr = parts[1].trim();
    const name = parts[2].trim();
    const desc = parts.slice(3).join(',').trim();
    // Countywide iff the description is exactly "<Something> County".
    const countywide = /^[A-Za-z.\s]+County$/.test(desc);
    map[fips] = { abbr, name, desc, countywide };
  }
  return map;
}

function titleCase(s) {
  // FIPS file uses underscores for spaces (e.g. VAN_WERT -> Van Wert).
  return s.replace(/_/g, ' ').toLowerCase()
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

function parseRates(rateCsv) {
  // 9 fields: state, jurisType(45=State,00=County,63=Transit), fips,
  //           genRate, ..., effStart, effEnd
  const txt = fs.readFileSync(rateCsv, 'utf8');
  const counties = {}; // fips3 -> rate (county portion)
  const transits = {}; // fips5 -> rate
  let stateRate = null;
  let futureRateChanges = 0;

  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split(',');
    const jur = f[1], fips = f[2], rate = parseFloat(f[3]);
    const eff = f[7], exp = f[8];
    if (eff > TODAY) { futureRateChanges++; continue; }
    if (!(eff <= TODAY && exp >= TODAY)) continue; // not active today
    if (jur === '45') stateRate = r5(rate);
    else if (jur === '00') counties[fips] = r5(rate);
    else if (jur === '63') transits[fips] = r5(rate);
  }
  return { stateRate, counties, transits, futureRateChanges };
}

// ---------------------------------------------------------------------------
// Step 3: parse the boundary file (two streaming passes)
// ---------------------------------------------------------------------------
// Boundary record layout (89 comma-delimited fields, 1-indexed):
//   [1]  record type: Z (ZIP5) | 4 (ZIP+4) | A (address range)
//   [2]  effective start  YYYYMMDD
//   [3]  effective end     YYYYMMDD (99991231 = open)
//   [4]  address low       (A)
//   [5]  address high      (A)
//   [6]  odd/even/both     (A) O|E|B
//   [7]  pre-directional   (A)
//   [8]  street name       (A)
//   [9]  street suffix     (A)
//   [10] post-directional  (A)
//   [11] secondary unit abbr / [12] low / [13] high / [14] o-e-b  (A)
//   [15] city              (A)
//   [16] ZIP5   (A records)      [17] plus4 (A records)
//   [18] ZIP5   (Z/4 records)    [19] plus4 low (4)
//   [20] ZIP5   (Z/4, == [18])   [21] plus4 high (4)
//   [23]/[24] state FIPS (39)   [25] county FIPS (3-digit)
//   [30] "ST" transit marker  [31] transit place FIPS (5-digit)  [32] "63"
function comboKey(county, transit) { return county + '|' + (transit || ''); }
function comboObj(key) {
  const [c, t] = key.split('|');
  return { c, t: t || null };
}

function forEachLine(file, onLine, onDone) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });
    rl.on('line', onLine);
    rl.on('close', () => { if (onDone) onDone(); resolve(); });
    rl.on('error', reject);
  });
}

async function parseBoundary(boundaryCsv) {
  // Pass 1: per-ZIP set of combos (active records only) + Z-record default.
  const zipCombos = new Map(); // zip -> Set(comboKey)
  const zipDefault = new Map(); // zip -> comboKey (from Z record)
  const countyCombos = new Map(); // county -> Set(comboKey) (for verification)
  let active = 0;

  await forEachLine(boundaryCsv, (line) => {
    // quick field slice; avoid full split cost where possible
    const f = line.split(',');
    if (f[1] > TODAY || f[2] < TODAY) return; // inactive (eff>today or exp<today)
    active++;
    const type = f[0];
    const zip = type === 'A' ? f[15] : f[17];
    const county = f[24];
    const transit = f[30];
    const key = comboKey(county, transit);
    let s = zipCombos.get(zip);
    if (!s) { s = new Set(); zipCombos.set(zip, s); }
    s.add(key);
    let cs = countyCombos.get(county);
    if (!cs) { cs = new Set(); countyCombos.set(county, cs); }
    cs.add(key);
    if (type === 'Z') zipDefault.set(zip, key);
  });

  // Classify ZIPs.
  const ambiguous = new Set();
  for (const [zip, set] of zipCombos) if (set.size > 1) ambiguous.add(zip);

  // Pass 2: collect override ZIP+4 and address ranges for ambiguous ZIPs only,
  // PLUS the full street directory (ALL streets present in each ambiguous
  // ZIP's A-records, default rows included). The directory is what lets a
  // consumer distinguish "street exists here with the default combo" (exact)
  // from "street unknown in this ZIP" (typo/nonexistent -> geocoder guard).
  const zip4 = new Map(); // zip -> [{lo,hi,c,t}]
  const addr = new Map(); // zip -> [{street,lo,hi,oe,c,t}]
  const zipStreets = new Map(); // zip -> Set(street) — ALL A-record streets

  await forEachLine(boundaryCsv, (line) => {
    const f = line.split(',');
    if (f[1] > TODAY || f[2] < TODAY) return;
    const type = f[0];
    if (type === 'Z') return;
    const zip = type === 'A' ? f[15] : f[17];
    if (!ambiguous.has(zip)) return;
    const key = comboKey(f[24], f[30]);

    if (type === 'A') {
      const street = [f[6], f[7], f[8], f[9]]
        .map(s => s.trim()).filter(Boolean).join(' ');
      if (street) {
        let ss = zipStreets.get(zip);
        if (!ss) { ss = new Set(); zipStreets.set(zip, ss); }
        ss.add(street);
      }
      if (key === zipDefault.get(zip)) return; // override-only (skip default)
      const combo = comboObj(key);
      const lo = parseInt(f[3], 10);
      const hi = parseInt(f[4], 10);
      const oe = f[5] || 'B';
      if (!addr.has(zip)) addr.set(zip, []);
      addr.get(zip).push({ street, lo, hi, oe, c: combo.c, t: combo.t });
    } else if (type === '4') {
      if (key === zipDefault.get(zip)) return; // override-only (skip default)
      const combo = comboObj(key);
      const lo = parseInt(f[18], 10);
      const hi = parseInt(f[20], 10);
      if (!zip4.has(zip)) zip4.set(zip, []);
      zip4.get(zip).push({ lo, hi, c: combo.c, t: combo.t });
    }
  });

  return { zipCombos, zipDefault, countyCombos, ambiguous, zip4, addr, zipStreets, active };
}

// ---------------------------------------------------------------------------
// Step 4: assemble outputs
// ---------------------------------------------------------------------------
function build() {
  ensureDir(DIST);
  log('== Step 1: download / locate raw files ==');
  const src = download();

  log('== Step 2: parse reference + rate tables ==');
  const countyNames = parseCountyNames();
  const transitRef = parseTransitRef();
  const rates = parseRates(src.rateCsv);
  const stateRate = rates.stateRate != null ? rates.stateRate : STATE_RATE;
  log(`  state rate: ${stateRate}`);
  log(`  active counties: ${Object.keys(rates.counties).length}`);
  log(`  active transits: ${Object.keys(rates.transits).length}`);
  log(`  future-dated rate changes in file: ${rates.futureRateChanges}`);

  log('== Step 3: parse boundary file (2 passes over ~1.9M rows) ==');
  return parseBoundary(src.boundaryCsv).then((b) => {
    log(`  active boundary records: ${b.active}`);
    log(`  ZIP5s: ${b.zipCombos.size} (ambiguous: ${b.ambiguous.size})`);

    // ---- counties map (county portion only) ----
    const counties = {};
    for (const [fips, rate] of Object.entries(rates.counties)) {
      counties[fips] = { name: countyNames[fips] || fips, rate };
    }
    // ---- transits map ----
    const transits = {};
    for (const [fips, rate] of Object.entries(rates.transits)) {
      const ref = transitRef[fips] || {};
      transits[fips] = {
        name: ref.abbr || fips,
        fullName: ref.name || null,
        coverage: ref.desc || null,
        countywide: !!ref.countywide,
        rate,
      };
    }

    // ---- zip5 map ----
    const zip5 = {};
    for (const [zip, set] of b.zipCombos) {
      if (set.size === 1) {
        zip5[zip] = comboObj([...set][0]);
      } else {
        const def = comboObj(b.zipDefault.get(zip));
        const candidates = [...set].map(comboObj);
        zip5[zip] = { d: def, ambiguous: candidates };
      }
    }

    // ---- zip4 (override-only, ambiguous zips) ----
    const zip4 = {};
    for (const [zip, arr] of b.zip4) {
      arr.sort((a, x) => a.lo - x.lo);
      zip4[zip] = arr;
    }

    // ---- addr (override-only, ambiguous zips) -> sidecar ----
    const addr = {};
    let addrCount = 0;
    for (const [zip, arr] of b.addr) {
      arr.sort((a, x) => (a.street < x.street ? -1 : a.street > x.street ? 1 : a.lo - x.lo));
      addr[zip] = arr;
      addrCount += arr.length;
    }

    // ---- jobberCombos (every distinct county+transit combo in the data) ----
    const comboSeen = new Set();
    const jobberCombos = [];
    for (const set of b.zipCombos.values()) {
      for (const key of set) {
        if (comboSeen.has(key)) continue;
        comboSeen.add(key);
        const { c, t } = comboObj(key);
        const cName = counties[c] ? counties[c].name : c;
        const cRate = counties[c] ? counties[c].rate : 0;
        const tRate = t && transits[t] ? transits[t].rate : 0;
        const tAbbr = t && transits[t] ? transits[t].name : null;
        const total = r5(stateRate + cRate + tRate);
        const label = 'OH-' + cName + (tAbbr ? '-' + tAbbr : '');
        jobberCombos.push({ county: cName, countyFips: c, transit: tAbbr,
          transitFips: t || null, total, label });
      }
    }
    jobberCombos.sort((a, x) =>
      a.county === x.county ? (a.total - x.total) : (a.county < x.county ? -1 : 1));

    // ---- meta ----
    const notes = [];
    if (rates.futureRateChanges > 0)
      notes.push(`${rates.futureRateChanges} future-dated rate row(s) present in the rate file (excluded).`);
    notes.push('Ambiguous ZIP resolution: address override -> ZIP+4 override -> zip5 default (d). Address overrides live in ohio-addr-ranges.json.');

    const meta = {
      version: src.version,
      generatedAt: new Date().toISOString(),
      effectiveDate: TODAY_ISO,
      sources: SOURCES.length ? SOURCES.slice() : [
        FINDER + '/?tab=fileDownloads',
      ],
      counts: {
        counties: Object.keys(counties).length,
        transits: Object.keys(transits).length,
        zip5: Object.keys(zip5).length,
        zip5Unambiguous: Object.keys(zip5).length - b.ambiguous.size,
        zip5Ambiguous: b.ambiguous.size,
        zip4Overrides: Object.values(zip4).reduce((a, x) => a + x.length, 0),
        addrOverrides: addrCount,
      },
      notes,
    };

    // ---- write main + sidecar ----
    const main = { meta, stateRate, counties, transits, zip5, zip4, jobberCombos };
    const mainPath = path.join(DIST, 'ohio-tax-data.json');
    const minPath = path.join(DIST, 'ohio-tax-data.min.json');
    const addrPath = path.join(DIST, 'ohio-addr-ranges.json');

    const addrDoc = {
      meta: { version: src.version, generatedAt: meta.generatedAt,
        note: 'Address-range OVERRIDES for ambiguous ZIPs only. Match street + number in [lo,hi] honoring oe (O/E/B). If no match, use ZIP+4 override, else zip5.d in ohio-tax-data.json.' },
      addr,
    };

    fs.writeFileSync(mainPath, JSON.stringify(main, null, 2));
    fs.writeFileSync(minPath, JSON.stringify(main));
    fs.writeFileSync(addrPath, JSON.stringify(addrDoc));

    // ---- per-ZIP address shards (dist/addr-shards/<zip5>.json) ----
    // One shard per AMBIGUOUS ZIP so the extension fetches only the ZIP it
    // needs. Same override-only semantics as the combined sidecar; note the
    // shard field is `oddEven` (spelled out) vs the sidecar's compact `oe`.
    // Each shard also carries `streets`: the sorted unique directory of ALL
    // street names in the ZIP's raw A-records (default rows included). A
    // street present in `streets` but absent from `addr` overrides is, by
    // construction, the ZIP's DEFAULT jurisdiction; a street absent from
    // `streets` is unknown in this ZIP (typo/nonexistent — resolvers must not
    // trust geocoder fuzzy snaps for it).
    // Ambiguous ZIPs with zero overrides still get a shard (addr: []) so a
    // fetch never 404s.
    const shardDir = path.join(DIST, 'addr-shards');
    fs.rmSync(shardDir, { recursive: true, force: true }); // drop stale shards
    ensureDir(shardDir);
    const shardSizes = [];
    let shardBytesWithoutStreets = 0; // for the size-delta report
    let streetsTotal = 0;
    for (const zip of [...b.ambiguous].sort()) {
      const recs = (addr[zip] || []).map(rec => ({
        street: rec.street, lo: rec.lo, hi: rec.hi,
        oddEven: rec.oe, c: rec.c, t: rec.t,
      }));
      const streets = [...(b.zipStreets.get(zip) || [])].sort();
      streetsTotal += streets.length;
      const shard = { zip, v: meta.version, streets, addr: recs };
      const p = path.join(shardDir, zip + '.json');
      fs.writeFileSync(p, JSON.stringify(shard));
      shardSizes.push(fs.statSync(p).size);
      shardBytesWithoutStreets +=
        Buffer.byteLength(JSON.stringify({ zip, v: meta.version, addr: recs }));
    }
    shardSizes.sort((a, x) => a - x);
    const shardStats = {
      count: shardSizes.length,
      total: shardSizes.reduce((a, x) => a + x, 0),
      totalWithoutStreets: shardBytesWithoutStreets,
      streetsTotal,
      min: shardSizes[0] || 0,
      median: shardSizes.length
        ? shardSizes[Math.floor(shardSizes.length / 2)] : 0,
      max: shardSizes[shardSizes.length - 1] || 0,
    };

    const sizes = {
      main: fs.statSync(mainPath).size,
      min: fs.statSync(minPath).size,
      minGz: zlib.gzipSync(fs.readFileSync(minPath)).length,
      addr: fs.statSync(addrPath).size,
      addrGz: zlib.gzipSync(fs.readFileSync(addrPath)).length,
      shards: shardStats,
    };

    log('== Step 4: outputs written ==');
    log(`  ${mainPath}  ${(sizes.main / 1e6).toFixed(2)} MB`);
    log(`  ${minPath}  ${(sizes.min / 1e6).toFixed(2)} MB (gz ${(sizes.minGz / 1e6).toFixed(2)} MB)`);
    log(`  ${addrPath}  ${(sizes.addr / 1e6).toFixed(2)} MB (gz ${(sizes.addrGz / 1e6).toFixed(2)} MB)`);
    log(`  ${shardDir}\\  ${shardStats.count} shards, ` +
      `${(shardStats.total / 1e6).toFixed(2)} MB total ` +
      `(min ${(shardStats.min / 1e3).toFixed(1)} KB, ` +
      `median ${(shardStats.median / 1e3).toFixed(1)} KB, ` +
      `max ${(shardStats.max / 1e3).toFixed(1)} KB)`);
    log(`    street directories: ${shardStats.streetsTotal} street names across all shards; ` +
      `size delta vs override-only shards: +${((shardStats.total - shardStats.totalWithoutStreets) / 1e6).toFixed(2)} MB ` +
      `(${(shardStats.totalWithoutStreets / 1e6).toFixed(2)} -> ${(shardStats.total / 1e6).toFixed(2)} MB)`);

    // ---- verification ----
    require('./verify.js').run({
      main, addrDoc, rawDir: RAW, distDir: DIST, stateRate,
      countyNames, transitRef, rates, boundary: b, sizes, src,
    });

    return { main, sizes };
  });
}

build().catch((e) => { console.error(e); process.exit(1); });
