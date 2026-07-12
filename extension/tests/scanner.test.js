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
console.log('\n================================');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
