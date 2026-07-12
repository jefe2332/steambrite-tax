# Operator setup runbook

One-time deployment steps for this stack. After these, nothing needs manual quarterly attention; see "How it stays current" at the bottom.

## 1. Publish the repo

1. GitHub Desktop → **File → Add local repository** → choose the `steambrite-tax` folder.
2. **Publish repository**, keep it **public** (GitHub Pages on the free plan requires a public repo), name `steambrite-tax`.

## 2. Enable GitHub Pages + first data build

1. Repo → **Settings → Pages → Build and deployment → Source = "GitHub Actions"**.
2. **Actions** tab → **"Refresh Ohio tax data"** → **Run workflow** on `main`. It downloads the state files, builds and verifies the dataset, and deploys to Pages (a few minutes).
3. The published data lands at:
   - `https://<username>.github.io/steambrite-tax/ohio-tax-data.min.json`
   - `https://<username>.github.io/steambrite-tax/addr-shards/<zip5>.json`

## 3. Cloud Run continuous deployment

1. Cloud Console → **Cloud Run** → the tax service → **Edit repo settings** (or "Set up continuous deployment").
2. Connect `steambrite-tax` (grant the Cloud Build GitHub App access to it if it isn't listed), branch `main`.
3. Build type: **Google Cloud buildpacks**. Then set **Build context directory: `/backend`** (this is the critical field).
4. Save. The first build deploys immediately; afterwards every push to `main` auto-deploys.

Optional env vars on the service:

| Var | Purpose |
|---|---|
| `DATA_URL` | Override the data source. Default is the GitHub Pages URL baked into `server.js`; the legacy GCS bucket works as a manual fallback host. |
| `SHARD_BASE_URL` | Same, for the per-ZIP street shards. |
| `GEMINI_API_KEY` | Only needed for non-Ohio lookups (they return HTTP 422 without it). Ohio lookups never touch it. |

## 4. Extension rollout (side-loaded team)

1. Each user: `chrome://extensions` → Developer mode → **Load unpacked** → the `extension/` folder (or unzip the distributed archive to a permanent folder first).
2. No configuration needed: the Pages data URLs are the extension's built-in defaults (since v2.0.2), and data self-updates every ~3 days via `chrome.alarms`. The Options page can override the data/shard/backend URLs and the Jobber tax-group label mapping.
3. Code updates require redistributing the folder/zip (side-loaded extensions don't auto-update). Consider a $5 unlisted Chrome Web Store listing if that ever gets old.

## How it stays current

Ohio rate changes only take effect on quarter boundaries (Jan 1 / Apr 1 / Jul 1 / Oct 1, with 65-day statutory notice).

- **Quarterly GitHub Action** (2nd of Jan/Apr/Jul/Oct, plus on demand, plus any push touching `pipeline/**`): re-downloads the state files, rebuilds, verifies all 88 county totals against the state's published report, publishes to Pages. `build.js` filters by the current date, so it always picks up whichever quarter is live.
- **Backend**: fetches `DATA_URL` on boot and every 24 h; hot-swaps newer data in memory; fetch failures are non-fatal (keeps last-known-good, bundled snapshot at worst).
- **Extension**: service-worker alarm checks the data URL every 3 days and upgrades when a newer version appears.

## Verification

`backend/TESTING.md` records the API smoke tests. The pipeline's `VERIFICATION.md` (regenerated each build) records the 13-group check suite, including split-district spot checks (Franklin 8.00% everywhere; Delaware 7.00/8.00; Licking 7.25/8.25; Fairfield 6.75/7.75; Union 7.00/8.00) and multi-county ZIP resolution cases (43082, 43068, 43004).
