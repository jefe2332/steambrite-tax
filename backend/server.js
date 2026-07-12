import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import rateLimit from "express-rate-limit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The resolver + normalizer are UMD CommonJS modules shared verbatim with the
// Chrome extension. Load them via createRequire so this ESM file can consume them.
const require = createRequire(import.meta.url);
const R = require("./lib/resolver.js");
const N = require("./lib/normalize.js");

/* =========================================================================
 * DATA LAYER
 * Boot from the bundled snapshot (backend/data/ohio-tax-data.json), then try
 * DATA_URL immediately and every 24h. Keep the newest meta.version in memory.
 * Never crash on a fetch failure — log and keep whatever we already have.
 * ========================================================================= */

const DATA_URL =
  process.env.DATA_URL ||
  "https://storage.googleapis.com/tax-rate-calculator-assets/ohio-tax-data.min.json";
const SHARD_BASE_URL =
  process.env.SHARD_BASE_URL ||
  "https://storage.googleapis.com/tax-rate-calculator-assets/addr-shards";
const DATA_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h

const fetchJson = R.makeFetchJson(fetch, 8000);

function looksLikeTaxData(j) {
  return (
    j &&
    j.meta &&
    j.meta.version &&
    typeof j.stateRate === "number" &&
    j.zip5 &&
    j.counties
  );
}

function versionScore(v) {
  const m = /^(\d{4})Q(\d)$/.exec(String(v || ""));
  return m ? +m[1] * 10 + +m[2] : 0;
}

// { data, source: 'bundled' | 'remote' }
let memData = null;

function loadBundledData() {
  const p = path.join(__dirname, "data", "ohio-tax-data.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!looksLikeTaxData(j)) throw new Error("bundled ohio-tax-data.json is not valid tax data");
  return j;
}

async function refreshData(reason) {
  try {
    const j = await fetchJson(DATA_URL, { timeoutMs: 20000, retries: 1 });
    if (!looksLikeTaxData(j)) {
      console.warn(`[data] ${reason}: fetched ${DATA_URL} but it is not a tax-data file — keeping ${memData.data.meta.version}`);
      return;
    }
    const ns = versionScore(j.meta.version);
    const cs = versionScore(memData.data.meta.version);
    const newer =
      ns > cs ||
      (ns === cs &&
        String(j.meta.generatedAt || "") > String(memData.data.meta.generatedAt || ""));
    if (newer) {
      memData = { data: j, source: "remote" };
      console.log(`[data] ${reason}: updated to ${j.meta.version} (remote)`);
    } else {
      console.log(`[data] ${reason}: remote ${j.meta.version} not newer than ${memData.data.meta.version} — keeping current`);
    }
  } catch (err) {
    // 404 (Pages not live yet) and network failures are non-fatal and quiet-ish.
    console.warn(`[data] ${reason}: fetch failed (${(err && err.cause) || "error"}: ${err && err.message}) — keeping ${memData.data.meta.version}`);
  }
}

// getData() for the resolver: always resolves to the in-memory snapshot.
async function getData() {
  return memData;
}

/* --------------------------- addr shards ----------------------------- */
// In-memory shard cache keyed by "<version>:<zip5>". Value is {addr:[...]}|null.
const shardCache = new Map();
const MAX_CACHED_SHARDS = 200;

async function getShard(zip5, dataVersion) {
  if (!SHARD_BASE_URL) return null;
  const key = (dataVersion || "?") + ":" + zip5;
  if (shardCache.has(key)) return shardCache.get(key);

  const url = SHARD_BASE_URL.replace(/\/+$/, "") + "/" + encodeURIComponent(zip5) + ".json";
  let result = null;
  try {
    const j = await fetchJson(url);
    if (j && Array.isArray(j.addr)) result = { addr: j.addr };
  } catch (err) {
    // 404 = shard not hosted; network error = offline. Both -> unavailable.
    result = null;
  }
  shardCache.set(key, result);
  if (shardCache.size > MAX_CACHED_SHARDS) {
    // drop oldest inserted key
    shardCache.delete(shardCache.keys().next().value);
  }
  return result;
}

/* --------------------------- lookup cache ---------------------------- */
// Simple in-memory, size-capped result cache (session-scoped, like the extension).
const lookupCache = new Map();
const MAX_LOOKUPS = 500;

async function cacheGet(key) {
  return lookupCache.get(key);
}
async function cacheSet(key, val) {
  lookupCache.set(key, val);
  if (lookupCache.size > MAX_LOOKUPS) {
    lookupCache.delete(lookupCache.keys().next().value);
  }
}

/* ----------------------------- resolver ------------------------------ */
// getConfig() returns NO backendUrl on purpose: THIS is the backend, so the
// resolver's own "legacy backend estimate" step is disabled (returns null).
const resolver = R.createResolver({
  getData,
  fetchJson,
  cacheGet,
  cacheSet,
  getShard,
  getConfig: async () => ({}),
  getLabelOverrides: async () => ({}),
});

/* =========================================================================
 * Response mapping — resolver result -> BACKWARD-COMPATIBLE /api/lookup shape
 * ========================================================================= */

const OHIO_SOURCES = [
  { title: "Ohio Dept of Taxation – The Finder", uri: "https://thefinder.tax.ohio.gov/" },
];

function ohioResponse(result, reqCity, reqZip) {
  const districts =
    result.transit && result.transit.rate
      ? [{ name: result.transit.name, rate: result.transit.rate }]
      : [];
  const cityName = reqCity || "";
  const zip = reqZip || "";
  const locationName = cityName
    ? `${cityName}, OH${zip ? " " + zip : ""}`
    : `OH${zip ? " " + zip : ""}`;
  return {
    state: { name: "Ohio", rate: result.stateRate },
    county: {
      name: result.county ? result.county.name : "",
      rate: result.county ? result.county.rate : 0,
    },
    city: { name: cityName, rate: 0 },
    districts,
    totalRate: result.total,
    locationName,
    sources: OHIO_SOURCES,
    isLocalMatch: true,
    confidence: result.confidence, // 'exact' | 'high' | 'verify'
  };
}

/* =========================================================================
 * Gemini fallback (NON-OHIO ONLY)
 * ========================================================================= */

const extractJson = (text) => {
  if (!text || typeof text !== "string") return null;
  let cleaned = text.replace(/\[\d+\]/g, "").trim();
  cleaned = cleaned.replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    const startObj = cleaned.indexOf("{");
    const startArr = cleaned.indexOf("[");
    let startIndex = -1;
    if (startObj !== -1 && (startArr === -1 || startObj < startArr)) startIndex = startObj;
    else if (startArr !== -1) startIndex = startArr;
    if (startIndex !== -1) {
      const endChar = cleaned[startIndex] === "{" ? "}" : "]";
      const endIndex = cleaned.lastIndexOf(endChar);
      if (endIndex !== -1) return JSON.parse(cleaned.substring(startIndex, endIndex + 1));
    }
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
};

// Every rate must be a sane fraction, and the pieces must sum to totalRate.
function validParsedRates(d) {
  if (!d || typeof d.totalRate !== "number") return false;
  const rates = [];
  const pushRate = (r) => {
    if (typeof r === "number") rates.push(r);
  };
  if (d.state) pushRate(d.state.rate);
  if (d.county) pushRate(d.county.rate);
  if (d.city) pushRate(d.city.rate);
  (d.districts || []).forEach((x) => pushRate(x && x.rate));
  pushRate(d.totalRate);
  for (const r of rates) {
    if (!(r >= 0 && r < 0.2)) return false;
  }
  const sum =
    (d.state && d.state.rate ? d.state.rate : 0) +
    (d.county && d.county.rate ? d.county.rate : 0) +
    (d.city && d.city.rate ? d.city.rate : 0) +
    (d.districts || []).reduce((a, x) => a + (x && x.rate ? x.rate : 0), 0);
  if (Math.abs(sum - d.totalRate) > 0.001) return false;
  return true;
}

async function geminiLookup(address) {
  // Lazy import so an Ohio-only deployment never needs the @google/genai package.
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Find the current sales tax rate breakdown for the address: ${address.street}, ${address.city}, ${address.zip}, ${address.state}. Return valid JSON: {state:{name,rate}, county:{name,rate}, city:{name,rate}, districts:[{name,rate}], totalRate, locationName}. Use decimal format (0.07 for 7%).`,
    config: {
      thinkingConfig: { thinkingBudget: 0 },
      tools: [{ googleSearch: {} }],
    },
  });

  const parsed = extractJson(response.text || "");
  if (!parsed) throw new Error("Invalid tax response");
  if (!validParsedRates(parsed)) throw new Error("Parsed tax rates failed sanity validation");

  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = [];
  chunks.forEach((chunk) => {
    if (chunk.web && chunk.web.uri) sources.push({ title: chunk.web.title || "Tax Reference", uri: chunk.web.uri });
    if (chunk.maps && chunk.maps.uri) sources.push({ title: chunk.maps.title || "Location Reference", uri: chunk.maps.uri });
  });

  return {
    ...parsed,
    sources: sources.length > 0 ? sources : [{ title: "Verified Tax Data", uri: "https://www.taxjar.com" }],
    isLocalMatch: false,
  };
}

/* =========================================================================
 * SERVER
 * ========================================================================= */

async function startServer() {
  // Boot the data layer BEFORE listening.
  memData = { data: loadBundledData(), source: "bundled" };
  console.log(`[data] booted from bundled snapshot ${memData.data.meta.version}`);
  refreshData("boot").catch(() => {});
  const refreshTimer = setInterval(() => refreshData("interval").catch(() => {}), DATA_REFRESH_MS);
  if (refreshTimer.unref) refreshTimer.unref();

  const app = express();

  // CRITICAL: Port MUST be 3000 in AI Studio, but Cloud Run injects process.env.PORT (usually 8080)
  const PORT = process.env.PORT || 3000;

  // Default to development unless explicitly set to production.
  const isProd = process.env.NODE_ENV === "production";
  const isSmoke = process.env.SMOKE === "1";

  app.use(express.json());

  app.get("/favicon.ico", (_req, res) => {
    res.redirect("https://storage.googleapis.com/tax-rate-calculator-assets/logo.png");
  });

  // Serve static assets from the public directory FIRST.
  app.use(express.static(path.join(__dirname, "public")));

  // Fix for ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
  app.set("trust proxy", 1);

  // Rate limiter: max 100 requests / 15 min / IP
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests from this IP. Please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
    // Fix for ERR_ERL_FORWARDED_HEADER
    keyGenerator: (req) => req.ip,
    // req.ip is already the real client IP (trust proxy = 1); disable only the
    // spurious IPv6-fallback warning, limiting behavior is unchanged.
    validate: { keyGeneratorIpFallback: false },
  });
  app.use("/api/", apiLimiter);

  // Lightweight status endpoint (handy for monitoring which data version is live).
  app.get("/api/status", (_req, res) => {
    res.json({
      ok: true,
      dataVersion: memData.data.meta.version,
      dataSource: memData.source,
      effectiveDate: memData.data.meta.effectiveDate || null,
      generatedAt: memData.data.meta.generatedAt || null,
      dataUrl: DATA_URL,
      shardBaseUrl: SHARD_BASE_URL,
    });
  });

  /* ------------------------- /api/suggest (unchanged) ------------------ */
  app.post("/api/suggest", async (req, res) => {
    try {
      const { input, mode } = req.body;
      if (!input || input.trim().length < 2) return res.json([]);

      const query = encodeURIComponent(input);
      const searchQuery = mode === "Ohio Only" ? `${query} Ohio` : query;
      const url = `https://nominatim.openstreetmap.org/search?q=${searchQuery}&format=json&addressdetails=1&countrycodes=us&limit=5`;

      const response = await fetch(url, {
        headers: { "User-Agent": "SalesTaxCalculator/1.0" },
      });
      if (!response.ok) throw new Error("Nominatim API failed");
      const data = await response.json();

      const suggestions = data
        .map((item) => {
          const addr = item.address || {};
          const street = addr.house_number ? `${addr.house_number} ${addr.road}` : addr.road || item.name;
          const city = addr.city || addr.town || addr.village || addr.municipality || "";
          const state = addr.state || "";
          const zip = addr.postcode || "";
          return { street, city, state, zip };
        })
        .filter((s) => s.street && s.city && s.state);

      const filtered = suggestions.filter((s) => {
        if (mode === "Ohio Only") {
          const st = (s.state || "").toUpperCase();
          return st === "OH" || st === "OHIO";
        }
        return true;
      });

      res.json(filtered);
    } catch (error) {
      console.error("Suggest Error:", error);
      res.status(500).json({ error: "Failed to get suggestions" });
    }
  });

  /* ------------------------------ /api/lookup -------------------------- */
  app.post("/api/lookup", async (req, res) => {
    try {
      const { address, forceOhio } = req.body || {};
      if (!address) return res.status(400).json({ error: "Missing address" });

      const stateAbbr = N.normalizeState(address.state);
      const isOhio = stateAbbr === "OH" || forceOhio;

      // ---- Ohio: exact resolution via the shared Finder-data resolver ----
      if (isOhio) {
        const result = await resolver.resolve({
          street: address.street || "",
          city: address.city || "",
          state: "OH",
          zip: address.zip || "",
        });

        if (result && result.status === "resolved" && result.county) {
          return res.json(ohioResponse(result, address.city, address.zip));
        }
        // Ohio address we genuinely could not resolve (ZIP not in dataset AND
        // every online source unreachable). Do not fabricate — point to The Finder.
        return res.status(422).json({
          error: "Ohio lookup could not be resolved from official data",
          detail: (result && result.message) || "unresolved",
          finderUrl: (result && result.finderUrl) || "https://thefinder.tax.ohio.gov/",
        });
      }

      // ---- Non-Ohio: Gemini fallback (optional) ----
      if (!process.env.GEMINI_API_KEY) {
        return res.status(422).json({ error: "non-Ohio lookup unavailable" });
      }
      const out = await geminiLookup(address);
      return res.json(out);
    } catch (error) {
      console.error("Lookup Error:", error);
      res.status(500).json({ error: "Failed to lookup tax rates" });
    }
  });

  /* --------------------------- frontend / static ----------------------- */
  const distPath = path.resolve(__dirname, "dist");
  const distExists = fs.existsSync(path.join(distPath, "index.html"));
  // Use the Vite dev middleware only in real dev (not prod, not smoke) and only
  // when there is no built dist to serve. This keeps `SMOKE=1 node server.js`
  // free of Vite so the API can be exercised without a frontend build.
  const useVite = !isProd && !isSmoke && !distExists;

  if (useVite) {
    console.log("Starting in DEVELOPMENT mode with Vite middleware");
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (distExists) {
    console.log(`Serving static frontend from: ${distPath}`);
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    console.log("API-only mode (no dist build present; Vite disabled).");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
