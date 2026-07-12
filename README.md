# steambrite-tax

The complete Ohio sales-tax stack for Steambrite, in one self-maintaining repo.

It computes **exact** Ohio sales-tax rates (state + county + transit district) from
the Ohio Department of Taxation's official **"The Finder"** Streamlined Sales Tax
files — no paid APIs, no guessing. Once the one-time setup below is done, the
whole thing keeps itself current with **zero quarterly work**.

## What's in here

| Folder | What it is |
|---|---|
| `backend/` | The `tax.steambrite.us` server (Express). Serves exact Ohio rates from official Finder data via `/api/lookup`, self-refreshes its data daily, and falls back to Gemini for non-Ohio addresses. Deploys to Cloud Run. |
| `pipeline/` | `build.js` downloads Ohio's Finder boundary + rate files and compiles them into `ohio-tax-data.min.json` + per-ZIP address shards. `verify.js` cross-checks the result against the state's own rate report. |
| `extension/` | The Chrome (MV3) extension that suggests the exact county+transit and the matching Jobber tax group for addresses on Jobber pages. |
| `docs/` | Background: the rebuild plan and the Jobber tax-cleanup notes. |
| `.github/workflows/refresh-data.yml` | Quarterly GitHub Action that re-runs the pipeline and publishes fresh data to GitHub Pages. |

## How it all fits together

```
                    ┌───────────────────────────────────────────────┐
                    │  Ohio Dept. of Taxation — "The Finder" files   │
                    └───────────────────────┬───────────────────────┘
                                            │ (quarterly)
                          GitHub Action ► node pipeline/build.js --fresh
                                            │
                                            ▼
                        GitHub Pages: ohio-tax-data.min.json + addr-shards/
                                            │
                     ┌──────────────────────┴───────────────────────┐
                     ▼                                               ▼
          backend (Cloud Run)                             Chrome extension
   re-fetches the data every 24h                   re-fetches the data every 3 days
   /api/lookup → exact OH rate                     shows county+transit + Jobber group
```

Both the backend and the extension **ship with a bundled copy** of the data, so
they work immediately and degrade gracefully if the hosted copy is ever
unreachable. Each just fetches the hosted copy periodically and upgrades itself
when a newer quarter appears.

---

## ONE-TIME SETUP

Do these once. After that, nothing needs manual quarterly attention.

### 1. Publish this repo (GitHub Desktop)

1. Open **GitHub Desktop → File → Add local repository** and choose this
   `steambrite-tax` folder. (A git repo with an initial commit already exists.)
2. Click **Publish repository**. Keep it **public** and name it `steambrite-tax`.

### 2. Turn on GitHub Pages + run the data build once

1. On GitHub: **repo → Settings → Pages → Build and deployment → Source = "GitHub Actions"**.
2. Go to the **Actions** tab → **"Refresh Ohio tax data"** → **Run workflow**
   (on `main`). Let it finish (it downloads the state files, builds the data,
   and deploys to Pages — a few minutes).
3. Note the published **Pages URL**. It will be:
   `https://<your-github-username>.github.io/steambrite-tax/`
   - Data file: `https://<your-github-username>.github.io/steambrite-tax/ohio-tax-data.min.json`
   - Shards:    `https://<your-github-username>.github.io/steambrite-tax/addr-shards`

### 3. Point Cloud Run at this repo

1. Google Cloud Console → **Cloud Run → your `sales-tax-calculator-v2` service → Edit & deploy new revision / Edit repo settings**.
2. **Disconnect** the old connected repo and **connect** `steambrite-tax` instead.
3. Set the **build context / source directory to `backend/`** (buildpacks; a
   `package.json` is present, so it builds the frontend with `npm run build` and
   starts with `npm start`).
4. (Optional) Set env vars so the backend reads the fresh data from your Pages URL
   instead of the Google Cloud Storage defaults:
   - `DATA_URL = https://<your-github-username>.github.io/steambrite-tax/ohio-tax-data.min.json`
   - `SHARD_BASE_URL = https://<your-github-username>.github.io/steambrite-tax/addr-shards`
   - `GEMINI_API_KEY = <key>` — **only** needed if you want non-Ohio lookups. Without
     it, non-Ohio addresses return HTTP 422 (Ohio lookups never need it).

   Leaving these unset keeps the current GCS defaults, which is fine.

From now on, **every push to `main` auto-deploys the backend.**

### 4. Point the extension at the Pages data (optional, no reinstall)

The extension already ships with `https://*.github.io/*` host permission, so you
can switch it to your Pages data **without reinstalling**:

1. Load/keep the extension from `extension/` (Chrome → Extensions → Load unpacked),
   or use your published build.
2. Open the extension's **Options** and set:
   - **Data URL** = `https://<your-github-username>.github.io/steambrite-tax/ohio-tax-data.min.json`
   - **Shard base URL** = `https://<your-github-username>.github.io/steambrite-tax/addr-shards`
3. Click **Check for updates**. It should report the current data version.

Leaving these at their GCS defaults also works.

---

## How it stays current

Ohio only changes sales-tax rates on **quarter boundaries** (Jan 1 / Apr 1 / Jul 1 / Oct 1).

- **Quarterly GitHub Action** — On the 2nd of Jan/Apr/Jul/Oct (and on demand, and
  on any push that touches `pipeline/**`), the Action re-downloads the state files,
  rebuilds the data, verifies it against Ohio's own rate report, and publishes it
  to GitHub Pages. `build.js` uses the **current date** as its effective-date
  filter, so it always picks up whichever quarter is live when it runs.
- **Backend re-fetches daily** — On boot and every 24h the backend fetches
  `DATA_URL` and hot-swaps to a newer quarter in memory. Fetch failures are
  non-fatal: it keeps serving the last-known-good data (bundled snapshot at worst).
- **Extension re-fetches every 3 days** — The MV3 service worker checks the data
  URL on an alarm and upgrades itself when a newer version appears.

So after the one-time setup: the Action refreshes the source of truth each
quarter, and both consumers pull it in automatically. No manual steps.

## Local development

```bash
# Backend
cd backend
npm install
npm run dev            # http://localhost:3000  (Vite dev middleware + API)

# Rebuild the data locally (needs curl + unzip; downloads ~48MB to pipeline/raw)
cd pipeline
node build.js --fresh  # writes pipeline/dist/… and prints a verification summary
```

See `backend/TESTING.md` for the recorded `/api/lookup` smoke-test results.
