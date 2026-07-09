// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export const staticAssetRecoveryScript = `
(function() {
  var STORAGE_PREFIX = 'eco-static-asset-recovery:';
  var FAILURE_ATTR = 'data-eco-asset-load-failed';
  var CSS_READY_PROPERTY = '--eco-css-ready';
  var key = STORAGE_PREFIX + window.location.pathname;

  function isNextStaticAsset(target) {
    if (!target) return false;
    var url = target.src || target.href || '';
    return typeof url === 'string' && url.indexOf('/_next/static/') !== -1;
  }

  function showRecoveryMessage() {
    if (document.getElementById('eco-static-asset-recovery')) return;
    document.documentElement.setAttribute(FAILURE_ATTR, 'true');

    var container = document.createElement('div');
    container.id = 'eco-static-asset-recovery';
    container.setAttribute('role', 'alert');
    container.setAttribute('aria-labelledby', 'eco-static-asset-recovery-title');
    container.setAttribute('aria-describedby', 'eco-static-asset-recovery-description');
    container.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:grid',
      'place-items:center',
      'background:#f5f0e8',
      'color:#2c2418',
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'padding:24px'
    ].join(';');

    container.innerHTML =
      '<main style="max-width:440px;border:1px solid rgba(45,90,61,.18);border-radius:28px;background:rgba(255,252,246,.92);box-shadow:0 24px 80px rgba(44,36,24,.14);padding:32px">' +
        '<p style="margin:0 0 8px;text-transform:uppercase;letter-spacing:.18em;font-size:12px;color:#2d5a3d;font-weight:700">Eco update interrupted</p>' +
        '<h1 id="eco-static-asset-recovery-title" style="margin:0 0 12px;font-family:Georgia,Times New Roman,serif;font-size:28px;line-height:1.1">Eco could not load its latest app files.</h1>' +
        '<p id="eco-static-asset-recovery-description" style="margin:0;color:#6d6257;line-height:1.6">This usually happens after an update when an old page is still open. Try a hard refresh. If you are running Eco locally, rebuild and restart the web server.</p>' +
        '<button type="button" id="eco-static-asset-retry" style="margin-top:24px;min-height:44px;border:0;border-radius:999px;padding:0 18px;background:#2d5a3d;color:white;font:inherit;font-weight:700">Reload Eco</button>' +
      '</main>';

    document.body ? document.body.appendChild(container) : document.documentElement.appendChild(container);
    var button = document.getElementById('eco-static-asset-retry');
    if (button) {
      button.onclick = function() { window.location.reload(); };
      try { button.focus({ preventScroll: true }); } catch (e) { button.focus(); }
    }
  }

  function recover() {
    try {
      if (window.sessionStorage.getItem(key) === 'attempted') {
        showRecoveryMessage();
        return;
      }
      window.sessionStorage.setItem(key, 'attempted');
    } catch (e) {}

    var url = new URL(window.location.href);
    url.searchParams.set('__eco_static_recover', String(Date.now()));
    window.location.replace(url.toString());
  }

  function hasNextStylesheet() {
    return Boolean(document.querySelector('link[rel="stylesheet"][href*="/_next/static/"]'));
  }

  function hasAppCss() {
    try {
      return window.getComputedStyle(document.documentElement)
        .getPropertyValue(CSS_READY_PROPERTY)
        .trim() === '1';
    } catch (e) {
      return true;
    }
  }

  function recoverIfCssMissing() {
    if (document.documentElement.hasAttribute(FAILURE_ATTR)) return;
    if (hasNextStylesheet() && !hasAppCss()) {
      recover();
      return;
    }
    try { window.sessionStorage.removeItem(key); } catch (e) {}
  }

  function attachAssetErrorListeners() {
    var assets = document.querySelectorAll('link[href*="/_next/static/"],script[src*="/_next/static/"]');
    for (var i = 0; i < assets.length; i += 1) {
      assets[i].addEventListener('error', recover, { once: true });
    }
  }

  attachAssetErrorListeners();

  window.addEventListener('error', function(event) {
    if (isNextStaticAsset(event.target)) {
      window.setTimeout(recover, 0);
    }
  }, true);

  window.addEventListener('load', function() {
    window.setTimeout(recoverIfCssMissing, 0);
  }, { once: true });
})();
`;
