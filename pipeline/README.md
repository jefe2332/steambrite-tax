# Ohio Sales-Tax Data Pipeline

Converts Ohio's official Streamlined Sales Tax (SST) boundary + rate files from
the Ohio Department of Taxation's **"The Finder"** into a compact ZIP -> tax
jurisdiction lookup for a Chrome extension.

Ohio sales tax = **state 5.75%** + **county rate** + (sometimes) a
**transit-authority overlay** (e.g. COTA 1.0% covers all of Franklin County plus
slivers of Delaware / Fairfield / Licking / Union). Because these boundaries cut
across ZIP codes, the lookup resolves in three tiers:

**ZIP5 -> (if the ZIP straddles a boundary) ZIP+4 -> (if needed) street address range.**

This replaces the old ZIP-blended Avalara CSV, which reported a single wrong
rate for straddling ZIPs.

---

## Quick start

```
node build.js            # build from raw/ (downloads only what's missing)
node build.js --fresh    # re-download every source file, then rebuild
```

Requires **Node.js** (tested on v24) and `curl` (bundled with Git for Windows).
No npm dependencies. On Windows the boundary `.zip` is extracted with `unzip`
if present, otherwise PowerShell `Expand-Archive`.

---

## Outputs (`dist/`)

| File | Size | Contents |
|---|---|---|
| `ohio-tax-data.json` | ~3.3 MB | Pretty-printed main lookup |
| `ohio-tax-data.min.json` | ~1.45 MB (gzip ~0.20 MB) | Minified main lookup — **bundle this in the extension** |
| `ohio-addr-ranges.json` | ~30 MB (gzip ~2.3 MB) | Street-address override ranges for ambiguous ZIPs, combined (for analysis / hosting whole) |
| `addr-shards/<zip5>.json` | 556 files, ~32 MB total (median ~17 KB, max ~562 KB) | Per-ZIP address override shards — **host these; the extension fetches only the shard for the ZIP it needs** |
| `VERIFICATION.md` | — | Rate cross-checks vs the state's own report |

### Main file shape (`ohio-tax-data.json`)

```jsonc
{
  "meta": { "version": "2026Q1", "generatedAt": "...", "effectiveDate": "2026-07-11",
            "sources": [...], "counts": {...}, "notes": [...] },
  "stateRate": 0.0575,
  "counties":  { "049": { "name": "Franklin", "rate": 0.0125 }, ... },   // county portion only
  "transits":  { "25000": { "name": "COTA", "fullName": "...", "coverage": "Franklin County",
                            "countywide": true, "rate": 0.01 }, ... },
  "zip5": {
    "43215": { "c": "049", "t": "25000" },                 // unambiguous: county + transit FIPS (t may be null)
    "43082": { "d": { "c": "041", "t": null },              // ambiguous: d = default when no override matches
               "ambiguous": [ {"c":"041","t":null}, {"c":"041","t":"96000"}, {"c":"049","t":"25000"} ] }
  },
  "zip4": { "43082": [ { "lo": 1, "hi": 6, "c": "041", "t": "96000" }, ... ] },  // OVERRIDES only, ambiguous ZIPs
  "jobberCombos": [ { "county": "Warren", "transit": null, "total": 0.0675, "label": "OH-Warren" }, ... ]
}
```

`c` = county FIPS (3-digit), `t` = transit place FIPS (5-digit) or `null`.
Combined rate for any combo = `stateRate + counties[c].rate + (t ? transits[t].rate : 0)`.

### Address sidecar (`ohio-addr-ranges.json`)

```jsonc
{ "meta": {...},
  "addr": { "43082": [ { "street": "ABBEYCROSS LN", "lo": 1, "hi": 67, "oe": "O",
                         "c": "041", "t": "96000" }, ... ] } }
```

`oe` = `O` odd / `E` even / `B` both. Only ranges that differ from the ZIP's
default are stored (see resolution model below).

### Per-ZIP address shards (`addr-shards/<zip5>.json`)

One shard per **ambiguous** ZIP5, so the extension can fetch just the ZIP it
needs instead of the 30 MB combined sidecar:

```jsonc
// addr-shards/43082.json
{ "zip": "43082", "v": "2026Q1",
  "addr": [ { "street": "ABBEYCROSS LN", "lo": 1, "hi": 67, "oddEven": "O",
              "c": "041", "t": "96000" }, ... ] }
```

Same override-only semantics as the combined sidecar; the odd/even field is
spelled out as `oddEven` here (`O`/`E`/`B`). Every ambiguous ZIP gets a shard —
one with no address overrides (`45481`) still gets `"addr": []` so a fetch
never 404s. `v` echoes `meta.version` so the extension can detect a stale
shard vs its bundled main file. Unambiguous ZIPs have no shard (they never
need one).

---

## Resolution model (how a consumer looks up a rate)

Given a ZIP5 (and optionally ZIP+4 and/or street address):

1. `e = zip5[zip]`.
2. If `e.c` is present -> **unambiguous**, use `{e.c, e.t}`. Done.
3. Otherwise the ZIP straddles a boundary. Resolve finest-match-first:
   1. **Address:** if street + house number are known, fetch
      `addr-shards/<zip>.json` (or use `addr[zip]` from the combined sidecar)
      and find a record whose `street` matches and `number` is in `[lo,hi]`
      honoring the odd/even flag. If found, use its `{c,t}`.
   2. **ZIP+4:** else if the +4 is known, find a range in `zip4[zip]` with
      `lo <= plus4 <= hi`. If found, use its `{c,t}`.
   3. **Default:** else use `e.d` (`{c,t}`).

Both `zip4` and `addr` store **only the ranges whose jurisdiction differs from
the ZIP's default** (`e.d`, taken from the SST ZIP5 record). Any address not
listed therefore falls through to the default. This is lossless under the SST
"use the most specific match" rule and roughly halves the address payload
(741k -> 397k records) and ZIP+4 payload (57k -> 32k).

---

## Re-running each quarter

The Finder publishes new files roughly quarterly (file names embed the quarter,
e.g. `OHB2026Q1NOV28.zip`, `OHR2026Q1NOV28.csv`). To refresh:

```
node build.js --fresh
```

`build.js` scrapes the two instruction pages for the **current** boundary `.zip`
and rate `.csv` links, so you do **not** need to edit file names by hand:

- Boundary DB: <https://thefinder.tax.ohio.gov/streamlinesalestaxweb/Download/DownloadInstructions.aspx>
- Rate table:  <https://thefinder.tax.ohio.gov/streamlinesalestaxweb/Download/SSTPRateTableInstructions.aspx>

All raw downloads are kept in `raw/` (they are the quarterly inputs). All state
requests send a browser `User-Agent`; the state servers 404 generic fetchers.

The effective-date filter is the constant `TODAY` near the top of `build.js`
(currently `20260711`). Only records active on that date are included; bump it
when you re-run in a later quarter. The build reports any future-dated rate
changes found in the source files.

---

## Files

```
tax-data-pipeline/
  build.js            # end-to-end pipeline (download -> parse -> emit)
  verify.js           # cross-checks, writes dist/VERIFICATION.md
  raw/                # raw quarterly downloads (kept)
    OHB*.zip, OHR*.csv, OH*FIPSCodes.txt, CountySalesTaxRateReport.csv
    boundary_extracted/OHB*.csv
  dist/               # generated outputs
    addr-shards/      # per-ZIP address override shards (one per ambiguous ZIP)
  README.md
```
