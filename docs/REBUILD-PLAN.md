# Tax Extension Rebuild — Master Plan & Resume State

_Last updated: 2026-07-11 (session: full audit complete, rebuild phase started)_
_If resuming in a fresh session: read this file top to bottom, then check "Phase status" at the bottom._

## Goals & constraints

- **Primary tool:** `chrome-tax-extension` — scans Jobber (secure.getjobber.com) pages for addresses, suggests the exact Ohio sales tax rate + the matching Jobber tax-group label, injects a badge.
- **Accuracy target:** exact county + transit-district (COTA/MVRTA/TARTA) resolution per street address. ZIP-blended estimates are not acceptable (that was the root bug).
- **No paid APIs, no API keys.** Free sources only.
- **Fast + reliable:** no Cloud Run cold-start dependency in the hot path; works even if every network call fails (bundled data).
- **Keep `tax.steambrite.us` (Cloud Run: sales-tax-calculator-v2, us-east4) alive as a fallback**, not the primary.
- **Distribution reality:** NOT on Chrome Web Store. 3–4 users side-load an unpacked/zip extension. Data updates must NOT require redistributing the zip.
- **Jobber tax settings sync to QuickBooks Online** — group/rate names are load-bearing; changes must follow the safe procedure (see JOBBER-TAX-CLEANUP.md).

## Verified audit findings (July 2026) — why the old one was wrong

1. Backend rate lookup keyed on ZIP5 from Avalara *blended-estimate* CSV; street address never used. Multi-county ZIPs (43004, 43068, 43081/43082…) return wrong rates for large fractions of addresses.
2. Static fallback table in `sales-tax-calculator-v2/data/ohioTaxData.js` is ~2019–2021 vintage; 11 of 88 counties wrong (Franklin 7.5% vs actual 8.0%). ZIP+4 input silently falls through to this stale path.
3. County *label* (Nominatim, zip+city only) and *rate* (Avalara CSV) come from different sources → mismatched labels (proven live: Delaware Co. address labeled "Franklin" at 8.0% when truth was 7.0%).
4. Gemini web-search fallback: nondeterministic, unvalidated JSON.
5. Extension code: innerHTML XSS vectors, popup-owned lookups (die on close), no fetch timeout, no 429 handling, fragile 3-strategy DOM scan (Frankenstein address merging, placeholder-as-value, client names prepended to streets).
6. Ohio facts (all verified vs tax.ohio.gov): state 5.75%; changes land ONLY on quarter boundaries; 2025 changes: COTA +0.5% Apr 1 (Franklin→8.0%, COTA slivers of Delaware/Fairfield/Licking/Union), Lake→7.25% Jul 1, Brown→7.00% Oct 1; NO 2026 changes as of July 2026.
7. `avalara.csv` in v2 is actually current (Q4-2025+ vintage) — the stale static table and ZIP-blending were the problems, not that file's freshness.

## Authoritative data source (the fix)

**Ohio Dept of Taxation "The Finder"** (thefinder.tax.ohio.gov) — free, no registration:
- SSTP **boundary file** `OHB{YYYY}Q{n}*.zip`: address-range + ZIP+4 + ZIP5 records → county & transit FIPS. This resolves COTA-style overlays exactly.
- SSTP **rate file** `OHR{YYYY}Q{n}*.csv`: state/county/transit rates with effective dates.
- Reference: `OHCountyFIPSCodes.txt`, `OHTransitFIPSCodes.txt`.
- Sanity file: `Download/BoundaryData/CountySalesTaxRateReport.csv` (ZIP→county, MultipleCounties flag).
- Updated quarterly (SST rules: boundary/rate changes only at quarter starts). Sellers relying on SST data get statutory liability relief.
- State servers 404 generic fetchers — always send a browser User-Agent.

## Target architecture

```
┌─ chrome-tax-extension v2 ───────────────────────────────────┐
│ content.js  – hardened Jobber DOM scan (rebuilt)            │
│ service worker – owns lookups, cache, data refresh          │
│ lookup order:                                               │
│   1. bundled/cached ohio-tax-data.json  (ZIP5 unambiguous → │
│      instant; else ZIP+4 ranges; else addr ranges)          │
│   2. Census geocoder (free, no key) for still-ambiguous:    │
│      street → county FIPS (+ place), via host_permissions   │
│      https://geocoding.geo.census.gov/geocoder/geographies/ │
│      onelineaddress?benchmark=Public_AR_Current&vintage=... │
│   3. FCC Area API (lat/lon → county, CORS *) spare fallback │
│   4. tax.steambrite.us /api/lookup — LAST resort, labeled   │
│ data refresh: weekly background fetch of ohio-tax-data.json │
│   from static hosting; cached in chrome.storage.local;      │
│   bundled copy = offline floor                              │
└──────────────────────────────────────────────────────────────┘
        ▲ data
┌─ tax-data-pipeline (H:\...\tax-data-pipeline\) ─────────────┐
│ build script: download Finder files → parse → emit          │
│ dist/ohio-tax-data.json (+ verification report)             │
│ run quarterly (manual 2-min task, or automated — below)     │
└──────────────────────────────────────────────────────────────┘
        ▲ hosting
Static hosting: existing GCS bucket (tax-rate-calculator-assets on
storage.googleapis.com — already referenced by the extension CSP) or
the Cloud Run service's /public. Bucket preferred (no cold start, ~$0).
```

**Auto-update answer:** the extension code is side-loaded (no store auto-update), so the *code* stays put, but the *data* self-updates: the service worker checks the hosted `ohio-tax-data.json` (versioned, e.g. `meta.version = "2026Q3"`) roughly weekly, stores it in `chrome.storage.local`, and always prefers cached-remote > bundled. Rebuilding/redistributing the zip is only needed for code changes. The quarterly data rebuild itself can be:
- **Option A (simplest):** calendar reminder; run `node build.js` in tax-data-pipeline; upload dist JSON to the bucket. ~2 minutes, 4×/year.
- **Option B (automated):** Cloud Scheduler → Cloud Run Job (runs the same build script, writes to GCS). Ohio publishes changes ≥60 days before quarter start, so schedule for the 1st of Jan/Apr/Jul/Oct + a bulletin-check.
- Either way the 3–4 installed extensions pick it up automatically within a week — no reinstalls.

**Jobber label mapping:** data file carries `jobberCombos` (county+transit → total rate + suggested label like `OH-Warren`, `OH-Delaware-COTA`). Extension maps resolved jurisdiction → the group name that exists in Jobber settings, so badge label always matches both the rate AND the Jobber dropdown option.

**Non-Ohio addresses:** rare for this business. Show state-level estimate labeled as estimate, or defer to the tax.steambrite.us fallback. Do NOT block on this.

## Backend (`tax.steambrite.us`) — keep as fallback, later upgrade

- Phase E (optional, low priority): replace its Avalara-ZIP logic with the same `ohio-tax-data.json` + Census geocoder resolution so the fallback agrees with the extension. Delete the stale `OHIO_COUNTY_RATES` table and the Nominatim autocomplete (policy violation) when touched.
- Keep min-instances=0 (cold start acceptable for a fallback).
- Retire legacy `sales-tax-calculator` (v1) entirely — client-side Gemini key, nothing to salvage. If its API key was ever real, rotate it in Google AI Studio.

## Google Cloud Console steps (when we get there)

1. **Bucket:** reuse `tax-rate-calculator-assets` (or create `steambrite-tax-data`): upload `ohio-tax-data.json`, make object public-read, note URL `https://storage.googleapis.com/<bucket>/ohio-tax-data.json`. Set `Cache-Control: public, max-age=3600` on the object.
2. **(Option B only) Cloud Run Job** `tax-data-refresh`: container runs pipeline build + `gsutil cp`; **Cloud Scheduler** cron `0 9 1 1,4,7,10 *` (9am on Jan/Apr/Jul/Oct 1).
3. Cloud Run service `sales-tax-calculator-v2`: leave as-is for now (fallback). When Phase E lands, deploy new revision via the existing GitHub→Cloud Build trigger.
4. Nothing else. No new APIs to enable, no keys, no billing changes beyond pennies of storage.

## Team distribution (3–4 users, side-loaded)

Current: users load an unpacked zip via chrome://extensions (Developer mode). Keep that flow:
1. Zip the new extension folder; share via Drive.
2. Each user: chrome://extensions → remove old → Load unpacked (or drag zip contents folder). One time per CODE release; data updates itself thereafter.
3. **Recommended upgrade (later, optional): publish as UNLISTED on Chrome Web Store** — $5 one-time dev fee, private link only, no public visibility, and Chrome then auto-updates code for everyone. Best long-term answer; not required for v2 launch.

## Jobber tax settings — see JOBBER-TAX-CLEANUP.md (written after QBO-sync research lands)

Known already (verified rates, July 2026): every group in Jobber is correct EXCEPT **OH-Warren: currently 7.0%, must become 6.75%** (Warren county component 1.25% → 1.0%; changed Jan 2023 — currently over-collecting). Duplicates to consolidate: "Ohio, Franklin" vs "Ohio, Franklin County" (both 1.25%), "OH-Franklin" vs "OH-Franklin-25000" (both 8.0%), "OH-Montgomery-57000" naming. Consider adding OH-Delaware-COTA (8.0%) if any customers are in Westerville/Columbus slivers of Delaware County. Exact safe procedure pending QBO sync research (agent running).

## Phase status (UPDATE THIS AS WORK LANDS)

- [x] **Phase 0 — Audit** (done 2026-07-11): 15-agent workflow; findings above; all claims verified vs primary sources.
- [x] **Phase A — Data pipeline** (done 2026-07-11): `tax-data-pipeline\` — `node build.js` (--fresh to re-download) → `dist\ohio-tax-data.min.json` **1.45 MB (0.20 MB gzip)** + 29.7 MB addr-range sidecar + VERIFICATION.md. **ALL 12/12 checks pass**: 88/88 county totals match state report; split districts correct; 43082/43068/43004/45040/43215 spot checks pass. 1,394 ZIP5s: 838 unambiguous, 556 ambiguous (31,848 ZIP+4 overrides, 396,745 address overrides). Data vintage 2026Q1 (current — no 2026 rate changes). Follow-up in progress: per-ZIP addr shards to `dist\addr-shards\<zip>.json` for on-demand fetch. BONUS DISCOVERY: transit FIPS 25000=COTA, 57000=MVRTA → the Jobber group suffixes are QBO-AST jurisdiction codes (see JOBBER-TAX-CLEANUP.md).
- [x] **Phase B — Jobber/QBO cleanup doc** (done 2026-07-11): JOBBER-TAX-CLEANUP.md written — sync mechanics (name-match only, QBO forks edited used rates, AST auto-creation breeds duplicates), pre-flight checks (AST on/off? which dup carries history?), Fix 1 = Warren create-new+retire-old, Fix 2 = duplicate consolidation. USER ACTION REQUIRED: pre-flight checks in QBO, then apply Fix 1.
- [x] **Phase C.1 — Live-DOM fixes** (done 2026-07-11 evening): real Jobber DOM inspected via browser — React modal fields use unique `generatedName--_r_X_` names (label-for is the ONLY signal; State is an INPUT not select; first `[role=dialog]` is a hidden decoy); client screen shows single-line `<a><h5>Street, City, Ohio 45040` links. Fixed: unique-prefix demotion in groupFields + single-line comma parsing + a/h1-h6 in text walk + badge always sibling-after-row (never inside `<a>`). **Verified live on secure.getjobber.com: both paths parse Mason/OH/45040 correctly, incl. read-only client screen (no pencil needed).** Also: manifest renamed to "Jobber Tax Calculator Extension" (v1 name), Mr. Brite icons 16/32/48/128 generated from logo.png. Tests now 47/47 resolver + 71/71 scanner. Zip rebuilt (267 KB). Bucket hosting CONFIRMED LIVE (data + shards return 200 public). USER: press reload ↻ on the extension card in chrome://extensions to pick up the fixes.
- [x] **Phase C — Extension rebuild** (done 2026-07-11): `chrome-tax-extension-v2\` complete — 19 files, zero deps, load-unpacked ready. **Tests: 47/47 resolver + 46/46 scanner pass** (node tests/resolver.test.js, tests/scanner.test.js); node --check clean. Resolution chain: zip5→zip4→addr-shard→Census→FCC→legacy backend, confidence chips (exact/high/verify/estimate), verify badges link to The Finder. Label map matches actual Jobber groups (incl. OH-Montgomery-57000); editable in options. Data self-update via alarms every 3d from hosted URL (404-silent until hosted). All 10 audited v1 scanner bugs fixed; no innerHTML anywhere. Team zip: `chrome-tax-extension-v2.zip` (0.22 MB, tests excluded). Original spec kept below for reference: MV3 service worker owns lookups + weekly data refresh; bundled data snapshot; Census-geocoder disambiguation; hardened content-script scanning (fix Frankenstein merge, placeholder values, label matching incl. underscore ids, textContent everywhere — NO innerHTML with dynamic strings); fetch timeouts; per-address session cache; parallel lookups; badge shows group label matching Jobber settings. Host permissions: secure.getjobber.com, geocoding.geo.census.gov, geo.fcc.gov, storage.googleapis.com, tax.steambrite.us.
- [ ] **Phase D — Hosting + rollout** (READY — needs user, no SDK on this machine): (1) Cloud Console → Cloud Storage → bucket `tax-rate-calculator-assets` → upload `tax-data-pipeline\dist\ohio-tax-data.min.json` + the `dist\addr-shards\` folder (556 files; drag the folder). Ensure public read (bucket already serves the logo publicly). Optionally set object metadata Cache-Control: public,max-age=3600. (2) User loads `chrome-tax-extension-v2\` unpacked in Chrome, tests live on Jobber (test set: Mason 45040, Westerville 43081/43082, Reynoldsburg 43068, Columbus 43215, Dayton 45402 MVRTA). (3) Distribute `chrome-tax-extension-v2.zip` (in project root) to the 3-4 teammates: unzip to a permanent folder → chrome://extensions → Developer mode → Load unpacked → remove old extension. (4) Quarterly: `node build.js --fresh` in tax-data-pipeline, re-upload the two artifacts — extensions self-update within ~3 days.
- [ ] **Phase E (optional) — Backend upgrade**: port same lookup into tax.steambrite.us; retire v1 project.

## Key file locations

- Old projects: `H:\Tax Rate Calculator and Chrome Extension Projects\{chrome-tax-extension, sales-tax-calculator-v2, sales-tax-calculator}`
- Pipeline (new): `H:\Tax Rate Calculator and Chrome Extension Projects\tax-data-pipeline\`
- Extension v2 (new, Phase C): `H:\Tax Rate Calculator and Chrome Extension Projects\chrome-tax-extension-v2\`
- This plan: `H:\Tax Rate Calculator and Chrome Extension Projects\REBUILD-PLAN.md`
- Jobber cleanup: `H:\Tax Rate Calculator and Chrome Extension Projects\JOBBER-TAX-CLEANUP.md`
- Memory: `C:\Users\bluew\.claude\projects\H--Repos\memory\tax-extension-project.md`
- User can't git-push from agent shell; uses GitHub Desktop.
