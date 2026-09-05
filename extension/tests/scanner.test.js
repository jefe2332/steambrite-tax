/*
 * tests/scanner.test.js — run with plain `node tests/scanner.test.js`.
 * Tests the DOM-free scanner core (lib/scan-core.js) + normalization
 * (lib/normalize.js): field classification with Rails/React attribute names,
 * group assembly without Frankenstein merging, placeholder-select detection,
 * read-only block parsing, and dedup key normalization.
 * (DOM-dependent behavior is verified manually against tests/fixtures/jobber-mock.html —
 * steps in TESTING.md.)
 */
'use strict';

const path = require('path');
const N = require(path.join(__dirname, '..', 'lib', 'normalize.js'));
const S = require(path.join(__dirname, '..', 'lib', 'scan-core.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ------------------------------------------------------------------ */
section('1. Field classification handles Rails/React attrs (segments, not word boundaries)');
{
  const cf = (attrs) => S.classifyField(attrs);
  check("name='client[billing_address][street1]' -> street1",
    cf({ name: 'client[billing_address][street1]' }) === 'street1');
  check("name='client[billing_address][street2]' -> street2",
    cf({ name: 'client[billing_address][street2]' }) === 'street2');
  check("id='billing_address_state' -> state (not street)",
    cf({ id: 'billing_address_state' }) === 'state');
  check("name='client[billing_address][postal_code]' -> zip",
    cf({ name: 'client[billing_address][postal_code]' }) === 'zip');
  check("name='property[address][zip]' -> zip", cf({ name: 'property[address][zip]' }) === 'zip');
  check("name='property[address][city]' -> city", cf({ name: 'property[address][city]' }) === 'city');
  check("placeholder='City' -> city", cf({ placeholder: 'City' }) === 'city');
  check("aria-label='ZIP code' -> zip", cf({ ariaLabel: 'ZIP code' }) === 'zip');
  check("labelText='Province' -> state", cf({ labelText: 'Province' }) === 'state');
  check("labelText='Property address' -> street1", cf({ labelText: 'Property address' }) === 'street1');
  check("name='quote[tax_rate_id]' -> null (tax fields excluded)",
    cf({ name: 'quote[tax_rate_id]' }) === null, String(cf({ name: 'quote[tax_rate_id]' })));
  check("name='client[email]' -> null", cf({ name: 'client[email]' }) === null);
  check("placeholder='Search clients by address' -> null (search excluded)",
    cf({ placeholder: 'Search clients by address' }) === null);
  check("name='client[billing_address][country]' -> null (country ignored)",
    cf({ name: 'client[billing_address][country]' }) === null);
  check("misleading placeholder + structural name: name wins (name='...[street1]', placeholder='City')",
    cf({ name: 'client[billing_address][street1]', placeholder: 'City' }) === 'street1');
}

/* ------------------------------------------------------------------ */
section('2. Group prefix extraction separates billing vs property field sets');
{
  const p = S.extractGroupPrefix;
  check("'client[billing_address][street1]' -> 'client[billing_address]'",
    p('client[billing_address][street1]') === 'client[billing_address]', p('client[billing_address][street1]'));
  check("'property[address][street1]' -> 'property[address]'",
    p('property[address][street1]') === 'property[address]', p('property[address][street1]'));
  check("underscore ids: billing_address_city and billing_address_state share a prefix",
    p('billing_address_city') === p('billing_address_state') && p('billing_address_city') !== '');
  check("underscore ids: billing_* prefix differs from property_* prefix",
    p('billing_address_city') !== p('property_address_city'),
    p('billing_address_city') + ' vs ' + p('property_address_city'));
  check("bare 'city' -> no prefix (falls back to sequential grouping)", p('city') === '', JSON.stringify(p('city')));
}

/* ------------------------------------------------------------------ */
section('3. Grouping: billing + property in ONE form never merge (fix #1)');
{
  // Jobber-style: one <form>, two address blocks, distinct Rails prefixes
  const fields = [
    { type: 'street1', prefix: 'client[billing_address]' },
    { type: 'city', prefix: 'client[billing_address]' },
    { type: 'state', prefix: 'client[billing_address]' },
    { type: 'zip', prefix: 'client[billing_address]' },
    { type: 'street1', prefix: 'property[address]' },
    { type: 'city', prefix: 'property[address]' },
    { type: 'state', prefix: 'property[address]' },
    { type: 'zip', prefix: 'property[address]' }
  ];
  const groups = S.groupFields(fields);
  check('two groups of 4 (prefix-keyed)', groups.length === 2 && groups[0].length === 4 && groups[1].length === 4,
    JSON.stringify(groups));

  // No usable prefixes: sequential grouping, repeat type starts a NEW group
  const anon = ['street1', 'city', 'state', 'zip', 'street1', 'city', 'state', 'zip']
    .map(t => ({ type: t, prefix: '' }));
  const groups2 = S.groupFields(anon);
  check('prefixless duplicate types split into 2 groups (no overwrite)',
    groups2.length === 2 && groups2[0].length === 4 && groups2[1].length === 4, JSON.stringify(groups2));

  // Later same-type field must NOT overwrite the earlier group's value
  const overlap = [
    { type: 'street1', prefix: '' }, { type: 'city', prefix: '' },
    { type: 'city', prefix: '' }, // second city — a new block started
    { type: 'state', prefix: '' }, { type: 'zip', prefix: '' }
  ];
  const groups3 = S.groupFields(overlap);
  check('duplicate city starts group 2; group 1 keeps its own city',
    groups3.length === 2 && groups3[0].includes(1) && !groups3[0].includes(2) && groups3[1].includes(2),
    JSON.stringify(groups3));
}

/* ------------------------------------------------------------------ */
section('4. Placeholder select options are never treated as values (fix #3)');
{
  const ph = S.isPlaceholderOption;
  check("('', 'Select state') -> placeholder", ph('', 'Select state') === true);
  check("('--', '--') -> placeholder", ph('--', '--') === true);
  check("('', 'Please choose') -> placeholder", ph('', 'Please choose') === true);
  check("('', 'Choose a state…') -> placeholder", ph('', 'Choose a state…') === true);
  check("('select', 'Select…') -> placeholder", ph('select', 'Select…') === true);
  check("('OH', 'Ohio') -> real value", ph('OH', 'Ohio') === false);
  check("('', 'Ohio') (empty value, real text) -> real value", ph('', 'Ohio') === false);
}

/* ------------------------------------------------------------------ */
section('5. Read-only block parsing: house-number lines only, real states only (fix #4)');
{
  const pb = S.parseAddressBlock;
  const r1 = pb(['Jane Doe', '123 Main Street', 'Mason, Ohio 45040']);
  check('client name line is NOT prepended to street', r1 && r1.street === '123 Main Street',
    r1 && r1.street);
  check('full state name mapped: Ohio -> OH', r1 && r1.state === 'OH', r1 && r1.state);
  check('city/zip extracted', r1 && r1.city === 'Mason' && r1.zip === '45040', JSON.stringify(r1));

  const r2 = pb(['456 Oak Ave Apt 2', 'Westerville, OH 43082-0001']);
  check('ZIP+4 preserved', r2 && r2.zip === '43082-0001', r2 && r2.zip);

  check('block with NO house-number line rejected',
    pb(['Steambrite LLC', 'Attn: Bob', 'Mason, OH 45040']) === null);
  check("junk 'state' rejected ('Mason, Xy 45040')", pb(['1 A St', 'Mason, Xy 45040']) === null);
  check('2-letter state accepted', pb(['77 Elm Dr', 'Dayton, OH 45402']) !== null);
  check('too-long / non-address block rejected', pb(['hello']) === null);
  const r3 = pb(['Property manager: call first', '55 Curie Cir', 'Springboro, OH 45066']);
  check('note line skipped, address line kept', r3 && r3.street === '55 Curie Cir', r3 && r3.street);
}

/* ------------------------------------------------------------------ */
section('6. Dedup key normalization (fix #6)');
{
  const k1 = N.addressKey('123 Main St', 'Mason', 'OH', '45040');
  const k2 = N.addressKey('123 Main Street', 'mason', 'Ohio', '45040');
  check('OH == Ohio, St == Street, case-insensitive city -> same key', k1 === k2, k1 + ' vs ' + k2);
  const k3 = N.addressKey('123 Main St', 'Mason', 'OH', '45040-1234');
  check('ZIP+4 yields a DIFFERENT key than bare ZIP5 (more specific lookup)', k1 !== k3);
  const k4 = N.addressKey('124 Main St', 'Mason', 'OH', '45040');
  check('different house number -> different key', k1 !== k4);
  check("street parse: '15 Abbeycross Lane' -> 15 / ABBEYCROSS LN",
    JSON.stringify(N.parseStreet('15 Abbeycross Lane')) === JSON.stringify({ number: 15, name: 'ABBEYCROSS LN' }),
    JSON.stringify(N.parseStreet('15 Abbeycross Lane')));
  check("unit stripped: '456 Oak Avenue Apt 2' -> OAK AVE",
    N.parseStreet('456 Oak Avenue Apt 2').name === 'OAK AVE', N.parseStreet('456 Oak Avenue Apt 2').name);
  check("'PO Box 5' -> null (no house number)", N.parseStreet('PO Box 5') === null);
  check("state select text 'OH - Ohio' -> OH", N.normalizeState('OH - Ohio') === 'OH');
}

/* ------------------------------------------------------------------ */
section('7. REGRESSION (real Jobber edit-property modal): React generatedName fields');
{
  // EXACT attributes observed live on secure.getjobber.com (2026-07-11):
  // every input has a useless unique generated name/id; the ONLY signal is
  // <label for="_r_X_">…</label>. State is an INPUT (value "Ohio"), not a select.
  const modalInputs = [
    { attrs: { id: '_r_4b_', name: 'generatedName--_r_4b_', labelText: 'Property name' }, value: 'Main house' },
    { attrs: { id: '_r_5f_', name: 'generatedName--_r_5f_', labelText: 'Street 1' }, value: '4330 Marival Way' },
    { attrs: { id: '_r_4f_', name: 'generatedName--_r_4f_', labelText: 'Street 2' }, value: '' },
    { attrs: { id: '_r_4h_', name: 'generatedName--_r_4h_', labelText: 'City' }, value: 'Mason' },
    { attrs: { id: '_r_4j_', name: 'generatedName--_r_4j_', labelText: 'State' }, value: 'Ohio' },
    { attrs: { id: '_r_4l_', name: 'generatedName--_r_4l_', labelText: 'ZIP code' }, value: '45040' },
    { attrs: { id: '_r_4n_', name: 'generatedName--_r_4n_', labelText: 'Country' }, value: 'United States' },
    { attrs: { id: '_r_4p_', name: 'generatedName--_r_4p_', labelText: 'Search tax rate' }, value: '' }
  ];

  check("label-only signal: 'Street 1' via <label for> -> street1",
    S.classifyField(modalInputs[1].attrs) === 'street1', S.classifyField(modalInputs[1].attrs));
  check("label 'ZIP code' -> zip", S.classifyField(modalInputs[5].attrs) === 'zip');
  check("label 'State' (INPUT, not select) -> state", S.classifyField(modalInputs[4].attrs) === 'state');
  check("'Property name' -> null (not an address field)", S.classifyField(modalInputs[0].attrs) === null);
  check("'Country' -> null", S.classifyField(modalInputs[6].attrs) === null);
  check("'Search tax rate' -> null (search+tax excluded)", S.classifyField(modalInputs[7].attrs) === null);

  check("extractGroupPrefix('generatedName--_r_5f_') -> '' (no grouping info)",
    S.extractGroupPrefix('generatedName--_r_5f_') === '', JSON.stringify(S.extractGroupPrefix('generatedName--_r_5f_')));

  // Mimic content.js: classify, drop unclassified + empty values, take
  // prefix from name (falling back to id), then group.
  const fields = modalInputs
    .map(f => ({
      type: S.classifyField(f.attrs),
      value: f.value,
      prefix: S.extractGroupPrefix(f.attrs.name) || S.extractGroupPrefix(f.attrs.id)
    }))
    .filter(f => f.type && f.value);
  check('4 classified+valued fields survive (street1/city/state/zip)',
    fields.length === 4 && fields.map(f => f.type).join(',') === 'street1,city,state,zip',
    JSON.stringify(fields.map(f => f.type)));

  const groups = S.groupFields(fields);
  check('EXACTLY ONE group assembles (unique id-prefixes demoted, sequential no-overwrite)',
    groups.length === 1 && groups[0].length === 4, JSON.stringify(groups));

  const parts = {};
  groups[0].forEach(i => { if (!(fields[i].type in parts)) parts[fields[i].type] = fields[i].value; });
  check('assembled address = 4330 Marival Way / Mason / OH / 45040',
    parts.street1 === '4330 Marival Way' && parts.city === 'Mason' &&
    N.normalizeState(parts.state) === 'OH' && parts.zip === '45040',
    JSON.stringify(parts));

  // demotion must NOT break real multi-field prefixes: billing(4) + property(4)
  // sets with shared prefixes still form two groups even when a stray unique
  // prefix sits between them
  const mixed = [
    { type: 'street1', prefix: 'client[billing_address]' },
    { type: 'city', prefix: 'client[billing_address]' },
    { type: 'state', prefix: 'client[billing_address]' },
    { type: 'zip', prefix: 'client[billing_address]' },
    { type: 'street1', prefix: 'r_9z' }, // unique -> demoted to sequential
    { type: 'city', prefix: 'r_a1' },
    { type: 'state', prefix: 'r_a3' },
    { type: 'zip', prefix: 'r_a5' }
  ];
  const g2 = S.groupFields(mixed);
  check('shared prefixes kept, unique prefixes merged sequentially -> 2 groups of 4',
    g2.length === 2 && g2[0].length === 4 && g2[1].length === 4, JSON.stringify(g2));
}

/* ------------------------------------------------------------------ */
section('8. REGRESSION (real Jobber client screen): single-line address in <a><h5>');
{
  const pb = S.parseAddressBlock;
  // EXACT text observed live: <a href="/clients/…/properties/…"><h5>4330 Marival Way, Mason, Ohio 45040</h5></a>
  const r = pb(['4330 Marival Way, Mason, Ohio 45040']);
  check('single-line block parses', r !== null, JSON.stringify(r));
  check("street '4330 Marival Way'", r && r.street === '4330 Marival Way', r && r.street);
  check("city 'Mason'", r && r.city === 'Mason', r && r.city);
  check("full state name 'Ohio' -> OH", r && r.state === 'OH', r && r.state);
  check("zip '45040'", r && r.zip === '45040', r && r.zip);

  const r2 = pb(['1 Elm St, Suite 200, Dayton, OH 45402']);
  check('street may contain commas (Suite segment kept in street)',
    r2 && r2.street === '1 Elm St, Suite 200' && r2.city === 'Dayton', JSON.stringify(r2));
  const r3 = pb(['77 Oak Dr, Westerville, Ohio 43082-0001']);
  check('single line with ZIP+4 works', r3 !== null && r3.zip === '43082-0001', JSON.stringify(r3));
  check("no street segment -> rejected ('Mason, Ohio 45040')", pb(['Mason, Ohio 45040']) === null);
  check("street without house number -> rejected ('Call me maybe, Mason, Ohio 45040')",
    pb(['Call me maybe, Mason, Ohio 45040']) === null);
  check('heading + single-line address row (multi-line fallback) parses',
    (pb(['Property address', '4330 Marival Way, Mason, Ohio 45040']) || {}).street === '4330 Marival Way');
  check('multi-line classic format still works after change',
    (pb(['Jane Doe', '123 Main Street', 'Mason, Ohio 45040']) || {}).street === '123 Main Street');
}

/* ------------------------------------------------------------------ */
section('9. Decoy-dialog safety (documentation check)');
{
  // Real Jobber keeps a hidden decoy [role=dialog] ("pointer-events-none
  // absolute top-0 opacity-0") as the FIRST dialog in the DOM. No code path
  // may use a global first-match dialog query. content.js only uses
  // closest('[role="dialog"]') upward from a concrete field (ancestor-based,
  // decoy-immune) and isVisible() uses checkVisibility({checkOpacity:true}).
  const fs2 = require('fs');
  const contentSrc = fs2.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  check("content.js never queries [role=dialog] globally (querySelector('[role=\"dialog\"]'))",
    !/querySelector(All)?\(\s*['"`][^'"`]*\[role=["']?dialog/.test(contentSrc));
  check("content.js scopes dialogs via closest() only",
    /closest\('form, fieldset, \[role="dialog"\]/.test(contentSrc));
  check('isVisible uses checkVisibility with checkOpacity (catches opacity-0 decoy)',
    /checkVisibility\(\{ checkOpacity: true/.test(contentSrc));
}

/* ------------------------------------------------------------------ */
section('10. Self-heal + idempotency wiring (source checks, v2.0.3)');
{
  // The teardown/dead-flag mechanics are DOM+chrome bound, so what plain node
  // CAN verify is the load-bearing source structure; the behavior itself is
  // covered by the manual matrix in TESTING.md.
  const fs3 = require('fs');
  const contentSrc = fs3.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const popupSrc = fs3.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const manifest = JSON.parse(fs3.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

  // -- content.js teardown handshake --
  const dispatchIdx = contentSrc.indexOf('document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT))');
  const bindIdx = contentSrc.indexOf('document.addEventListener(TEARDOWN_EVENT, onTeardown)');
  check('content.js dispatches taxext-teardown BEFORE binding its own teardown listener',
    dispatchIdx !== -1 && bindIdx !== -1 && dispatchIdx < bindIdx,
    'dispatch@' + dispatchIdx + ' bind@' + bindIdx);
  const deadDeclIdx = contentSrc.indexOf('let dead = false');
  check('dead flag declared before any binding', deadDeclIdx !== -1 && deadDeclIdx < bindIdx, 'decl@' + deadDeclIdx);
  check('teardown sets dead, disconnects observer, clears debounce, removes message listener',
    /function onTeardown\(\)[\s\S]*?dead = true;[\s\S]*?observer\.disconnect\(\)[\s\S]*?clearTimeout\(debounceTimer\)[\s\S]*?removeListener\(onRuntimeMessage\)/.test(contentSrc));
  check('message listener is a NAMED function (removable)',
    /chrome\.runtime\.onMessage\.addListener\(onRuntimeMessage\)/.test(contentSrc));
  // dead-flag guards at every async entry point
  check('onRuntimeMessage checks dead', /function onRuntimeMessage[\s\S]{0,200}if \(dead\) return false;/.test(contentSrc));
  check('observer callback checks dead', /if \(dead \|\| suppressObserver\) return;/.test(contentSrc));
  check('runAutoScan / scheduleScan / boot check dead',
    /function runAutoScan\(\) \{\s*if \(dead\) return;/.test(contentSrc) &&
    /function scheduleScan\(\) \{\s*if \(dead\) return;/.test(contentSrc) &&
    /function boot\(\) \{\s*if \(dead\) return;/.test(contentSrc));
  check('resolve callback checks dead (late responses ignored after takeover)',
    /if \(dead\) return; \/\/ a newer copy took over/.test(contentSrc));
  check('missing lib globals -> console.warn (log, not throw) + disable',
    /if \(!N \|\| !S\) \{[\s\S]*?console\.warn/.test(contentSrc));

  // -- popup.js self-heal flow --
  check("popup injects CSS via chrome.scripting.insertCSS(files:['content.css'])",
    /chrome\.scripting\.insertCSS\(\{ target: \{ tabId: tab\.id \}, files: \['content\.css'\] \}/.test(popupSrc));
  const filesMatch = popupSrc.match(/chrome\.scripting\.executeScript\(\s*\{ target: \{ tabId: tab\.id \}, files: (\[[^\]]*\])/);
  check('popup injects scripts in the SAME order as the manifest',
    filesMatch !== null &&
    JSON.stringify(JSON.parse(filesMatch[1].replace(/'/g, '"'))) === JSON.stringify(manifest.content_scripts[0].js),
    filesMatch && filesMatch[1]);
  check('retry happens once after ~150ms', /setTimeout\(\(\) => \{\s*chrome\.tabs\.sendMessage\(tab\.id, \{ action: 'SCAN_ADDRESSES' \}/.test(popupSrc) && /\}, 150\);/.test(popupSrc));
  check('lastError detected by truthiness, not string matching',
    !/lastError\.message\.(includes|indexOf|match)/.test(popupSrc));
  check("final fallback keeps the 'Refresh the Jobber tab' guidance",
    /Refresh the Jobber tab and try again\./.test(popupSrc));

  // -- manifest --
  check("manifest has 'scripting' permission", manifest.permissions.includes('scripting'),
    JSON.stringify(manifest.permissions));
  check('manifest version is 2.0.4', manifest.version === '2.0.4', manifest.version);
  check('manifest content_scripts order is normalize, scan-core, content',
    JSON.stringify(manifest.content_scripts[0].js) === JSON.stringify(['lib/normalize.js', 'lib/scan-core.js', 'content.js']),
    JSON.stringify(manifest.content_scripts[0].js));
}

/* ------------------------------------------------------------------ */
section('11. Skipped list pages (v2.0.4)');
{
  const sk = S.isSkippedPath;
  const D = S.DEFAULT_SKIP_PATHS;

  check('defaults are the five Jobber list views',
    JSON.stringify(D) === JSON.stringify(['/clients', '/requests', '/quotes', '/jobs', '/invoices']),
    JSON.stringify(D));

  // exact matches -> skipped
  check('/clients is skipped', sk('/clients', D) === true);
  check('/requests is skipped', sk('/requests', D) === true);
  check('/quotes is skipped', sk('/quotes', D) === true);
  check('/jobs is skipped', sk('/jobs', D) === true);
  check('/invoices is skipped', sk('/invoices', D) === true);

  // trailing slash
  check('/clients/ (trailing slash) is skipped', sk('/clients/', D) === true);
  check("skip entry written as '/clients/' still matches /clients",
    sk('/clients', ['/clients/']) === true);
  check("skip entry written without a leading slash still matches",
    sk('/clients', ['clients']) === true);

  // query strings are not part of location.pathname, but be defensive
  check('query string is ignored if one is passed in',
    sk('/clients?nav_label=Clients&nav_source=sidebar', D) === true);
  check('hash is ignored if one is passed in', sk('/quotes#top', D) === true);

  // detail pages and forms are NEVER skipped
  check('/clients/151344135 is NOT skipped', sk('/clients/151344135', D) === false);
  check('/clients/new is NOT skipped', sk('/clients/new', D) === false);
  check('/jobs/150363992 is NOT skipped', sk('/jobs/150363992', D) === false);
  check('/quotes/12345 is NOT skipped', sk('/quotes/12345', D) === false);
  check('/requests/12345 is NOT skipped', sk('/requests/12345', D) === false);
  check('/clients/151344135/properties/9 is NOT skipped',
    sk('/clients/151344135/properties/9', D) === false);
  check('prefix-only lookalikes are NOT skipped (/clients_archive)',
    sk('/clients_archive', D) === false);
  check('/ (root) is NOT skipped', sk('/', D) === false);
  check('/schedule is NOT skipped', sk('/schedule', D) === false);

  // case handling
  check('/Clients is skipped (pathname case-insensitive)', sk('/Clients', D) === true);
  check('mixed-case skip entry matches lowercase pathname',
    sk('/clients', ['/CLIENTS']) === true);

  // custom lists
  check('custom list skips only what it names',
    sk('/schedule', ['/schedule']) === true && sk('/clients', ['/schedule']) === false);
  check('empty list skips nothing', sk('/clients', []) === false);
  check('missing list falls back to defaults', sk('/clients', undefined) === true);
  check('non-array list falls back to defaults', sk('/clients', '/clients') === true);
  check('empty/garbage entries are ignored', sk('/clients', ['', '   ', '/clients']) === true);
  check('empty pathname is never skipped', sk('', D) === false && sk(null, D) === false);
}

/* ------------------------------------------------------------------ */
section('12. Skip wiring in content.js / popup.js / options.js (source checks)');
{
  const fs4 = require('fs');
  const contentSrc = fs4.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const popupSrc = fs4.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const optionsSrc = fs4.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  const optionsHtml = fs4.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');

  // -- content.js --
  check('isSkippedPage reads location.pathname per call (SPA-safe, not cached at boot)',
    /function isSkippedPage\(\)[\s\S]{0,300}S\.isSkippedPath\(location\.pathname, skipPaths\)/.test(contentSrc));
  check('scan() bails out on a skipped page',
    /function scan\(\) \{\s*if \(isSkippedPage\(\)\) \{ goQuiet\(\); return \[\]; \}/.test(contentSrc));
  check('runAutoScan (auto + observer + popstate path) bails out on a skipped page',
    /function runAutoScan\(\) \{\s*if \(dead\) return;\s*if \(isSkippedPage\(\)\) \{ goQuiet\(\); return; \}/.test(contentSrc));
  check('goQuiet cleans up leftover badges from the previous page',
    /function goQuiet\(\)[\s\S]{0,300}cleanupPreviousScan\(\)[\s\S]{0,120}lastScanAddresses = \[\]/.test(contentSrc));
  check("SCAN_ADDRESSES answers { ok: true, addresses: [], skipped: 'list-page' }",
    /sendResponse\(\{ ok: true, addresses: \[\], skipped: 'list-page' \}\)/.test(contentSrc));
  check('injectAllBadges refuses to inject on a skipped page',
    /function injectAllBadges\(\) \{\s*if \(isSkippedPage\(\)\) return;/.test(contentSrc));
  check('skipPaths defaults to the shared scan-core list',
    /let skipPaths = S\.DEFAULT_SKIP_PATHS\.slice\(\)/.test(contentSrc));
  check('skipPaths loaded from chrome.storage.sync at boot',
    /chrome\.storage\.sync\.get\('skipPaths'/.test(contentSrc) &&
    /function boot\(\)[\s\S]{0,160}loadSkipPaths\(\)/.test(contentSrc));
  check('storage.onChanged keeps skipPaths live (named listener, removed on teardown)',
    /chrome\.storage\.onChanged\.addListener\(onStorageChanged\)/.test(contentSrc) &&
    /chrome\.storage\.onChanged\.removeListener\(onStorageChanged\)/.test(contentSrc));
  check('popstate schedules a rescan (list -> detail -> list) and unbinds on teardown',
    /window\.addEventListener\('popstate', onPopState\)/.test(contentSrc) &&
    /window\.removeEventListener\('popstate', onPopState\)/.test(contentSrc));
  check('MutationObserver path re-evaluates the URL (goes through runAutoScan)',
    /debounceTimer = setTimeout\(runAutoScan, 800\)/.test(contentSrc));

  // -- popup.js --
  check('popup shows the list-page info message',
    /skipped === 'list-page'/.test(popupSrc) &&
    /Suggestions are hidden on list pages\. Open a client, request, quote, or job to see them\./.test(popupSrc));

  // -- options.js / options.html --
  const optDefaults = (optionsSrc.match(/const DEFAULT_SKIP_PATHS = (\[[^\]]*\]);/) || [])[1];
  check('options.js DEFAULT_SKIP_PATHS matches lib/scan-core.js',
    optDefaults !== undefined &&
    JSON.stringify(JSON.parse(optDefaults.replace(/'/g, '"'))) === JSON.stringify(S.DEFAULT_SKIP_PATHS),
    optDefaults);
  check('options page has the skip-list textarea and both buttons',
    /<textarea id="skipPaths"/.test(optionsHtml) &&
    /id="saveSkipPathsBtn"/.test(optionsHtml) &&
    /id="resetSkipPathsBtn"/.test(optionsHtml));
  check('options page label reads "Pages to skip (one path per line)"',
    /Pages to skip \(one path per line\)/.test(optionsHtml));
  check('options.js saves skipPaths to chrome.storage.sync',
    /chrome\.storage\.sync\.set\(\{ skipPaths: /.test(optionsSrc));
  check('options.js has a reset-to-defaults handler',
    /resetSkipPathsBtn\.addEventListener\('click'/.test(optionsSrc));
  check('no innerHTML with dynamic strings added to options.js/popup.js/content.js',
    !/innerHTML\s*=/.test(optionsSrc) && !/innerHTML\s*=/.test(popupSrc) && !/innerHTML\s*=/.test(contentSrc));
}

/* ------------------------------------------------------------------ */
console.log('\n================================');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
