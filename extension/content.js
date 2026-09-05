/*
 * content.js — Jobber page scanner + badge injector.
 * Thin by design: finds addresses, asks the service worker to resolve them,
 * injects "Suggested tax" badges. All DOM built via createElement/textContent —
 * NO innerHTML with dynamic strings anywhere.
 *
 * Rebuilt from v1 with fixes for: Frankenstein field merging, Rails-attr label
 * matching, placeholder select values, name-lines-prepended-to-street, hidden
 * element scanning, weak dedup, stale data-* attributes, innerHTML injection,
 * missing SPA rescan, and unchecked chrome.runtime.lastError.
 */
(function () {
  'use strict';

  // ---- idempotency / self-heal handshake ------------------------------
  // This script can end up in a page more than once:
  //   * the popup self-heals tabs opened BEFORE install by injecting via
  //     chrome.scripting (a manifest-injected copy may already be live);
  //   * reloading the unpacked extension ORPHANS the previous copy — its
  //     chrome.runtime is dead but its DOM listeners/observer keep running.
  // DOM events are shared across isolated worlds, so dispatching this event
  // BEFORE binding anything tells every older copy to shut down; the listener
  // added below lets a FUTURE copy shut THIS one down in turn.
  // Ordering: each copy executes synchronously (dispatch, then bind), so even
  // back-to-back injections leave exactly one live instance — the newest.
  const TEARDOWN_EVENT = 'taxext-teardown';
  try { document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT)); } catch (e) { }

  let dead = false; // set when a newer copy loads; checked in every callback

  const N = self.TaxExtNormalize;
  const S = self.TaxExtScanCore;
  if (!N || !S) {
    // Lib load-order problem (normalize/scan-core must be injected before
    // content.js — the manifest and the popup's executeScript both do this).
    // Log and disable rather than throw.
    try {
      console.warn('[jobber-tax-ext] content.js loaded without lib globals ' +
        '(TaxExtNormalize/TaxExtScanCore missing) — scanner disabled in this frame');
    } catch (e) { }
    return;
  }

  let scanGen = 0;                  // monotonically increasing scan generation
  let lastScanAddresses = [];       // [{id, key, label, street, city, state, zip}]
  const resultCache = new Map();    // addressKey -> resolver result
  const pendingKeys = new Set();    // keys with an in-flight lookup
  let observer = null;
  let debounceTimer = null;
  let suppressObserver = false;
  let skipPaths = S.DEFAULT_SKIP_PATHS.slice(); // list pages: scan nothing there

  function onTeardown() {
    // A newer copy of this script just loaded — this instance must go inert:
    // stop observing, cancel pending rescans, stop answering messages.
    dead = true;
    document.removeEventListener(TEARDOWN_EVENT, onTeardown);
    window.removeEventListener('popstate', onPopState);
    try { if (observer) observer.disconnect(); } catch (e) { }
    observer = null;
    clearTimeout(debounceTimer);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (e) { }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) { }
    // Stale badges/data-tax-ext-* attributes left behind are removed by the
    // NEW instance's cleanupPreviousScan() on its first scan.
  }
  document.addEventListener(TEARDOWN_EVENT, onTeardown);

  /* ------------------------------ utils ------------------------------ */

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    // native check covers display:none, visibility:hidden AND opacity:0 —
    // real Jobber keeps a hidden DECOY [role=dialog] ("opacity-0
    // pointer-events-none") in the DOM whose rect is non-zero
    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch (e) { /* fall through to rect check */ }
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  }

  function getText(el) {
    return el && el.textContent ? el.textContent.trim() : '';
  }

  function lowestCommonAncestor(elements) {
    if (!elements.length) return null;
    let lca = elements[0];
    for (let i = 1; i < elements.length; i++) {
      while (lca && !lca.contains(elements[i])) lca = lca.parentElement;
      if (!lca) return document.body;
    }
    return lca || document.body;
  }

  /* ------------------------- field extraction ------------------------ */

  function findLabelText(input) {
    if (input.id) {
      try {
        const lab = document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
        if (lab) return getText(lab).slice(0, 60);
      } catch (e) { }
    }
    const wrapLabel = input.closest('label');
    if (wrapLabel) return getText(wrapLabel).slice(0, 60);
    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map(id => {
        try { return getText(document.getElementById(id)); } catch (e) { return ''; }
      });
      const joined = parts.join(' ').trim();
      if (joined) return joined.slice(0, 60);
    }
    if (input.parentElement) {
      const prev = input.parentElement.previousElementSibling;
      if (prev && prev.children.length <= 2) {
        const t = getText(prev);
        if (t && t.length < 50) return t;
      }
    }
    return '';
  }

  function readSelectValue(sel) {
    const opt = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    if (!opt) return '';
    if (S.isPlaceholderOption(opt.value, opt.text)) return '';
    return (opt.text || opt.value || '').trim();
  }

  function readComboboxValue(el) {
    // Read the DISPLAYED value, never the listbox contents.
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el.value || '').trim();
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { text += node.textContent; continue; }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const role = node.getAttribute('role');
        if (role === 'listbox' || role === 'option') continue;
        if (node.getAttribute('aria-hidden') === 'true') continue;
        text += node.textContent;
      }
    }
    text = text.trim();
    if (!text || S.isPlaceholderOption('', text)) return '';
    return text;
  }

  function readFieldValue(el) {
    if (el.tagName === 'SELECT') return readSelectValue(el);
    if (el.getAttribute && el.getAttribute('role') === 'combobox') return readComboboxValue(el);
    if ('value' in el && el.value !== undefined) return String(el.value).trim();
    return '';
  }

  /* -------------------------- scan strategies ------------------------ */

  function collectFormFields() {
    const nodes = document.querySelectorAll('input, textarea, select, [role="combobox"]');
    const fields = [];
    nodes.forEach(el => {
      if (el.tagName === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (['hidden', 'checkbox', 'radio', 'submit', 'button', 'password', 'email', 'file', 'search'].includes(t)) return;
      }
      if (!isVisible(el)) return; // fix #5: no lookups for closed modals
      const attrs = {
        id: el.id || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        labelText: findLabelText(el)
      };
      const type = S.classifyField(attrs);
      if (!type) return;
      const value = readFieldValue(el);
      if (!value) return;
      const prefix = S.extractGroupPrefix(attrs.name) || S.extractGroupPrefix(attrs.id);
      fields.push({ el, type, value, prefix });
    });
    return fields;
  }

  function scanFormFields(addAddress) {
    const fields = collectFormFields();
    const groups = S.groupFields(fields.map(f => ({ type: f.type, prefix: f.prefix })));
    groups.forEach(indices => {
      const parts = {};
      const els = [];
      indices.forEach(i => {
        const f = fields[i];
        if (!(f.type in parts)) parts[f.type] = f.value; // never overwrite (fix #1)
        els.push(f.el);
      });
      const street = [parts.street1, parts.street2].filter(Boolean).join(' ');
      if (street && parts.city && parts.state && parts.zip) {
        const container = lowestCommonAncestor(els);
        addAddress(street, parts.city, parts.state, parts.zip, container, 'Address form');
      }
    });
  }

  function scanReadOnlyPairs(addAddress) {
    const labels = document.querySelectorAll('span, div, dt, strong, p, label, td, th');
    const pairs = [];
    labels.forEach(el => {
      if (el.children.length > 3) return;
      if (!isVisible(el)) return;
      const text = getText(el).toLowerCase();
      if (!text || text.length > 40) return;
      let type = null;
      if (['street 1', 'street1', 'street', 'address 1', 'address1', 'property address', 'address'].includes(text)) type = 'street1';
      else if (['street 2', 'street2', 'address 2', 'address2'].includes(text)) type = 'street2';
      else if (text === 'city') type = 'city';
      else if (text === 'state' || text === 'province') type = 'state';
      else if (['zip', 'zip code', 'zipcode', 'postal code'].includes(text)) type = 'zip';
      if (!type) return;

      let valueEl = el.nextElementSibling;
      if (!valueEl && el.parentElement) {
        const sibs = Array.from(el.parentElement.children).filter(c => c !== el);
        if (sibs.length === 1) valueEl = sibs[0];
        else valueEl = el.parentElement.nextElementSibling;
      }
      if (!valueEl || !isVisible(valueEl)) return;
      const val = getText(valueEl);
      if (!val || val.length > 100 || val.toLowerCase() === text) return;
      const container = el.closest('dl, table, section, fieldset, [class*="address"], [class*="property"], .card') ||
        (el.parentElement ? el.parentElement.parentElement : null);
      if (!container) return;
      pairs.push({ type, value: val, container });
    });

    // Sequential grouping honoring both container identity and no-overwrite (fix #1).
    let current = null;
    const groups = [];
    pairs.forEach(p => {
      if (!current || current.container !== p.container || (p.type in current.parts)) {
        current = { container: p.container, parts: {} };
        groups.push(current);
      }
      current.parts[p.type] = p.value;
    });
    groups.forEach(g => {
      const street = [g.parts.street1, g.parts.street2].filter(Boolean).join(' ');
      if (street && g.parts.city && g.parts.state && g.parts.zip) {
        addAddress(street, g.parts.city, g.parts.state, g.parts.zip, g.container, 'Property details');
      }
    });
  }

  function scanTextBlocks(addAddress) {
    // includes a + h1-h6: real Jobber client screens render the property
    // address as a single line inside <a href="/clients/..."><h5>…</h5></a>
    const blocks = document.querySelectorAll('address, [class*="address"], p, div, li, td, a, h1, h2, h3, h4, h5, h6');
    blocks.forEach(block => {
      if (!isVisible(block)) return;
      if (block.children.length > 10) return;
      if (block.querySelector('input, select, textarea')) return;
      const raw = getText(block);
      if (!raw || raw.length > 200) return;
      const lines = (block.innerText || raw).split('\n').map(l => l.trim()).filter(Boolean);
      const parsed = S.parseAddressBlock(lines); // fix #4: street lines only, real state required
      if (parsed) {
        addAddress(parsed.street, parsed.city, parsed.state, parsed.zip, block, 'Address on page');
      }
    });
  }

  /* ------------------------------ scan -------------------------------- */

  function cleanupPreviousScan() {
    // fix #7: remove ALL our attributes and badges before each rescan
    document.querySelectorAll('[data-tax-ext-id]').forEach(el => el.removeAttribute('data-tax-ext-id'));
    document.querySelectorAll('.tax-ext-badge').forEach(el => el.remove());
  }

  /* --------------------------- skipped pages --------------------------- */

  function isSkippedPage() {
    // Jobber is an SPA: the URL changes via pushState WITHOUT a reload, so this
    // must be evaluated on every scan, never cached at boot.
    try { return S.isSkippedPath(location.pathname, skipPaths); } catch (e) { return false; }
  }

  function goQuiet() {
    // Skipped page (a Jobber list view): drop whatever a previous page left
    // behind — SPA navigation can carry badges/attributes across URLs — and
    // inject nothing.
    suppressObserver = true;
    try {
      cleanupPreviousScan();
      lastScanAddresses = [];
    } finally {
      setTimeout(() => { suppressObserver = false; }, 0);
    }
  }

  function scan() {
    if (isSkippedPage()) { goQuiet(); return []; }
    scanGen += 1;
    const gen = scanGen;
    suppressObserver = true;
    try {
      cleanupPreviousScan();
      const addresses = [];
      const seenKeys = new Set();
      const taggedContainers = new Set();
      let n = 0;

      const addAddress = (street, city, state, zip, container, label) => {
        if (!street || !city || !state || !zip || !container) return;
        const stateNorm = N.normalizeState(state);
        if (!stateNorm) return;
        const zipParts = N.parseZip(zip);
        if (!zipParts) return;
        const key = N.addressKey(street, city, state, zip); // fix #6: normalized dedup
        if (seenKeys.has(key)) return;
        // container-overlap dedup: skip if an ancestor is already tagged,
        // or this container wraps an already-tagged element
        let cur = container;
        while (cur && cur !== document.body) {
          if (taggedContainers.has(cur)) return;
          cur = cur.parentElement;
        }
        if (container.querySelector && container.querySelector('[data-tax-ext-id]')) return;

        seenKeys.add(key);
        taggedContainers.add(container);
        const id = 'g' + gen + '-' + (n++);
        container.setAttribute('data-tax-ext-id', id);
        addresses.push({
          id, key, label,
          street: street.trim(),
          city: city.trim(),
          state: stateNorm,
          zip: zipParts.zip5 + (zipParts.plus4 ? '-' + zipParts.plus4 : '')
        });
      };

      scanFormFields(addAddress);
      scanReadOnlyPairs(addAddress);
      scanTextBlocks(addAddress);

      lastScanAddresses = addresses;
      return addresses;
    } finally {
      setTimeout(() => { suppressObserver = false; }, 0);
    }
  }

  function safeScan() {
    try { return scan(); } catch (e) { return []; }
  }

  /* --------------------------- badge injection ------------------------ */

  const BLOCKED_PARENTS = ['TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR'];

  function buildBadge(addr, result) {
    const badge = document.createElement('div');
    badge.className = 'tax-ext-badge';
    badge.setAttribute('data-tax-ext-for', addr.id);

    if (result.status !== 'resolved') {
      badge.classList.add('tax-ext-badge--error');
      const label = document.createElement('div');
      label.className = 'tax-ext-badge-label';
      label.textContent = 'Suggested tax';
      const main = document.createElement('div');
      main.className = 'tax-ext-badge-main';
      main.textContent = 'Lookup failed';
      const sub = document.createElement('div');
      sub.className = 'tax-ext-badge-sub';
      sub.textContent = result.message || 'Could not resolve this address';
      badge.append(label, main, sub);
      return badge;
    }

    if (result.confidence === 'verify') badge.classList.add('tax-ext-badge--verify');
    if (result.confidence === 'estimate') badge.classList.add('tax-ext-badge--estimate');

    const label = document.createElement('div');
    label.className = 'tax-ext-badge-label';
    label.textContent = 'Suggested tax';

    const main = document.createElement('div');
    main.className = 'tax-ext-badge-main';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = result.labelDisplay || result.label || '';
    const rateSpan = document.createElement('span');
    rateSpan.className = 'tax-ext-badge-rate';
    rateSpan.textContent = result.totalPct + '%';
    main.append(nameSpan, rateSpan);

    badge.append(label, main);

    if (result.breakdownText) {
      const sub = document.createElement('div');
      sub.className = 'tax-ext-badge-sub';
      sub.textContent = result.breakdownText;
      badge.appendChild(sub);
    }

    if (result.confidence === 'verify') {
      const warn = document.createElement('div');
      warn.className = 'tax-ext-badge-warn';
      const warnText = document.createElement('span');
      warnText.textContent = '⚠ boundary area — verify ';
      const link = document.createElement('a');
      link.href = result.finderUrl || 'https://thefinder.tax.ohio.gov/?tab=rateSearch';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Check in The Finder';
      warn.append(warnText, link);
      badge.appendChild(warn);
    } else if (result.confidence === 'estimate') {
      const noteEl = document.createElement('div');
      noteEl.className = 'tax-ext-badge-warn';
      noteEl.textContent = result.note || 'Estimate (legacy backend)';
      badge.appendChild(noteEl);
    }

    return badge;
  }

  function findTaxSelectWrapper(target) {
    // NOTE: scoping is closest()-based from the target — we never take the
    // page's first [role=dialog] (real Jobber keeps a hidden decoy dialog).
    const scope = target.closest('form, fieldset, [role="dialog"], .card') || target;
    let taxSelect = null;
    try {
      taxSelect = scope.querySelector('select[name*="tax" i], select[id*="tax" i], [data-testid*="tax" i] select');
    } catch (e) {
      taxSelect = scope.querySelector('select[name*="tax"], select[id*="tax"]');
    }
    if (taxSelect && isVisible(taxSelect)) {
      return taxSelect.closest('div, label, fieldset') || taxSelect;
    }
    return null;
  }

  function climbOutOfAnchor(el) {
    // Never place a badge inside a link (real Jobber wraps the property
    // address in <a href="/clients/…"><h5>…</h5></a>). Step out of the <a>,
    // then out of wrappers that contain nothing but this link ("row" divs).
    const a = el.closest && el.closest('a');
    if (!a) return el;
    let node = a;
    const aText = getText(a);
    let hops = 0;
    while (node.parentElement && node.parentElement !== document.body && hops < 4 &&
      getText(node.parentElement) === aText) {
      node = node.parentElement;
      hops++;
    }
    return node;
  }

  function injectBadge(addr, result) {
    let target = null;
    try {
      target = document.querySelector('[data-tax-ext-id="' + CSS.escape(addr.id) + '"]');
    } catch (e) { }
    if (!target) return;

    const existing = document.querySelector('.tax-ext-badge[data-tax-ext-for="' + CSS.escape(addr.id) + '"]');
    if (existing) existing.remove();

    // Preferred anchor point: the tax-select wrapper; else the address
    // block itself (climbed out of any <a> / same-content row wrappers).
    let anchorNode = findTaxSelectWrapper(target) || climbOutOfAnchor(target);

    // fix #8: never insert as a direct child of table structures
    while (anchorNode.parentElement && BLOCKED_PARENTS.includes(anchorNode.parentElement.tagName)) {
      anchorNode = anchorNode.closest('table') || anchorNode.parentElement;
      if (anchorNode.tagName === 'TABLE') break;
    }

    const badge = buildBadge(addr, result);

    suppressObserver = true;
    try {
      if (anchorNode.parentNode) {
        // insert AFTER the anchor node, as a sibling — never inside links,
        // never as a stray flex/table child of the row itself
        anchorNode.parentNode.insertBefore(badge, anchorNode.nextSibling);
      } else {
        target.appendChild(badge);
      }
    } finally {
      setTimeout(() => { suppressObserver = false; }, 0);
    }
  }

  function injectAllBadges() {
    if (isSkippedPage()) return;
    lastScanAddresses.forEach(addr => {
      const result = resultCache.get(addr.key);
      if (result) injectBadge(addr, result);
    });
  }

  /* ------------------------- lookups via SW ---------------------------- */

  function requestLookups(addresses) {
    const need = addresses.filter(a => !resultCache.has(a.key) && !pendingKeys.has(a.key));
    if (!need.length) { injectAllBadges(); return; }
    need.forEach(a => pendingKeys.add(a.key));
    let responded = false;
    try {
      chrome.runtime.sendMessage({ type: 'RESOLVE_ADDRESSES', addresses: need }, (resp) => {
        responded = true;
        need.forEach(a => pendingKeys.delete(a.key));
        if (chrome.runtime.lastError) return; // SW asleep/reloading — next scan retries
        if (dead) return; // a newer copy took over while we were waiting
        if (!resp || !resp.ok || !Array.isArray(resp.results)) return;
        resp.results.forEach(r => { if (r.key) resultCache.set(r.key, r); });
        injectAllBadges();
      });
    } catch (e) {
      need.forEach(a => pendingKeys.delete(a.key));
    }
    // safety: clear pending flags if callback never fires (e.g. extension reload)
    setTimeout(() => { if (!responded) need.forEach(a => pendingKeys.delete(a.key)); }, 30000);
  }

  function runAutoScan() {
    if (dead) return;
    if (isSkippedPage()) { goQuiet(); return; }
    const addresses = safeScan();
    if (!addresses.length) return;
    injectAllBadges();          // fix #9: re-inject from cache without re-fetching
    requestLookups(addresses);
  }

  /* --------------------------- mutation observer ----------------------- */

  function isOurNode(n) {
    return n.nodeType === 1 && (
      (n.classList && n.classList.contains('tax-ext-badge')) ||
      (n.closest && n.closest('.tax-ext-badge'))
    );
  }

  function scheduleScan() {
    if (dead) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runAutoScan, 800); // fix #9: debounced 800ms
  }

  function startObserver() {
    if (dead || observer) return;
    observer = new MutationObserver(muts => {
      if (dead || suppressObserver) return;
      let relevant = false;
      for (const m of muts) {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (nodes.length === 0) continue;
        if (!nodes.every(isOurNode)) { relevant = true; break; }
      }
      if (relevant) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ------------------------------ messaging ---------------------------- */

  function onRuntimeMessage(msg, sender, sendResponse) {
    // fix #10: always respond, synchronously — never leave the port hanging
    if (dead) return false; // a newer copy owns this page now
    try {
      if (msg && msg.action === 'PING') {
        sendResponse({ ok: true });
        return false;
      }
      if (msg && msg.action === 'SCAN_ADDRESSES') {
        if (isSkippedPage()) {
          goQuiet();
          sendResponse({ ok: true, addresses: [], skipped: 'list-page' });
          return false;
        }
        const addresses = safeScan();
        // kick off async badge lookups too, but respond immediately
        if (addresses.length) requestLookups(addresses);
        sendResponse({ ok: true, addresses });
        return false;
      }
      if (msg && msg.action === 'INJECT_BADGES') {
        (msg.results || []).forEach(r => { if (r && r.key) resultCache.set(r.key, r); });
        injectAllBadges();
        sendResponse({ ok: true });
        return false;
      }
    } catch (err) {
      try { sendResponse({ ok: false, error: String(err && err.message || err) }); } catch (e) { }
      return false;
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  /* ------------------------------ settings ----------------------------- */

  function loadSkipPaths() {
    try {
      chrome.storage.sync.get('skipPaths', (st) => {
        if (chrome.runtime.lastError || dead) return;
        if (!st || !Array.isArray(st.skipPaths)) return;
        const before = skipPaths.join('\n');
        skipPaths = st.skipPaths.slice();
        // Saved settings can land after the first scan — re-run if they differ.
        if (skipPaths.join('\n') !== before) scheduleScan();
      });
    } catch (e) { }
  }

  function onStorageChanged(changes, area) {
    if (dead || area !== 'sync' || !changes || !changes.skipPaths) return;
    const next = changes.skipPaths.newValue;
    skipPaths = Array.isArray(next) ? next.slice() : S.DEFAULT_SKIP_PATHS.slice();
    // Re-evaluate this page under the new list: runAutoScan cleans up if the
    // page just became skipped, and scans if it just stopped being skipped.
    scheduleScan();
  }
  try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (e) { }

  /* ------------------------------- boot -------------------------------- */

  function onPopState() {
    // Back/forward within the SPA changes the URL with no reload — rescan so
    // list -> detail -> list transitions re-run the skip check.
    scheduleScan();
  }
  window.addEventListener('popstate', onPopState);

  function boot() {
    if (dead) return;
    loadSkipPaths();
    startObserver();
    setTimeout(runAutoScan, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
