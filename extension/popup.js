/*
 * popup.js — thin UI over the service worker.
 * Auto-scans on open, Refresh button, result cards, data-version footer.
 * ALL rendering via createElement/textContent — no innerHTML with dynamic strings.
 */
'use strict';

const METHOD_TEXT = {
  zip5: 'via ZIP code (unambiguous)',
  zip4: 'via ZIP+4 boundary range',
  addr: 'via street-address boundary range',
  'addr-default': 'via street directory (ZIP default)',
  census: 'via Census geocoder',
  'census-county': 'via Census geocoder (county)',
  fcc: 'via FCC area lookup',
  'zip-default': 'ZIP default (offline)',
  backend: 'via legacy backend'
};

const CONFIDENCE_TEXT = {
  exact: 'Exact',
  high: 'High confidence',
  verify: 'Verify',
  estimate: 'Estimate'
};

document.addEventListener('DOMContentLoaded', () => {
  const scanBtn = document.getElementById('scanBtn');
  const scanStatus = document.getElementById('scanStatus');
  const resultsContainer = document.getElementById('results');
  const optionsBtn = document.getElementById('optionsBtn');
  const dataInfo = document.getElementById('dataInfo');

  optionsBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  });

  // Hover-to-play video easter egg (asset hosted on storage.googleapis.com;
  // CSP media-src allowance kept in manifest).
  const hoverVideo = document.getElementById('hoverVideo');
  if (hoverVideo) {
    hoverVideo.addEventListener('mouseenter', () => { hoverVideo.play().catch(() => {}); });
    hoverVideo.addEventListener('mouseleave', () => { hoverVideo.pause(); hoverVideo.currentTime = 0; });
    hoverVideo.addEventListener('error', () => {
      const wrap = hoverVideo.closest('.video-container');
      if (wrap) wrap.classList.add('hidden');
    }, { once: true });
  }

  scanBtn.addEventListener('click', performScan);

  refreshDataInfo();
  performScan();

  function refreshDataInfo() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        dataInfo.textContent = 'Data: unavailable';
        return;
      }
      let txt = 'Data: ' + resp.dataVersion + ' (' + resp.dataSource + ')';
      if (resp.lastCheck && resp.lastCheck.at) {
        const mins = Math.round((Date.now() - resp.lastCheck.at) / 60000);
        txt += ' · update check ' + (mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h') + ' ago';
      }
      dataInfo.textContent = txt;
    });
  }

  function setStatus(text) { scanStatus.textContent = text; }

  function clearResults() {
    while (resultsContainer.firstChild) resultsContainer.removeChild(resultsContainer.firstChild);
  }

  function showInfo(msg) {
    clearResults();
    const div = document.createElement('div');
    div.className = 'info-msg';
    div.textContent = msg;
    resultsContainer.appendChild(div);
  }

  function showError(msg, detail) {
    clearResults();
    const div = document.createElement('div');
    div.className = 'error-msg';
    div.textContent = msg;
    if (detail) {
      const d = document.createElement('span');
      d.className = 'error-detail';
      d.textContent = detail;
      div.appendChild(d);
    }
    resultsContainer.appendChild(div);
  }

  function causeToText(cause) {
    if (!cause) return 'unknown error';
    if (cause === 'timeout') return 'request timed out (8s)';
    if (cause === 'offline') return 'network unreachable (offline?)';
    if (String(cause).startsWith('http_')) return 'server returned HTTP ' + String(cause).slice(5);
    return String(cause);
  }

  function performScan() {
    scanBtn.disabled = true;
    setStatus('Scanning…');
    clearResults();

    const done = (statusText) => {
      scanBtn.disabled = false;
      if (statusText) setStatus(statusText);
    };

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs || !tabs.length) {
        showError('Could not read the active tab.');
        done('Ready');
        return;
      }
      const tab = tabs[0];
      // Jobber-page-only messaging (tab.url is only visible for hosts we hold
      // permissions for; anything else means "not a Jobber page").
      if (!tab.url || !tab.url.includes('secure.getjobber.com')) {
        showInfo('Open a Jobber page (secure.getjobber.com) to scan for addresses.');
        done('Not a Jobber page');
        return;
      }

      chrome.tabs.sendMessage(tab.id, { action: 'SCAN_ADDRESSES' }, (scanResp) => {
        if (chrome.runtime.lastError) {
          // Content script is not in this tab — classic MV3: the tab was open
          // BEFORE the extension was installed, or the (unpacked) extension
          // was reloaded and orphaned its old script. Self-heal: inject the
          // content script now, then retry the scan ONCE.
          void chrome.runtime.lastError;
          selfHealAndRetry(tab, done);
          return;
        }
        handleScanResponse(tab, scanResp, done);
      });
    });
  }

  function handleScanResponse(tab, scanResp, done) {
    if (scanResp && scanResp.skipped === 'list-page') {
      // The page is on the skip list (Options -> Pages to skip), so the content
      // script deliberately scanned nothing.
      showInfo('Suggestions are hidden on list pages. Open a client, request, quote, or job to see them.');
      done('List page skipped');
      return;
    }
    const addresses = scanResp && scanResp.addresses ? scanResp.addresses : [];
    if (!addresses.length) {
      showInfo('No complete addresses found on this page. Open a client, property, quote or invoice.');
      done('No addresses found');
      return;
    }

    setStatus('Found ' + addresses.length + ' address' + (addresses.length > 1 ? 'es' : '') + ' — resolving…');

    chrome.runtime.sendMessage({ type: 'RESOLVE_ADDRESSES', addresses }, (resp) => {
      if (chrome.runtime.lastError) {
        showError('Lookup service unavailable.', chrome.runtime.lastError.message);
        done('Ready');
        return;
      }
      if (!resp || !resp.ok) {
        const e = resp && resp.error ? resp.error : {};
        showError('Lookup failed: ' + (e.message || 'unknown error'), causeToText(e.cause));
        done('Ready');
        return;
      }

      clearResults();
      resp.results.forEach(r => renderResult(r));
      if (resp.dataVersion) {
        dataInfo.textContent = 'Data: ' + resp.dataVersion + ' (' + resp.dataSource + ')';
      }

      // hand results to the content script so badges appear on the page
      chrome.tabs.sendMessage(tab.id, { action: 'INJECT_BADGES', results: resp.results }, () => {
        void chrome.runtime.lastError; // page may have navigated; not fatal
        done('Done');
        setTimeout(() => {
          if (scanStatus.textContent === 'Done') setStatus('Ready');
        }, 3000);
      });
    });
  }

  // Inject content.css + the content-script files (same order as the
  // manifest: libs first, content.js last), wait briefly for the script to
  // boot, then retry SCAN_ADDRESSES exactly once. content.js is idempotent:
  // a 'taxext-teardown' event shuts down any older live copy first.
  function selfHealAndRetry(tab, done) {
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      showConnectError('this Chrome version lacks the scripting API');
      done('Ready');
      return;
    }
    setStatus('Connecting to the page…');
    chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] }, () => {
      // CSS failure alone is not fatal (badges would just be unstyled) —
      // the executeScript below is the real gate.
      void chrome.runtime.lastError;
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, files: ['lib/normalize.js', 'lib/scan-core.js', 'content.js'] },
        () => {
          if (chrome.runtime.lastError) {
            // No host permission / chrome:// page / tab gone — cannot heal.
            showConnectError(chrome.runtime.lastError.message);
            done('Ready');
            return;
          }
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { action: 'SCAN_ADDRESSES' }, (scanResp) => {
              if (chrome.runtime.lastError) {
                showConnectError(chrome.runtime.lastError.message);
                done('Ready');
                return;
              }
              handleScanResponse(tab, scanResp, done);
            });
          }, 150);
        });
    });
  }

  function showConnectError(detail) {
    showError('Could not connect to the page.',
      'Refresh the Jobber tab and try again.' + (detail ? ' (' + detail + ')' : ''));
  }

  function renderResult(r) {
    const card = document.createElement('div');
    card.className = 'result-card';

    const addr = r.input || {};
    const addressLine1 = addr.street || '';
    const addressLine2 = [addr.city, addr.state].filter(Boolean).join(', ') + ' ' + (addr.zip || '');

    if (r.status !== 'resolved') {
      const head = document.createElement('div');
      head.className = 'jobber-label-container';
      const lbl = document.createElement('div');
      lbl.className = 'jobber-label';
      lbl.textContent = addr.label || 'Address';
      head.appendChild(lbl);
      card.appendChild(head);
      card.appendChild(addressDiv(addressLine1, addressLine2));

      const err = document.createElement('div');
      err.className = 'error-msg';
      err.style.width = '100%';
      err.style.boxSizing = 'border-box';
      err.textContent = 'Lookup failed: ' + (r.message || r.reason || 'unknown');
      if (Array.isArray(r.attempts) && r.attempts.length) {
        const d = document.createElement('span');
        d.className = 'error-detail';
        d.textContent = r.attempts.map(a => a.stage + ': ' + causeToText(a.cause)).join(' · ');
        err.appendChild(d);
      }
      card.appendChild(err);
      resultsContainer.appendChild(card);
      return;
    }

    // header: label + rate
    const head = document.createElement('div');
    head.className = 'jobber-label-container';
    const lbl = document.createElement('div');
    lbl.className = 'jobber-label';
    lbl.textContent = r.labelDisplay || r.label || '';
    const rate = document.createElement('div');
    rate.className = 'jobber-rate';
    rate.textContent = r.totalPct + '%';
    head.append(lbl, rate);
    card.appendChild(head);

    card.appendChild(addressDiv(addressLine1, addressLine2));

    const breakdown = document.createElement('div');
    breakdown.className = 'result-breakdown';
    breakdown.textContent = r.breakdownText || '';
    card.appendChild(breakdown);

    // confidence chip + method + verify link
    const row = document.createElement('div');
    row.className = 'confidence-row';
    const chip = document.createElement('span');
    chip.className = 'confidence-chip ' + (r.confidence || 'exact');
    chip.textContent = CONFIDENCE_TEXT[r.confidence] || r.confidence || '';
    row.appendChild(chip);
    const method = document.createElement('span');
    method.className = 'method-note';
    method.textContent = (METHOD_TEXT[r.method] || r.method || '') + (r.fromCache ? ' · cached' : '');
    row.appendChild(method);
    if (r.confidence === 'verify' && r.finderUrl) {
      const link = document.createElement('a');
      link.className = 'verify-link';
      link.href = r.finderUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Verify in The Finder';
      row.appendChild(link);
    }
    card.appendChild(row);

    // candidate combos, when the ZIP straddles boundaries
    if (r.confidence === 'verify' && Array.isArray(r.candidates) && r.candidates.length) {
      const box = document.createElement('div');
      box.className = 'candidates';
      const title = document.createElement('div');
      title.className = 'candidates-title';
      title.textContent = 'Possible jurisdictions in this ZIP';
      box.appendChild(title);
      r.candidates.forEach(c => {
        const rowEl = document.createElement('div');
        rowEl.className = 'candidate-row';
        const name = document.createElement('span');
        name.textContent = c.label + (c.transit ? ' (' + c.county.name + ' + ' + c.transit.name + ')' : (c.county ? ' (' + c.county.name + ')' : ''));
        const pct = document.createElement('span');
        pct.textContent = c.totalPct + '%';
        rowEl.append(name, pct);
        box.appendChild(rowEl);
      });
      card.appendChild(box);
    }

    if (r.note) {
      const note = document.createElement('div');
      note.className = 'result-note';
      note.textContent = r.note;
      card.appendChild(note);
    }

    resultsContainer.appendChild(card);
  }

  function addressDiv(line1, line2) {
    const div = document.createElement('div');
    div.className = 'result-address';
    div.appendChild(document.createTextNode(line1));
    div.appendChild(document.createElement('br'));
    div.appendChild(document.createTextNode(line2));
    return div;
  }
});
