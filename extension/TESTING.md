# TESTING — results and procedures

Both suites run with **plain `node`** (no npm dependencies). The resolver suite
runs against the REAL bundled data file (`data/ohio-tax-data.json`, version
2026Q1) with network/caches stubbed. Last executed 2026-07-11 on Node v24 /
Windows, after the live-Jobber scanner fixes (see section 3).

```
node tests/resolver.test.js    -> 63 passed, 0 failed   (2026-07-11, post-Sunbury fix)
node tests/scanner.test.js     -> 71 passed, 0 failed
```

> 2026-07-11 update (v2.0.2): resolver suite grew from 47 to 63 with section 11
> — the live "6000 S Sunbury Rd, Westerville 43082" regression (see section 7
> below). Sections 1–10 output is unchanged from the run recorded here.

## 1. tests/resolver.test.js — ACTUAL OUTPUT (47/47 pass)

```
resolver.test.js — data version 2026Q1, stateRate 0.0575

== 1. 43215 (Columbus) -> Franklin + COTA 8.00% exact via zip5 ==
  PASS  status resolved
  PASS  confidence exact
  PASS  method zip5
  PASS  county Franklin
  PASS  transit COTA
  PASS  total 8.00%
  PASS  label OH-Franklin (business mapping overrides data label)
  PASS  label is mapped (no "add this group" note)
  PASS  breakdown Ohio 5.75 + Franklin County 1.25 + COTA 1.00

== 2. 45040 (Mason) -> Warren 6.75% exact, label OH-Warren ==
  PASS  status resolved
  PASS  confidence exact
  PASS  county Warren
  PASS  no transit
  PASS  total 6.75%
  PASS  label OH-Warren
  PASS  breakdown Ohio 5.75 + Warren County 1.00

== 3. 43082 (Westerville) ambiguous, no +4/shard/census -> default d, verify ==
  PASS  status resolved
  PASS  confidence verify
  PASS  method zip-default
  PASS  uses default combo d ({"c":"041","t":null})
  PASS  default is Delaware no-transit 7.00%
  PASS  candidates listed (3 combos)
  PASS  finder link included

== 4. 43082 with ZIP+4 inside an override range -> that combo, exact ==
  PASS  status resolved
  PASS  confidence exact
  PASS  method zip4
  PASS  combo matches override range {c:041, t:96000}
  PASS  total matches combo rate math (8.00%)

== 5. 43068 (Reynoldsburg) candidate set includes Franklin+COTA 8.00% and Licking+COTA 8.25% ==
  PASS  status resolved + verify
  PASS  includes Franklin+COTA@8.00
  PASS  includes Licking+COTA@8.25

== 6. Rate math matches jobberCombos totals for EVERY combo (93 combos) ==
  PASS  all 93 combo totals match stateRate+county+transit

== 7. Address shard matching (43082, synthetic shard in documented shape) ==
  PASS  odd 15 Abbeycross Lane -> exact via addr shard
  PASS    -> Delaware + COTA 8.00%
  PASS  even 16 (odd-only range) does NOT match shard
  PASS    -> degrades to zip-default verify
  PASS  legacy 'oe' key + pre-abbreviated suffix also matches

== 8. Census disambiguation (stubbed Census response) ==
  PASS  census filters 43082 candidates to Franklin+COTA (single) -> high
  PASS    -> 8.00% OH-Franklin
  PASS  census county with transit split -> verify, ZIP default picked
  PASS    candidate list = the 2 Delaware combos

== 9. Backend fallback + non-Ohio handling ==
  PASS  non-Ohio -> backend estimate
  PASS    totalPct 6.00
  PASS    note marks it non-Ohio/legacy
  PASS  non-Ohio + backend down -> failed gracefully with cause

== 10. Lookup cache + label overrides ==
  PASS  user label override wins (storage.sync)
  PASS  normalized-key cache hit (St/Street, OH/Ohio)

================================
TOTAL: 47 passed, 0 failed
```

Notes on the required assertions:
- **43215 → Franklin+COTA 8.00% exact** — pass (data: `{"c":"049","t":"25000"}`).
- **45040 → Warren 6.75% exact, "OH-Warren"** — pass (data: `{"c":"165","t":null}`).
- **43082 ambiguous → default `d` + verify** when no +4/shard/census — pass
  (default = Delaware no-transit 7.00%; candidates: Delaware 7.00 /
  Delaware+COTA 8.00 / Franklin+COTA 8.00).
- **43082 with +4 in a zip4 range → that combo** — pass; the test reads the
  first REAL range from the data (`lo:1 hi:6 → c:041 t:96000`, i.e.
  Delaware+COTA 8.00%) and asserts the resolver returns exactly it.
- **43068 candidates include Franklin+COTA 8.00% and Licking+COTA 8.25%** — pass.
- **Total-rate math matches `jobberCombos` totals for every combo** — pass,
  all 93 combos, tolerance 1e-9 plus display-string equality (this also covers
  the data's float artifacts, e.g. Licking `0.07250000000000001` → "7.25").

## 2. tests/scanner.test.js — ACTUAL OUTPUT (71/71 pass)

Sections 1–6 = original coverage (Rails-attr classification, prefix grouping,
Frankenstein-merge prevention, placeholder selects, multi-line block parsing,
dedup keys). Sections 7–9 = **live-DOM regressions** added after real-site
testing (exact attributes captured from secure.getjobber.com on 2026-07-11).

```
== 1. Field classification handles Rails/React attrs (segments, not word boundaries) ==
  PASS  name='client[billing_address][street1]' -> street1
  PASS  name='client[billing_address][street2]' -> street2
  PASS  id='billing_address_state' -> state (not street)
  PASS  name='client[billing_address][postal_code]' -> zip
  PASS  name='property[address][zip]' -> zip
  PASS  name='property[address][city]' -> city
  PASS  placeholder='City' -> city
  PASS  aria-label='ZIP code' -> zip
  PASS  labelText='Province' -> state
  PASS  labelText='Property address' -> street1
  PASS  name='quote[tax_rate_id]' -> null (tax fields excluded)
  PASS  name='client[email]' -> null
  PASS  placeholder='Search clients by address' -> null (search excluded)
  PASS  name='client[billing_address][country]' -> null (country ignored)
  PASS  misleading placeholder + structural name: name wins (name='...[street1]', placeholder='City')

== 2. Group prefix extraction separates billing vs property field sets ==
  PASS  'client[billing_address][street1]' -> 'client[billing_address]'
  PASS  'property[address][street1]' -> 'property[address]'
  PASS  underscore ids: billing_address_city and billing_address_state share a prefix
  PASS  underscore ids: billing_* prefix differs from property_* prefix
  PASS  bare 'city' -> no prefix (falls back to sequential grouping)

== 3. Grouping: billing + property in ONE form never merge (fix #1) ==
  PASS  two groups of 4 (prefix-keyed)
  PASS  prefixless duplicate types split into 2 groups (no overwrite)
  PASS  duplicate city starts group 2; group 1 keeps its own city

== 4. Placeholder select options are never treated as values (fix #3) ==
  PASS  ('', 'Select state') -> placeholder
  PASS  ('--', '--') -> placeholder
  PASS  ('', 'Please choose') -> placeholder
  PASS  ('', 'Choose a state…') -> placeholder
  PASS  ('select', 'Select…') -> placeholder
  PASS  ('OH', 'Ohio') -> real value
  PASS  ('', 'Ohio') (empty value, real text) -> real value

== 5. Read-only block parsing: house-number lines only, real states only (fix #4) ==
  PASS  client name line is NOT prepended to street
  PASS  full state name mapped: Ohio -> OH
  PASS  city/zip extracted
  PASS  ZIP+4 preserved
  PASS  block with NO house-number line rejected
  PASS  junk 'state' rejected ('Mason, Xy 45040')
  PASS  2-letter state accepted
  PASS  too-long / non-address block rejected
  PASS  note line skipped, address line kept

== 6. Dedup key normalization (fix #6) ==
  PASS  OH == Ohio, St == Street, case-insensitive city -> same key
  PASS  ZIP+4 yields a DIFFERENT key than bare ZIP5 (more specific lookup)
  PASS  different house number -> different key
  PASS  street parse: '15 Abbeycross Lane' -> 15 / ABBEYCROSS LN
  PASS  unit stripped: '456 Oak Avenue Apt 2' -> OAK AVE
  PASS  'PO Box 5' -> null (no house number)
  PASS  state select text 'OH - Ohio' -> OH

== 7. REGRESSION (real Jobber edit-property modal): React generatedName fields ==
  PASS  label-only signal: 'Street 1' via <label for> -> street1
  PASS  label 'ZIP code' -> zip
  PASS  label 'State' (INPUT, not select) -> state
  PASS  'Property name' -> null (not an address field)
  PASS  'Country' -> null
  PASS  'Search tax rate' -> null (search+tax excluded)
  PASS  extractGroupPrefix('generatedName--_r_5f_') -> '' (no grouping info)
  PASS  4 classified+valued fields survive (street1/city/state/zip)
  PASS  EXACTLY ONE group assembles (unique id-prefixes demoted, sequential no-overwrite)
  PASS  assembled address = 4330 Marival Way / Mason / OH / 45040
  PASS  shared prefixes kept, unique prefixes merged sequentially -> 2 groups of 4

== 8. REGRESSION (real Jobber client screen): single-line address in <a><h5> ==
  PASS  single-line block parses
  PASS  street '4330 Marival Way'
  PASS  city 'Mason'
  PASS  full state name 'Ohio' -> OH
  PASS  zip '45040'
  PASS  street may contain commas (Suite segment kept in street)
  PASS  single line with ZIP+4 works
  PASS  no street segment -> rejected ('Mason, Ohio 45040')
  PASS  street without house number -> rejected ('Call me maybe, Mason, Ohio 45040')
  PASS  heading + single-line address row (multi-line fallback) parses
  PASS  multi-line classic format still works after change

== 9. Decoy-dialog safety (documentation check) ==
  PASS  content.js never queries [role=dialog] globally (querySelector('[role="dialog"]'))
  PASS  content.js scopes dialogs via closest() only
  PASS  isVisible uses checkVisibility with checkOpacity (catches opacity-0 decoy)

================================
TOTAL: 71 passed, 0 failed
```

## 3. Live-Jobber scanner fixes (2026-07-11, from real-DOM inspection)

Real `secure.getjobber.com` client pages exposed two bugs that made v2 detect
NO addresses; both are fixed and regression-tested (sections 7–9 above):

1. **React `generatedName--_r_X_` fields** (edit-property modal): every input
   carries a unique auto-generated name/id, so the old prefix grouping put
   each field in its own group and no address ever assembled. Fix in
   `lib/scan-core.js`: prefixes containing `generatedname` map to `''`, and
   any prefix that occurs on only ONE classified field is demoted to `''`
   before grouping (unique prefixes carry no grouping information). Sequential
   no-overwrite grouping then assembles the modal while multi-field prefixes
   (Rails billing/property sets) still group separately.
2. **Single-line read-only addresses**: the client screen shows the property
   address as ONE line — `<a href="/clients/…"><h5>4330 Marival Way, Mason,
   Ohio 45040</h5></a>`. `parseAddressBlock` previously required 2+ lines. Fix:
   single-line comma parsing (last segment = "State ZIP" incl. full state
   names; segment before = city; the rest = street, must start with a house
   number), plus a per-line fallback inside multi-line blocks. The content
   script's text-block walk now also visits `a`/`h1–h6` elements, and badges
   are inserted AFTER the row container as a sibling — never inside the `<a>`.
3. **Decoy dialog**: the FIRST `[role=dialog]` in Jobber's DOM is a hidden
   decoy (`opacity-0 pointer-events-none`, zero inputs, NOT display:none).
   No code path uses a global first-match dialog query (checked by test 9);
   dialog scoping is `closest()`-based from concrete elements, and
   `isVisible()` now uses `Element.checkVisibility({checkOpacity:true,
   checkVisibilityCSS:true})` so opacity-0 subtrees are skipped everywhere.

## 4. Syntax / manifest validation

`node --check` passes on all 9 JS files (background, content, popup, options,
3 libs, 2 test suites); `manifest.json` parses as valid JSON. Icons
(`icons/icon16/32/48/128.png`) generated from the Mr. Brite mascot
(`sales-tax-calculator-v2/public/logo.png`, 1280×1280) via System.Drawing
(Format32bppArgb + HighQualityBicubic): all four verified as valid PNGs
(correct signature, correct dimensions, alpha preserved). (Run 2026-07-11.)

## 5. Manual test against the fixture (DOM behavior)

`tests/fixtures/jobber-mock.html` now mirrors the REAL Jobber DOM: a decoy
`[role=dialog]` (opacity-0, first in the DOM), a React-style edit-property
modal (generatedName fields, label-for-only signals, State-as-input,
Property name/Country/Search-tax-rate distractors), a single-line
`<a><h5>` property row with utility/obfuscated row classes, plus the original
Rails billing+property form, read-only `<dl>` card, name-line text block,
placeholder-only select, hidden (display:none) modal, duplicate-format
address, and an SPA-mutation simulator button.

Steps (one-time, ~3 minutes):

1. Serve the fixture (content scripts don't run on `file://` by default):
   `node -e "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');require('fs').createReadStream('tests/fixtures/jobber-mock.html').pipe(s)}).listen(8901)"`
2. Temporarily add `"http://localhost:8901/*"` to `content_scripts[0].matches`
   AND `host_permissions` in `manifest.json`; reload the extension at
   `chrome://extensions`. (Revert afterwards.)
3. Open `http://localhost:8901/`. Expected within ~2s — EXACTLY 6 badges:
   - Columbus 43215 (billing form) → `OH-Franklin 8.00%`, badge after the
     "Tax group" select's wrapper;
   - Mason 45040 "456 Reading Rd" (property form) → `OH-Warren 6.75%`;
   - Springboro 45066 (single-line `<a><h5>` row) → verify badge (Warren
     default 6.75% vs Montgomery+MVRTA 7.50% candidates), placed AFTER the
     row container, NOT inside the link;
   - Mason 45040 "4330 Marival Way" (React modal) → `OH-Warren 6.75%` —
     proves the generatedName grouping fix;
   - Westerville 43082 (read-only `<dl>`) → verify badge, 7.00% default +
     Finder link (or 8.00% exact if Census/shard resolves it);
   - Reynoldsburg 43068 (text block) → verify badge listing 8.00/8.25.
   And NO badge for: the decoy dialog, the hidden (display:none) modal
   (43004), the empty "New property" form, the duplicate "456 Reading Road"
   card (deduped).
4. Click "Simulate SPA modal open…": one new badge (Dayton 45402,
   `OH-Montgomery-57000 7.50%`) appears ~1.8s later (debounced rescan) with no
   badge flicker loops (observer ignores its own insertions).
5. Popup: shows the same cards with confidence chips + data footer
   "Data: 2026Q1 (bundled)". On a non-Jobber/non-fixture tab it shows the
   "Open a Jobber page" notice instead.

Status: fixture steps NOT yet executed in a real Chrome session from this
environment; the two live-site bugs were found by real-DOM inspection and are
now locked in by node regression tests (sections 7–9). Re-verification on the
real client page (Marival Way property) is the next Phase-D gate.

## 6. Known gaps / waiting on hosting

- ~~`addr-shards/` per-ZIP files are not hosted yet~~ — RESOLVED: GitHub Pages
  (`jefe2332.github.io/steambrite-tax`) hosts data + shards and is the default
  since v2.0.2; the workflow republishes on any push touching `pipeline/**`.
  The code still treats 404/network-fail as "shard unavailable" (falls through
  to Census). Resolver test 7 exercises the matcher against the shard shape
  (`{zip,v,streets,addr:[{street,lo,hi,oddEven,c,t}]}`) and the legacy `oe` key;
  test 11 covers the `streets` directory semantics.
- Census/FCC calls are stubbed in tests; the backend smoke test (section 7)
  exercised the full local stack against the real shard files.

## 7. Live Sunbury Rd regression (2026-07-11, v2.0.2)

Live backend verification found: POST /api/lookup for
"6000 S Sunbury Rd, Westerville, OH 43082" returned **Franklin+COTA 8.00%
"high"** — wrong. State boundary A-records put SUNBURY RD in 43082 in county
041 (Delaware), no transit → **7.00%**. Two compounding causes:

1. street-name miss: the state file stores "SUNBURY RD" (no directional),
   input said "S Sunbury Rd" — the exact-match compare failed;
2. house number 6000 exists in no range (nonexistent address), so the resolver
   fell to Census, which fuzzy-snapped onto a Franklin-side street (matched
   ZIP 43081) and confidently returned county 049.

Fixes (resolver test section 11 locks all of them in):

- `normalize.js` gained `stripDirectionals()`; shard street matching (both
  override ranges and the street directory) tries exact first, then
  directional-stripped on both sides;
- shards now carry `streets` (full street directory of the ZIP): street in
  `streets` with no override row → ZIP default combo, **exact**
  (method `addr-default`); street not in `streets` → Census allowed, BUT its
  matched address must be in the SAME ZIP5 — on mismatch the resolver returns
  the ZIP default with **verify** instead of trusting the snapped county;
- old-format shards (no `streets`) keep the previous behavior.

Local backend smoke test after the fix (real shard files served locally,
`SMOKE=1`, port 8930):

```
POST /api/lookup {"address":{"street":"6000 S Sunbury Rd","city":"Westerville","state":"OH","zip":"43082"},"forceOhio":true}
-> {"state":{"name":"Ohio","rate":0.0575},"county":{"name":"Delaware","rate":0.0125},
    "city":{"name":"Westerville","rate":0},"districts":[],"totalRate":0.07,
    "locationName":"Westerville, OH 43082", ..., "confidence":"exact"}   ✔ was Franklin 8.00% "high"

POST … "305 S Sunbury Rd" (odd, inside override range 301-335)
-> Delaware + COTA district, totalRate 0.08, confidence "exact"          ✔ directional-stripped range match

POST … "123 S High St, Columbus 43215"  -> Franklin + COTA 0.08 "exact"  ✔ control unchanged
POST … "456 Reading Rd, Mason 45040"    -> Warren 0.0675 "exact"         ✔ control unchanged
```
