/*
 * background.js — MV3 service worker.
 * Owns ALL lookups, caching, and data refresh. Popup and content script are thin:
 * they send addresses here and render whatever comes back.
 */
importScripts('lib/normalize.js', 'lib/resolver.js');

const N = self.TaxExtNormalize;
const R = self.TaxExtResolver;

// Data + shards are published to GitHub Pages by the repo's quarterly Action.
// (Manual fallback if Pages is ever down: the GCS bucket
// https://storage.googleapis.com/tax-rate-calculator-assets/… — see README.)
const DEFAULT_CONFIG = {
  dataUrl: 'https://jefe2332.github.io/steambrite-tax/ohio-tax-data.min.json',
  shardBaseUrl: 'https://jefe2332.github.io/steambrite-tax/addr-shards',
  backendUrl: 'https://tax.steambrite.us'
};

const DATA_ALARM = 'taxDataRefresh';
const DATA_ALARM_PERIOD_MIN = 3 * 24 * 60; // every 3 days
const LOOKUP_TTL_MS = 24 * 60 * 60 * 1000; // storage.local fallback TTL
const SHARD_NEG_TTL_MS = 6 * 60 * 60 * 1000; // re-try missing shards after 6h
const MAX_LOCAL_LOOKUPS = 200;
const MAX_CACHED_SHARDS = 40;

const fetchJson = R.makeFetchJson(fetch.bind(self), 8000);

/* ------------------------------ config ------------------------------ */

async function getConfig() {
  try {
    const st = await chrome.storage.sync.get('config');
    return Object.assign({}, DEFAULT_CONFIG, st.config || {});
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

async function getLabelOverrides() {
  try {
    const st = await chrome.storage.sync.get('labelOverrides');
    return st.labelOverrides || {};
  } catch (e) {
    return {};
  }
}

/* ---------------------------- data manager --------------------------- */

let memData = null; // { data, source: 'bundled'|'remote' }

function versionScore(v) {
  const m = /^(\d{4})Q(\d)$/.exec(String(v || ''));
  return m ? (+m[1] * 10 + +m[2]) : 0;
}

function looksLikeTaxData(j) {
  return j && j.meta && j.meta.version && typeof j.stateRate === 'number' && j.zip5 && j.counties;
}

async function loadBundledData() {
  const res = await fetch(chrome.runtime.getURL('data/ohio-tax-data.json'));
  return res.json();
}

async function ensureData() {
  if (memData) return memData;
  const bundled = await loadBundledData();
  let remote = null;
  try {
    const st = await chrome.storage.local.get('remoteTaxData');
    if (st.remoteTaxData && looksLikeTaxData(st.remoteTaxData.json)) remote = st.remoteTaxData.json;
  } catch (e) { /* fall through to bundled */ }

  let pick = { data: bundled, source: 'bundled' };
  if (remote) {
    const rs = versionScore(remote.meta.version);
    const bs = versionScore(bundled.meta.version);
    if (rs > bs || (rs === bs && String(remote.meta.generatedAt || '') > String(bundled.meta.generatedAt || ''))) {
      pick = { data: remote, source: 'remote' };
    }
  }
  memData = pick;
  return memData;
}

async function checkForDataUpdate(manual) {
  const cfg = await getConfig();
  const current = await ensureData();
  const status = { at: Date.now(), ok: false, action: 'none', version: current.data.meta.version, error: null };
  try {
    const j = await fetchJson(cfg.dataUrl, { timeoutMs: 20000, retries: manual ? 1 : 0 });
    if (!looksLikeTaxData(j)) {
      status.error = 'Fetched file is not a tax data file';
    } else {
      status.ok = true;
      const ns = versionScore(j.meta.version);
      const cs = versionScore(current.data.meta.version);
      const newer = ns > cs || (ns === cs && String(j.meta.generatedAt || '') > String(current.data.meta.generatedAt || ''));
      if (newer) {
        await chrome.storage.local.set({ remoteTaxData: { json: j, fetchedAt: Date.now(), url: cfg.dataUrl } });
        memData = { data: j, source: 'remote' };
        status.action = 'updated';
        status.version = j.meta.version;
      } else {
        status.action = 'up-to-date';
        status.remoteVersion = j.meta.version;
      }
    }
  } catch (err) {
    // 404 (hosting not set up yet) and network failures are non-fatal and quiet.
    status.error = err.cause || 'error';
    status.errorMessage = err.message;
  }
  try { await chrome.storage.local.set({ lastDataCheck: status }); } catch (e) { }
  return status;
}

/* --------------------------- lookup caching -------------------------- */

const hasSession = !!(chrome.storage && chrome.storage.session);

async function cacheGet(key) {
  if (hasSession) {
    try {
      const o = await chrome.storage.session.get(key);
      if (o && o[key] !== undefined) return o[key];
      return undefined;
    } catch (e) { /* fall through */ }
  }
  try {
    const o = await chrome.storage.local.get('lookupCacheV1');
    const entry = (o.lookupCacheV1 || {})[key];
    if (entry && Date.now() - entry.at < LOOKUP_TTL_MS) return entry.v;
  } catch (e) { }
  return undefined;
}

async function cacheSet(key, val) {
  if (hasSession) {
    try { await chrome.storage.session.set({ [key]: val }); return; } catch (e) { /* fall through */ }
  }
  try {
    const o = await chrome.storage.local.get('lookupCacheV1');
    const cache = o.lookupCacheV1 || {};
    cache[key] = { at: Date.now(), v: val };
    const keys = Object.keys(cache);
    if (keys.length > MAX_LOCAL_LOOKUPS) {
      keys.sort((a, b) => cache[a].at - cache[b].at)
        .slice(0, keys.length - MAX_LOCAL_LOOKUPS)
        .forEach(k => delete cache[k]);
    }
    await chrome.storage.local.set({ lookupCacheV1: cache });
  } catch (e) { }
}

/* --------------------------- addr shards ----------------------------- */

async function getShard(zip5, dataVersion) {
  const cfg = await getConfig();
  if (!cfg.shardBaseUrl) return null;
  const cacheKey = 'shardCacheV1';
  let cache = {};
  try {
    const o = await chrome.storage.local.get(cacheKey);
    cache = o[cacheKey] || {};
  } catch (e) { }

  const entry = cache[zip5];
  if (entry && entry.v === dataVersion) {
    if (entry.addr) return { addr: entry.addr, streets: entry.streets || null };
    if (entry.notFound && Date.now() - entry.at < SHARD_NEG_TTL_MS) return null;
  }

  const url = cfg.shardBaseUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(zip5) + '.json';
  let record;
  try {
    const j = await fetchJson(url);
    if (j && Array.isArray(j.addr)) {
      // keep `streets` — the resolver uses the ZIP's street directory to
      // answer known-street-no-override (default, exact) vs unknown street
      record = {
        v: dataVersion, addr: j.addr,
        streets: Array.isArray(j.streets) ? j.streets : null,
        at: Date.now()
      };
    } else {
      record = { v: dataVersion, notFound: true, at: Date.now() };
    }
  } catch (err) {
    // 404 = shard not hosted (yet); network error = offline. Both: unavailable.
    record = { v: dataVersion, notFound: true, at: Date.now() };
  }

  try {
    cache[zip5] = record;
    const zips = Object.keys(cache);
    if (zips.length > MAX_CACHED_SHARDS) {
      zips.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0))
        .slice(0, zips.length - MAX_CACHED_SHARDS)
        .forEach(z => delete cache[z]);
    }
    await chrome.storage.local.set({ [cacheKey]: cache });
  } catch (e) { }

  return record.addr ? { addr: record.addr, streets: record.streets || null } : null;
}

/* ----------------------------- resolver ------------------------------ */

const resolver = R.createResolver({
  getData: ensureData,
  fetchJson: fetchJson,
  cacheGet: cacheGet,
  cacheSet: cacheSet,
  getShard: getShard,
  getConfig: getConfig,
  getLabelOverrides: getLabelOverrides
});

async function handleResolveAddresses(addresses) {
  const got = await ensureData();
  const results = await Promise.all((addresses || []).map(async (a) => {
    try {
      const r = await resolver.resolve(a);
      return Object.assign({ addressId: a.id || null, key: a.key || null, input: a }, r);
    } catch (err) {
      return {
        addressId: a.id || null, key: a.key || null, input: a,
        status: 'failed', reason: 'exception',
        message: err && err.message ? err.message : String(err)
      };
    }
  }));
  return { ok: true, results, dataVersion: got.data.meta.version, dataSource: got.source };
}

async function handleGetStatus() {
  const got = await ensureData();
  let lastCheck = null;
  try {
    const o = await chrome.storage.local.get('lastDataCheck');
    lastCheck = o.lastDataCheck || null;
  } catch (e) { }
  const cfg = await getConfig();
  return {
    ok: true,
    dataVersion: got.data.meta.version,
    dataSource: got.source,
    effectiveDate: got.data.meta.effectiveDate || null,
    generatedAt: got.data.meta.generatedAt || null,
    lastCheck,
    config: cfg
  };
}

async function handleGetCombos() {
  const got = await ensureData();
  const data = got.data;
  const overrides = await getLabelOverrides();
  const combos = (data.jobberCombos || []).map(jc => {
    const comboKey = jc.countyFips + '|' + (jc.transitFips || '');
    const nameKey = jc.county + '|' + (jc.transit || '');
    const builtin = R.HARDCODED_LABELS[nameKey] || null;
    return {
      comboKey,
      county: jc.county,
      transit: jc.transit,
      total: jc.total,
      totalPct: N.pctString(jc.total),
      dataLabel: jc.label,
      builtinLabel: builtin,
      defaultLabel: builtin || jc.label,
      override: overrides[comboKey] || '',
      mapped: !!(builtin || overrides[comboKey])
    };
  });
  return { ok: true, combos, dataVersion: data.meta.version, dataSource: got.source };
}

/* ----------------------------- messaging ----------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fail = (err) => sendResponse({
    ok: false,
    error: { message: err && err.message ? err.message : String(err), cause: err && err.cause ? err.cause : 'error' }
  });
  try {
    if (msg && msg.type === 'RESOLVE_ADDRESSES') {
      handleResolveAddresses(msg.addresses).then(sendResponse, fail);
      return true;
    }
    if (msg && msg.type === 'GET_STATUS') {
      handleGetStatus().then(sendResponse, fail);
      return true;
    }
    if (msg && msg.type === 'GET_COMBOS') {
      handleGetCombos().then(sendResponse, fail);
      return true;
    }
    if (msg && msg.type === 'CHECK_DATA_UPDATE') {
      checkForDataUpdate(true).then(s => sendResponse({ ok: true, status: s }), fail);
      return true;
    }
  } catch (err) {
    fail(err);
  }
  return false;
});

/* ----------------------------- lifecycle ----------------------------- */

function setupAlarm() {
  try {
    chrome.alarms.create(DATA_ALARM, { periodInMinutes: DATA_ALARM_PERIOD_MIN, delayInMinutes: 2 });
  } catch (e) { }
}

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
  checkForDataUpdate(false).catch(() => { });
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DATA_ALARM) checkForDataUpdate(false).catch(() => { });
});
