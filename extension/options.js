/*
 * options.js — endpoints, data status/update, and Jobber label-mapping editor.
 * All DOM via createElement/textContent — no innerHTML with dynamic strings.
 */
'use strict';

// Keep in sync with DEFAULT_CONFIG in background.js. GitHub Pages is the
// primary host; the GCS bucket remains a documented manual fallback.
const DEFAULTS = {
  dataUrl: 'https://jefe2332.github.io/steambrite-tax/ohio-tax-data.min.json',
  shardBaseUrl: 'https://jefe2332.github.io/steambrite-tax/addr-shards',
  backendUrl: 'https://tax.steambrite.us'
};

// Keep in sync with DEFAULT_SKIP_PATHS in lib/scan-core.js.
const DEFAULT_SKIP_PATHS = ['/clients', '/requests', '/quotes', '/jobs', '/invoices'];

document.addEventListener('DOMContentLoaded', () => {
  const dataUrlInput = document.getElementById('dataUrl');
  const shardBaseUrlInput = document.getElementById('shardBaseUrl');
  const backendUrlInput = document.getElementById('backendUrl');
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const configStatus = document.getElementById('configStatus');
  const dataStatusEl = document.getElementById('dataStatus');
  const checkUpdateBtn = document.getElementById('checkUpdateBtn');
  const checkResult = document.getElementById('checkResult');
  const skipPathsInput = document.getElementById('skipPaths');
  const saveSkipPathsBtn = document.getElementById('saveSkipPathsBtn');
  const resetSkipPathsBtn = document.getElementById('resetSkipPathsBtn');
  const skipPathsStatus = document.getElementById('skipPathsStatus');
  const labelTableBody = document.getElementById('labelTableBody');
  const saveLabelsBtn = document.getElementById('saveLabelsBtn');
  const resetLabelsBtn = document.getElementById('resetLabelsBtn');
  const labelStatus = document.getElementById('labelStatus');

  let comboRows = []; // [{comboKey, input}]

  loadConfig();
  loadSkipPaths();
  loadDataStatus();
  loadCombos();

  /* ----------------------------- config ------------------------------ */

  function loadConfig() {
    chrome.storage.sync.get('config', (st) => {
      if (chrome.runtime.lastError) return;
      const cfg = Object.assign({}, DEFAULTS, (st && st.config) || {});
      dataUrlInput.value = cfg.dataUrl;
      shardBaseUrlInput.value = cfg.shardBaseUrl;
      backendUrlInput.value = cfg.backendUrl;
    });
  }

  saveConfigBtn.addEventListener('click', () => {
    const cfg = {
      dataUrl: dataUrlInput.value.trim() || DEFAULTS.dataUrl,
      shardBaseUrl: shardBaseUrlInput.value.trim() || DEFAULTS.shardBaseUrl,
      backendUrl: backendUrlInput.value.trim() || DEFAULTS.backendUrl
    };
    chrome.storage.sync.set({ config: cfg }, () => {
      if (chrome.runtime.lastError) {
        flash(configStatus, 'Save failed: ' + chrome.runtime.lastError.message, true);
        return;
      }
      flash(configStatus, 'Saved');
    });
  });

  /* --------------------------- skipped pages -------------------------- */

  function linesToPaths(text) {
    return String(text || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
  }

  function loadSkipPaths() {
    chrome.storage.sync.get('skipPaths', (st) => {
      if (chrome.runtime.lastError) return;
      const paths = st && Array.isArray(st.skipPaths) ? st.skipPaths : DEFAULT_SKIP_PATHS;
      skipPathsInput.value = paths.join('\n');
    });
  }

  saveSkipPathsBtn.addEventListener('click', () => {
    const paths = linesToPaths(skipPathsInput.value);
    chrome.storage.sync.set({ skipPaths: paths }, () => {
      if (chrome.runtime.lastError) {
        flash(skipPathsStatus, 'Save failed: ' + chrome.runtime.lastError.message, true);
        return;
      }
      skipPathsInput.value = paths.join('\n');
      flash(skipPathsStatus, paths.length ? 'Saved ' + paths.length + ' path(s)' : 'Saved (nothing skipped)');
    });
  });

  resetSkipPathsBtn.addEventListener('click', () => {
    chrome.storage.sync.set({ skipPaths: DEFAULT_SKIP_PATHS.slice() }, () => {
      if (chrome.runtime.lastError) {
        flash(skipPathsStatus, 'Reset failed: ' + chrome.runtime.lastError.message, true);
        return;
      }
      skipPathsInput.value = DEFAULT_SKIP_PATHS.join('\n');
      flash(skipPathsStatus, 'Reset to defaults');
    });
  });

  /* --------------------------- data status --------------------------- */

  function loadDataStatus() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        dataStatusEl.textContent = 'Status unavailable' +
          (chrome.runtime.lastError ? ' (' + chrome.runtime.lastError.message + ')' : '');
        return;
      }
      while (dataStatusEl.firstChild) dataStatusEl.removeChild(dataStatusEl.firstChild);
      const lines = [];
      lines.push('Active data version: ' + resp.dataVersion + ' — source: ' +
        (resp.dataSource === 'bundled' ? 'bundled with extension' : 'downloaded update'));
      if (resp.effectiveDate) lines.push('Effective date: ' + resp.effectiveDate);
      if (resp.lastCheck && resp.lastCheck.at) {
        const d = new Date(resp.lastCheck.at);
        let s = 'Last update check: ' + d.toLocaleString() + ' — ';
        if (resp.lastCheck.ok) {
          s += resp.lastCheck.action === 'updated'
            ? 'downloaded new version ' + resp.lastCheck.version
            : 'already up to date';
        } else {
          s += 'not available (' + (resp.lastCheck.error || 'error') + ')';
        }
        lines.push(s);
      } else {
        lines.push('Last update check: never');
      }
      lines.forEach(t => {
        const div = document.createElement('div');
        div.textContent = t;
        dataStatusEl.appendChild(div);
      });
    });
  }

  checkUpdateBtn.addEventListener('click', () => {
    checkUpdateBtn.disabled = true;
    checkResult.textContent = 'Checking…';
    checkResult.classList.remove('error');
    chrome.runtime.sendMessage({ type: 'CHECK_DATA_UPDATE' }, (resp) => {
      checkUpdateBtn.disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        checkResult.textContent = 'Check failed' +
          (chrome.runtime.lastError ? ': ' + chrome.runtime.lastError.message : '');
        checkResult.classList.add('error');
        return;
      }
      const s = resp.status;
      if (s.ok && s.action === 'updated') {
        checkResult.textContent = 'Updated to ' + s.version;
      } else if (s.ok) {
        checkResult.textContent = 'Already up to date (' + s.version + ')';
      } else if (s.error === 'http_404') {
        checkResult.textContent = 'Hosted data not published yet (404) — using ' + s.version;
      } else {
        checkResult.textContent = 'Could not reach data host (' + (s.error || 'error') + ') — using ' + s.version;
        checkResult.classList.add('error');
      }
      loadDataStatus();
    });
  });

  /* --------------------------- label mapping -------------------------- */

  function loadCombos() {
    chrome.runtime.sendMessage({ type: 'GET_COMBOS' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = 'Could not load jurisdiction list' +
          (chrome.runtime.lastError ? ' (' + chrome.runtime.lastError.message + ')' : '');
        tr.appendChild(td);
        labelTableBody.appendChild(tr);
        return;
      }
      while (labelTableBody.firstChild) labelTableBody.removeChild(labelTableBody.firstChild);
      comboRows = [];

      // mapped (business) combos first, then the rest alphabetically
      const combos = resp.combos.slice().sort((a, b) => {
        if (a.mapped !== b.mapped) return a.mapped ? -1 : 1;
        return (a.county + (a.transit || '')).localeCompare(b.county + (b.transit || ''));
      });

      combos.forEach(c => {
        const tr = document.createElement('tr');
        if (!c.mapped) tr.className = 'unmapped';

        const tdCounty = document.createElement('td');
        tdCounty.textContent = c.county;
        if (!c.mapped) {
          const tag = document.createElement('span');
          tag.className = 'unmapped-tag';
          tag.textContent = 'unmapped';
          tdCounty.appendChild(tag);
        }
        const tdTransit = document.createElement('td');
        tdTransit.textContent = c.transit || '—';
        const tdRate = document.createElement('td');
        tdRate.textContent = c.totalPct + '%';
        const tdDefault = document.createElement('td');
        tdDefault.textContent = c.defaultLabel;
        const tdOverride = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.value = c.override || '';
        input.placeholder = c.defaultLabel;
        tdOverride.appendChild(input);

        tr.append(tdCounty, tdTransit, tdRate, tdDefault, tdOverride);
        labelTableBody.appendChild(tr);
        comboRows.push({ comboKey: c.comboKey, input });
      });
    });
  }

  saveLabelsBtn.addEventListener('click', () => {
    const overrides = {};
    comboRows.forEach(r => {
      const v = r.input.value.trim();
      if (v) overrides[r.comboKey] = v;
    });
    chrome.storage.sync.set({ labelOverrides: overrides }, () => {
      if (chrome.runtime.lastError) {
        flash(labelStatus, 'Save failed: ' + chrome.runtime.lastError.message, true);
        return;
      }
      flash(labelStatus, 'Saved ' + Object.keys(overrides).length + ' override(s)');
    });
  });

  resetLabelsBtn.addEventListener('click', () => {
    chrome.storage.sync.set({ labelOverrides: {} }, () => {
      if (chrome.runtime.lastError) {
        flash(labelStatus, 'Reset failed: ' + chrome.runtime.lastError.message, true);
        return;
      }
      comboRows.forEach(r => { r.input.value = ''; });
      flash(labelStatus, 'All overrides cleared');
    });
  });

  function flash(el, text, isError) {
    el.textContent = text;
    el.classList.toggle('error', !!isError);
    setTimeout(() => { el.textContent = ''; }, 2500);
  }
});
