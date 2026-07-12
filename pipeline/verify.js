'use strict';
/*
 * Verification for the Ohio tax-data build.
 * Writes dist/VERIFICATION.md and prints a PASS/FAIL summary.
 */
const fs = require('fs');
const path = require('path');

function pct(x) { return (x * 100).toFixed(2) + '%'; }
function r5(x) { return Math.round(x * 1e5) / 1e5; }

function run(ctx) {
  const { main, rawDir, distDir, stateRate, countyNames, boundary } = ctx;
  const { counties, transits, zip5, jobberCombos } = main;
  const lines = [];
  const summary = { pass: 0, fail: 0 };
  const out = (s = '') => lines.push(s);

  // total rate for a combo {c, t}
  const totalOf = (c, t) =>
    r5(stateRate + (counties[c] ? counties[c].rate : NaN) + (t && transits[t] ? transits[t].rate : 0));

  // county FIPS by name (lower-cased)
  const fipsByName = {};
  for (const [fips, o] of Object.entries(counties)) fipsByName[o.name.toLowerCase()] = fips;

  // countywide transit rate per county FIPS (derived from transit "coverage" desc)
  const countywideTransitFor = {}; // countyFips -> {fips, abbr, rate}
  for (const [tf, o] of Object.entries(transits)) {
    if (!o.countywide) continue;
    const cn = (o.coverage || '').replace(/\s*County\s*$/i, '').trim().toLowerCase();
    const cf = fipsByName[cn];
    if (cf) countywideTransitFor[cf] = { fips: tf, abbr: o.name, rate: o.rate };
  }

  out('# Ohio Sales-Tax Data — VERIFICATION');
  out('');
  out(`Generated: ${main.meta.generatedAt}`);
  out(`Data version: **${main.meta.version}**   Effective date tested: **${main.meta.effectiveDate}**`);
  out('');
  out('All rates below are the combined rate the buyer pays = state 5.75% + county portion + countywide transit (where applicable).');
  out('');

  // -----------------------------------------------------------------------
  // (a) 88-county totals vs CountySalesTaxRateReport.csv
  // -----------------------------------------------------------------------
  out('## (a) County totals vs state CountySalesTaxRateReport.csv');
  out('');
  const report = fs.readFileSync(path.join(rawDir, 'CountySalesTaxRateReport.csv'), 'utf8');
  const repRate = {}; // countyNameLower -> Set(rate)
  const repLines = report.split(/\r?\n/);
  for (let i = 1; i < repLines.length; i++) {
    const row = repLines[i].split(',');
    if (row.length < 4) continue;
    const cName = (row[2] || '').trim().toLowerCase();
    const rate = parseFloat(row[3]);
    if (!cName || isNaN(rate)) continue;
    (repRate[cName] = repRate[cName] || new Set()).add(r5(rate));
  }

  const mismatches = [];
  const countyFipsList = Object.keys(counties).sort((a, b) => counties[a].name < counties[b].name ? -1 : 1);
  let checked = 0;
  const multiRateCounties = [];
  for (const cf of countyFipsList) {
    const name = counties[cf].name;
    const cw = countywideTransitFor[cf];
    const computed = r5(stateRate + counties[cf].rate + (cw ? cw.rate : 0));
    const rset = repRate[name.toLowerCase()];
    if (!rset) { mismatches.push(`${name}: not found in report`); continue; }
    checked++;
    if (rset.size > 1) multiRateCounties.push(`${name}: report lists ${[...rset].map(pct).join(', ')}`);
    // The report's county base rate is the min of any listed (base excludes slivers).
    const reported = [...rset].sort((a, b) => a - b)[0];
    if (computed !== reported)
      mismatches.push(`${name} (FIPS ${cf}): computed ${pct(computed)} vs report ${pct(reported)}${cw ? ` [+${cw.abbr} ${pct(cw.rate)}]` : ''}`);
  }
  out(`Counties checked: **${checked}** of 88.`);
  out(`Mismatches: **${mismatches.length}** (expected 0).`);
  out('');
  if (mismatches.length) { mismatches.forEach(m => out(`- MISMATCH: ${m}`)); out(''); }
  if (multiRateCounties.length) {
    out('Note — counties where the report lists more than one rate (base taken as the lowest):');
    multiRateCounties.forEach(m => out(`- ${m}`));
    out('');
  }
  const aPass = mismatches.length === 0 && checked === 88;
  out(`Result: ${aPass ? 'PASS' : 'FAIL'}`);
  out('');
  aPass ? summary.pass++ : summary.fail++;

  // Table of all 88 county totals
  out('<details><summary>All 88 county combined rates</summary>');
  out('');
  out('| County | State+County | Countywide transit | Combined |');
  out('|---|---|---|---|');
  for (const cf of countyFipsList) {
    const cw = countywideTransitFor[cf];
    const base = r5(stateRate + counties[cf].rate);
    const total = r5(base + (cw ? cw.rate : 0));
    out(`| ${counties[cf].name} | ${pct(base)} | ${cw ? cw.abbr + ' ' + pct(cw.rate) : '—'} | ${pct(total)} |`);
  }
  out('');
  out('</details>');
  out('');

  // -----------------------------------------------------------------------
  // (b) split-district checks
  // -----------------------------------------------------------------------
  out('## (b) Split-district checks');
  out('');
  // county combos present in boundary data
  const countyCombos = {}; // fips -> Set of comboKey
  for (const [c, set] of boundary.countyCombos) countyCombos[c] = set;

  function comboExists(countyFips, transitFips) {
    const set = countyCombos[countyFips];
    if (!set) return false;
    for (const key of set) {
      const [c, t] = key.split('|');
      if (c === countyFips && (t || '') === (transitFips || '')) return true;
    }
    return false;
  }
  function findTransitFipsForCounty(countyFips, abbr) {
    // return the transit fips (matching abbr) that appears in this county's combos
    const set = countyCombos[countyFips];
    if (!set) return null;
    for (const key of set) {
      const [c, t] = key.split('|');
      if (c === countyFips && t && transits[t] && transits[t].name === abbr) return t;
    }
    return null;
  }

  const splitChecks = [
    { county: 'Franklin', base: null, withTransit: { abbr: 'COTA', total: 0.08 }, everywhere: 0.08 },
    { county: 'Delaware', base: 0.07, withTransit: { abbr: 'COTA', total: 0.08 } },
    { county: 'Licking', base: 0.0725, withTransit: { abbr: 'COTA', total: 0.0825 } },
    { county: 'Fairfield', base: 0.0675, withTransit: { abbr: 'COTA', total: 0.0775 } },
    { county: 'Union', base: 0.07, withTransit: { abbr: 'COTA', total: 0.08 } },
  ];
  out('| County | Base (no transit) | With COTA | Result |');
  out('|---|---|---|---|');
  for (const chk of splitChecks) {
    const cf = fipsByName[chk.county.toLowerCase()];
    let ok = true;
    const notes = [];
    // base combo (no transit)
    if (chk.county === 'Franklin') {
      // Franklin must be COTA everywhere -> NO non-COTA combo may exist
      const hasNonCota = comboExists(cf, null);
      const cotaFips = findTransitFipsForCounty(cf, 'COTA');
      const cotaTotal = cotaFips ? totalOf(cf, cotaFips) : NaN;
      ok = !hasNonCota && cotaTotal === 0.08;
      notes.push(`no non-COTA combo: ${!hasNonCota}`, `COTA total ${pct(cotaTotal)}`);
      out(`| Franklin | — (COTA everywhere) | ${pct(cotaTotal)} | ${ok ? 'PASS' : 'FAIL'} |`);
    } else {
      const baseTotal = totalOf(cf, null);
      const cotaFips = findTransitFipsForCounty(cf, 'COTA');
      const cotaTotal = cotaFips ? totalOf(cf, cotaFips) : NaN;
      const baseOk = comboExists(cf, null) && baseTotal === chk.base;
      const cotaOk = cotaFips && comboExists(cf, cotaFips) && cotaTotal === chk.withTransit.total;
      ok = baseOk && cotaOk;
      out(`| ${chk.county} | ${pct(baseTotal)}${baseOk ? '' : ' ✗'} | ${pct(cotaTotal)}${cotaOk ? '' : ' ✗'} | ${ok ? 'PASS' : 'FAIL'} |`);
    }
    ok ? summary.pass++ : summary.fail++;
  }
  out('');

  // -----------------------------------------------------------------------
  // (c) ZIP spot checks
  // -----------------------------------------------------------------------
  out('## (c) ZIP spot checks');
  out('');
  function describeZip(zip) {
    const e = zip5[zip];
    if (!e) return { exists: false, combos: [] };
    if (e.c !== undefined) {
      const cn = counties[e.c] ? counties[e.c].name : e.c;
      const tn = e.t && transits[e.t] ? transits[e.t].name : null;
      return { exists: true, ambiguous: false,
        combos: [{ county: cn, transit: tn, total: totalOf(e.c, e.t) }] };
    }
    const combos = e.ambiguous.map(cand => ({
      county: counties[cand.c] ? counties[cand.c].name : cand.c,
      transit: cand.t && transits[cand.t] ? transits[cand.t].name : null,
      total: totalOf(cand.c, cand.t),
    }));
    return { exists: true, ambiguous: true, combos };
  }
  function hasCombo(d, county, transit, total) {
    return d.combos.some(c => c.county === county &&
      (c.transit || null) === (transit || null) && c.total === total);
  }

  const spot = [];

  // 43082: ambiguous, Delaware-COTA 8.0% AND Delaware-no-transit 7.0%
  {
    const d = describeZip('43082');
    const ok = d.exists && d.ambiguous &&
      hasCombo(d, 'Delaware', 'COTA', 0.08) && hasCombo(d, 'Delaware', null, 0.07);
    spot.push({ zip: '43082', expect: 'ambiguous: Delaware-COTA 8.00% + Delaware 7.00%', d, ok });
  }
  // 43068 Reynoldsburg: Franklin 8.0 vs Licking-COTA 8.25 vs a non-COTA part
  {
    const d = describeZip('43068');
    const franklin = hasCombo(d, 'Franklin', 'COTA', 0.08);
    const lickingCota = hasCombo(d, 'Licking', 'COTA', 0.0825);
    const nonCota = d.combos.some(c => c.transit === null); // any non-COTA part
    const ok = d.exists && d.ambiguous && franklin && lickingCota && nonCota;
    spot.push({ zip: '43068', expect: 'ambiguous: Franklin-COTA 8.00% + Licking-COTA 8.25% + a non-COTA part', d, ok });
  }
  // 43004: ambiguous (Franklin 8.0 vs Licking 7.25 per state report)
  {
    const d = describeZip('43004');
    const ok = d.exists && d.ambiguous;
    spot.push({ zip: '43004', expect: 'ambiguous (multiple combos)', d, ok });
  }
  // 45040 Mason: Warren County 6.75%, unambiguous
  {
    const d = describeZip('45040');
    const ok = d.exists && !d.ambiguous && hasCombo(d, 'Warren', null, 0.0675);
    spot.push({ zip: '45040', expect: 'unambiguous Warren 6.75%', d, ok });
  }
  // 43215 Columbus: unambiguous Franklin 8.0%
  {
    const d = describeZip('43215');
    const ok = d.exists && !d.ambiguous && hasCombo(d, 'Franklin', 'COTA', 0.08);
    spot.push({ zip: '43215', expect: 'unambiguous Franklin 8.00%', d, ok });
  }

  for (const s of spot) {
    out(`### ZIP ${s.zip} — expected: ${s.expect}`);
    out('');
    if (!s.d.exists) { out('- NOT FOUND in zip5 map'); }
    else {
      out(`- ${s.d.ambiguous ? 'AMBIGUOUS' : 'unambiguous'}; resolvable combos:`);
      for (const c of s.d.combos)
        out(`  - ${c.county}${c.transit ? '-' + c.transit : ''} = ${pct(c.total)}`);
    }
    out(`- Result: ${s.ok ? 'PASS' : 'FAIL'}`);
    out('');
    s.ok ? summary.pass++ : summary.fail++;
  }

  // -----------------------------------------------------------------------
  // (d) count stats
  // -----------------------------------------------------------------------
  out('## (d) ZIP count statistics');
  out('');
  out(`- Total ZIP5s: **${main.meta.counts.zip5}**`);
  out(`- Unambiguous (single county+transit): **${main.meta.counts.zip5Unambiguous}**`);
  out(`- Ambiguous (need ZIP+4 / address): **${main.meta.counts.zip5Ambiguous}**`);
  out(`- ZIP+4 override ranges: **${main.meta.counts.zip4Overrides}**`);
  out(`- Address override ranges (sidecar): **${main.meta.counts.addrOverrides}**`);
  out('');

  // -----------------------------------------------------------------------
  // Known-correct anchors
  // -----------------------------------------------------------------------
  out('## Known-correct anchor check');
  out('');
  const anchors = {
    Franklin: 0.08, Cuyahoga: 0.08, Hamilton: 0.078, Lucas: 0.0775, Montgomery: 0.075,
    Warren: 0.0675, Butler: 0.065, Stark: 0.065, Delaware: 0.07, Licking: 0.0725,
    Fairfield: 0.0675, Union: 0.07, Lake: 0.0725, Brown: 0.07, Greene: 0.0675,
    Miami: 0.07, Champaign: 0.0725, Clark: 0.0725, Fayette: 0.0725, Highland: 0.0725,
    Logan: 0.0725, Preble: 0.0725, Shelby: 0.0725,
  };
  out('| County | Anchor | Computed | Result |');
  out('|---|---|---|---|');
  let anchorFail = 0;
  for (const [name, expected] of Object.entries(anchors)) {
    const cf = fipsByName[name.toLowerCase()];
    const cw = cf ? countywideTransitFor[cf] : null;
    const computed = cf ? r5(stateRate + counties[cf].rate + (cw ? cw.rate : 0)) : NaN;
    const ok = computed === expected;
    if (!ok) anchorFail++;
    out(`| ${name} | ${pct(expected)} | ${pct(computed)} | ${ok ? 'PASS' : 'FAIL'} |`);
  }
  out('');
  out(`Anchor result: ${anchorFail === 0 ? 'PASS' : 'FAIL'} (${anchorFail} mismatch)`);
  out('');
  anchorFail === 0 ? summary.pass++ : summary.fail++;

  // -----------------------------------------------------------------------
  // Output size summary
  // -----------------------------------------------------------------------
  out('## Output sizes');
  out('');
  const s = ctx.sizes;
  out(`- ohio-tax-data.json: ${(s.main / 1e6).toFixed(2)} MB`);
  out(`- ohio-tax-data.min.json: ${(s.min / 1e6).toFixed(2)} MB (gzip ${(s.minGz / 1e6).toFixed(2)} MB)`);
  out(`- ohio-addr-ranges.json: ${(s.addr / 1e6).toFixed(2)} MB (gzip ${(s.addrGz / 1e6).toFixed(2)} MB)`);
  if (s.shards) {
    out(`- addr-shards/: ${s.shards.count} per-ZIP shards, ` +
      `${(s.shards.total / 1e6).toFixed(2)} MB total ` +
      `(min ${(s.shards.min / 1e3).toFixed(1)} KB, ` +
      `median ${(s.shards.median / 1e3).toFixed(1)} KB, ` +
      `max ${(s.shards.max / 1e3).toFixed(1)} KB)`);
  }
  out('');

  // -----------------------------------------------------------------------
  // Shard spot check: 43082 shard must contain COTA (t=96000) ranges
  // -----------------------------------------------------------------------
  out('## Shard spot check (addr-shards/43082.json)');
  out('');
  let shardOk = false;
  try {
    const shard = JSON.parse(fs.readFileSync(
      path.join(distDir, 'addr-shards', '43082.json'), 'utf8'));
    const cota = shard.addr.filter(r => r.t === '96000');
    shardOk = shard.zip === '43082' && shard.v === main.meta.version &&
      cota.length > 0 && shard.addr.every(r =>
        'street' in r && 'lo' in r && 'hi' in r && 'oddEven' in r &&
        'c' in r && 't' in r);
    out(`- zip=${shard.zip}, v=${shard.v}, ranges=${shard.addr.length}, ` +
      `COTA (t=96000) ranges=${cota.length}`);
    if (cota.length)
      out(`- first COTA range: ${JSON.stringify(cota[0])}`);
  } catch (e) {
    out(`- ERROR reading shard: ${e.message}`);
  }
  out(`- Result: ${shardOk ? 'PASS' : 'FAIL'}`);
  out('');
  shardOk ? summary.pass++ : summary.fail++;

  out(`## Overall: ${summary.fail === 0 ? 'ALL PASS' : summary.fail + ' CHECK GROUP(S) FAILED'} (${summary.pass} passed, ${summary.fail} failed)`);
  out('');

  fs.writeFileSync(path.join(distDir, 'VERIFICATION.md'), lines.join('\n'));

  // console summary
  console.log('== Verification ==');
  console.log(`  (a) county totals vs report: ${aPass ? 'PASS' : 'FAIL'} (${checked}/88, ${mismatches.length} mismatch)`);
  console.log(`  anchors: ${anchorFail === 0 ? 'PASS' : 'FAIL (' + anchorFail + ')'}`);
  console.log(`  overall: ${summary.pass} passed, ${summary.fail} failed`);
  console.log(`  wrote ${path.join(distDir, 'VERIFICATION.md')}`);
}

module.exports = { run };
