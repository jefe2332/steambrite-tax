# Backend smoke tests - `/api/lookup`

Recorded verbatim from a real run of the upgraded backend.

**How it was run**

```bash
cd backend
npm install
SMOKE=1 node server.js      # SMOKE=1 skips the Vite dev middleware so the
                            # API is reachable without a frontend build
```

Boot log (clean - data boots from the bundled snapshot, then upgrades from
`DATA_URL` if a newer quarter is hosted):

```
[data] booted from bundled snapshot 2026Q1
API-only mode (no dist build present; Vite disabled).
Server running on port 3000
[data] boot: remote 2026Q1 not newer than 2026Q1 - keeping current
```

Environment: Node v24.14.1, Windows 11. No `GEMINI_API_KEY` set. Data version
`2026Q1` (bundled), state rate 5.75%.

Each test was issued with:

```bash
curl -s -w "HTTP %{http_code}" -X POST http://localhost:3000/api/lookup \
  -H "Content-Type: application/json" -d '<body>'
```

---

## Test 1 - 43215 Columbus  → expect Franklin exact 8.00%

Request body:
```json
{"address":{"street":"77 S High St","city":"Columbus","state":"OH","zip":"43215"}}
```

Response - **HTTP 200**:
```json
{"state":{"name":"Ohio","rate":0.0575},"county":{"name":"Franklin","rate":0.0125},"city":{"name":"Columbus","rate":0},"districts":[{"name":"COTA","rate":0.01}],"totalRate":0.08,"locationName":"Columbus, OH 43215","sources":[{"title":"Ohio Dept of Taxation – The Finder","uri":"https://thefinder.tax.ohio.gov/"}],"isLocalMatch":true,"confidence":"exact"}
```

**PASS** - Franklin County + COTA transit, total **8.00%**, `confidence: "exact"` (unambiguous ZIP5).

---

## Test 2 - 45040 Mason  → expect Warren exact 6.75%

Request body:
```json
{"address":{"street":"5145 Kings Mills Rd","city":"Mason","state":"OH","zip":"45040"}}
```

Response - **HTTP 200**:
```json
{"state":{"name":"Ohio","rate":0.0575},"county":{"name":"Warren","rate":0.01},"city":{"name":"Mason","rate":0},"districts":[],"totalRate":0.0675,"locationName":"Mason, OH 45040","sources":[{"title":"Ohio Dept of Taxation – The Finder","uri":"https://thefinder.tax.ohio.gov/"}],"isLocalMatch":true,"confidence":"exact"}
```

**PASS** - Warren County, no transit, total **6.75%**, `confidence: "exact"`.

---

## Test 3 - 43082 (no ZIP+4)  → expect verify, Delaware default 7.00%

43082 is an ambiguous ZIP (Delaware / Delaware+COTA / Franklin+COTA). With no
ZIP+4 and no street to pin it, the resolver falls back to the ZIP's default
combo and flags it for human verification.

Request body:
```json
{"address":{"street":"","city":"Westerville","state":"OH","zip":"43082"}}
```

Response - **HTTP 200**:
```json
{"state":{"name":"Ohio","rate":0.0575},"county":{"name":"Delaware","rate":0.0125},"city":{"name":"Westerville","rate":0},"districts":[],"totalRate":0.07,"locationName":"Westerville, OH 43082","sources":[{"title":"Ohio Dept of Taxation – The Finder","uri":"https://thefinder.tax.ohio.gov/"}],"isLocalMatch":true,"confidence":"verify"}
```

**PASS** - Delaware County default, total **7.00%**, `confidence: "verify"`.
(Providing a valid ZIP+4 or a matchable street address resolves this to `exact`.)

---

## Test 4 - non-Ohio (Washington DC), no GEMINI_API_KEY  → expect 422

Request body:
```json
{"address":{"street":"1600 Pennsylvania Ave NW","city":"Washington","state":"DC","zip":"20500"}}
```

Response - **HTTP 422**:
```json
{"error":"non-Ohio lookup unavailable"}
```

**PASS** - Non-Ohio addresses require `GEMINI_API_KEY`; without it the backend
returns a clean 422 instead of a 500. (With a key set, the same request runs the
Gemini google-search fallback and its parsed rates are sanity-validated -
each 0 ≤ r < 0.2 and the pieces must sum to `totalRate` within 0.001.)

---

## Bonus - `GET /api/status`

```json
{"ok":true,"dataVersion":"2026Q1","dataSource":"bundled","effectiveDate":"2026-07-11","generatedAt":"2026-07-11T22:35:26.291Z","dataUrl":"https://storage.googleapis.com/tax-rate-calculator-assets/ohio-tax-data.min.json","shardBaseUrl":"https://storage.googleapis.com/tax-rate-calculator-assets/addr-shards"}
```

## Summary

| # | Case | Expected | Result |
|---|------|----------|--------|
| 1 | 43215 Columbus | Franklin exact 8.00% | PASS (200, exact) |
| 2 | 45040 Mason | Warren exact 6.75% | PASS (200, exact) |
| 3 | 43082 no +4 | Delaware default, verify | PASS (200, verify, 7.00%) |
| 4 | Non-Ohio, no key | 422 | PASS (422) |

All 4/4 passed.
