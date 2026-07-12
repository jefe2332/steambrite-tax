# backend - tax.steambrite.us

Express server that powers the sales-tax calculator SPA and the `/api/lookup`
API. Deploys to Cloud Run (buildpacks: `npm run build` → `npm start`).

## What it does

- **Ohio addresses** → resolved **exactly** from the official Ohio Dept. of
  Taxation "The Finder" data using the same resolver the Chrome extension uses
  (`lib/resolver.js` + `lib/normalize.js`, shared verbatim). No paid APIs.
- **Data layer** → boots from the bundled snapshot `data/ohio-tax-data.json`,
  then fetches `DATA_URL` on boot and every 24h, hot-swapping to a newer quarter
  in memory. Fetch failures are non-fatal (keeps last-known-good).
- **Non-Ohio addresses** → optional Gemini google-search fallback. Without
  `GEMINI_API_KEY` set, non-Ohio lookups return HTTP 422 (not 500). Parsed rates
  are sanity-validated (each 0 ≤ r < 0.2; parts sum to `totalRate` ± 0.001).

`/api/lookup` responses are backward-compatible with the SPA and add a
`confidence` field: `"exact"` (ZIP5/ZIP+4/street match), `"high"` (geocoder), or
`"verify"` (ambiguous ZIP, needs a human check on The Finder).

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Cloud Run injects this (usually 8080). |
| `NODE_ENV` | dev | `production` serves the built `dist/` SPA. |
| `DATA_URL` | GitHub Pages `ohio-tax-data.min.json` | Where to fetch the compiled Ohio data. Manual fallback: the GCS bucket (`storage.googleapis.com/tax-rate-calculator-assets/ohio-tax-data.min.json`). |
| `SHARD_BASE_URL` | GitHub Pages `addr-shards` | Base URL for per-ZIP address shards. Manual fallback: the GCS bucket `addr-shards` path. |
| `GEMINI_API_KEY` | _(unset)_ | Enables non-Ohio lookups. Ohio lookups never need it. |

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000  (Vite dev middleware + API)

# API-only, no frontend build (used for smoke tests):
SMOKE=1 node server.js
```

Endpoints: `POST /api/lookup`, `POST /api/suggest`, `GET /api/status`.

See [TESTING.md](TESTING.md) for recorded `/api/lookup` smoke-test results.

## Media files

The `public/` folder contains `logo.png` and the celebratory `booty-shake` clip
used by the SPA.
