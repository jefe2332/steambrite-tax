# Jobber Tax Calculator Extension (v2)

Chrome extension (Manifest V3, no build step, no dependencies) for the Steambrite
team. On **secure.getjobber.com** it scans the page for customer addresses,
resolves the **exact Ohio sales-tax jurisdiction** (county + optional transit
district like COTA/MVRTA) **locally** from bundled official Ohio Dept. of
Taxation ("The Finder") data, and shows:

- a **popup card** per address: the Jobber tax-group label to pick
  (e.g. `OH-Warren`), the total rate (e.g. `6.75%`), and the breakdown
  (`Ohio 5.75% + Warren County 1.00%`), plus a confidence chip;
- an injected **"Suggested tax" badge** on the Jobber page near the address /
  tax dropdown.

## Install (teammates)

1. Get the `chrome-tax-extension-v2` folder (zip via Drive, or this repo) and
   unzip it somewhere permanent (Chrome loads it from disk).
2. Open Chrome → `chrome://extensions`.
3. Toggle **Developer mode** ON (top right).
4. Click **Load unpacked** → select the `chrome-tax-extension-v2` folder.
5. (If replacing v1: click **Remove** on the old v1 "Jobber Tax Calculator
   Extension" entry first - same name, so check the version says 2.0.1.)
6. Open any Jobber client/quote/invoice page - badges appear automatically;
   click the extension icon for the full cards.

Re-installing is only needed for **code** changes. **Tax data updates itself**
(see below).

## How a lookup works

For each address the service worker resolves, in order (first hit wins):

| Step | Source | Confidence shown |
|---|---|---|
| 1 | ZIP5 unambiguous (bundled data) | Exact |
| 2 | ZIP+4 boundary range (bundled data) | Exact |
| 3 | Street-address shard (`<shardBaseUrl>/<zip5>.json`, hosted, cached) | Exact |
| 4 | Census geocoder (free, no key) → county → filter ZIP's candidates | High (single match) / Verify (transit split) |
| 5 | FCC area API (lat/lon from Census) | High / Verify |
| 6 | Legacy backend `tax.steambrite.us` | Estimate |
| - | Everything offline: ZIP's default combo | Verify |

**Verify** badges show "⚠ boundary area - verify" plus a one-click link to
[Ohio's The Finder](https://thefinder.tax.ohio.gov/streamlinesalestaxweb/AddressLookup/LookupByAddress.aspx?taxType=Sales)
so a human can confirm in ~10 seconds. Rate math is always
`state 5.75% + county + (transit if any)`.

All external calls have an 8-second timeout and one retry; every failure
degrades gracefully (worst case: ZIP default + Verify flag). Results are cached
per normalized address for the browser session.

## Data auto-update

- The extension ships with `data/ohio-tax-data.json` (2026Q1 vintage) - that
  bundled file is the floor; it works fully offline.
- Every **3 days** (and on install) the service worker fetches the hosted
  `ohio-tax-data.min.json` (URL configurable in Options). If the hosted
  `meta.version` is newer, it's stored in `chrome.storage.local` and used from
  then on. 404 (hosting not set up yet) is silently ignored.
- The active version + source (bundled/remote) shows in the popup footer and
  on the Options page, which also has a **"Check for data update now"** button.
- Default hosting is **GitHub Pages** (`jefe2332.github.io/steambrite-tax`),
  published automatically by the repo's data workflow - any push touching
  `pipeline/**` (or the quarterly schedule) rebuilds and republishes data +
  shards. All installed extensions pick it up within 3 days.
- Manual fallback host: the GCS bucket
  (`storage.googleapis.com/tax-rate-calculator-assets`) - run
  `node pipeline/build.js` and upload `dist/ohio-tax-data.min.json` +
  `dist/addr-shards/*` there, then point Options at it.

## Options page (right-click icon → Options)

- **Endpoints:** data URL, address-shard base URL, legacy backend URL.
- **Jobber tax-group labels:** every Ohio jurisdiction combo with its default
  label. Built-in defaults match Steambrite's actual current Jobber groups
  (`OH-Warren`, `OH-Franklin`, `OH-Montgomery-57000`, `OH-Hamilton`, ...).
  Combos with no mapping show the data file's suggested name +
  "(add this group in Jobber)". Type an override to change any label -
  overrides sync across your Chrome profile (`storage.sync`).

## Files

```
manifest.json         MV3 manifest (permissions: storage, alarms, activeTab)
background.js         service worker: lookups, caches, data refresh (alarms)
content.js            Jobber page scanner + badge injector (thin)
content.css           badge styles
popup.html/css/js     popup UI (auto-scan, result cards, data footer)
options.html/css/js   endpoints + label-mapping editor + update button
lib/normalize.js      address normalization (pure, node-testable)
lib/scan-core.js      scanner core logic (pure, node-testable)
lib/resolver.js       jurisdiction resolver (pure, node-testable)
data/ohio-tax-data.json  bundled Ohio tax data (from tax-data-pipeline)
icons/                toolbar icons (16/32/48/128, from the Mr. Brite mascot)
tests/                node test suites + Jobber page fixture (see TESTING.md)
```

Run tests any time with plain node (no npm install):

```
node tests/resolver.test.js
node tests/scanner.test.js
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup says "Could not connect to the page" | Refresh the Jobber tab (content script loads on page load), then Refresh in the popup. |
| No badges on the page | Only complete addresses (street + city + state + ZIP) get badges. Check the popup for what was found. |
| Badge shows "⚠ boundary area - verify" | The ZIP straddles a tax boundary and online disambiguation was inconclusive/offline. Click "Check in The Finder", confirm, pick the group manually. |
| "Estimate (legacy backend)" | Local data had no answer (e.g. non-Ohio address); the old Cloud Run backend supplied a blended estimate - treat with care. |
| Popup footer says Data: ... (bundled) forever | Hosted data isn't published yet, or the data URL in Options is wrong. That's fine - bundled data is current until next quarter. |
| Rates look outdated after a quarter change | Options → "Check for data update now". If the host 404s, rebuild + upload from `tax-data-pipeline`, or re-zip the extension with a fresh `data/ohio-tax-data.json`. |
| A suggested label doesn't match a group in Jobber | Options → edit that combo's label to the exact Jobber group name (must match QuickBooks byte-for-byte - see JOBBER-TAX-CLEANUP.md). |

## Privacy / permissions

Host access is limited to: Jobber (scan), Census + FCC (free government
geocoders for boundary ZIPs only), storage.googleapis.com and *.github.io
(data updates + popup logo/video assets), tax.steambrite.us (last-resort
fallback). Addresses are only ever sent to the Census/FCC/backend when the
bundled data alone can't resolve the jurisdiction.
