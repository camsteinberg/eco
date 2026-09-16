// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eco Service Worker
 *
 * Caching strategies:
 * - CacheFirst for successful immutable static assets (_next/static/*)
 * - CacheFirst for reviewed ONNX Runtime assets needed by prepared local models
 * - NetworkOnly for API routes (/v1/*, /api/*)
 * - NetworkFirst for the chat routes' app shell, falling back to the captured
 *   shell and then to a small offline document
 * - NetworkOnly for every other navigation, with the same offline document
 * - No-op for everything else
 *
 * Why a cached shell is deploy-safe here: the HTML and every hashed chunk it
 * references are captured together from ONE successful response, so the shell
 * and its chunks are always from a single build. If any of those assets cannot
 * be stored, the capture stores neither the HTML nor its manifest — the tab
 * keeps the previous complete shell, or the offline document, and never a
 * shell pointing at a chunk that is not there.
 */

const CACHE_NAME = "eco-v5";
// Separate from CACHE_NAME so bumping the app cache (which navigates every open
// tab) is not needed to change shell behaviour, and so the shell survives the
// activate sweep of the LRU-evicted app cache.
const SHELL_CACHE_NAME = "eco-shell-v1";
const TRANSFORMERS_CACHE_NAME = "transformers-cache";
const CLIENT_RESET_MESSAGE_TYPE = "eco-client-state-reset";
let suppressRuntimeCaching = false;

// Next.js rewrites proxy API routes through the same origin.
// These must NEVER be cached — they carry auth tokens and live data.
const NETWORK_ONLY_PATTERNS = [/^\/v1\//, /^\/api\//];
// Runtime engine assets now live under static paths (copied into public/ at
// build — scripts/copy-runtime-assets.mjs). The legacy /api/ort entries stay
// so clients running an older page bundle keep their cache behavior.
const CACHEABLE_ORT_ASSET_PATHS = new Set([
  "/ort/ort-wasm-simd-threaded.asyncify.mjs",
  "/ort/ort-wasm-simd-threaded.asyncify.wasm",
  "/litert-wasm/litertlm_wasm_internal.js",
  "/litert-wasm/litertlm_wasm_internal.wasm",
  "/litert-wasm/litertlm_wasm_compat_internal.js",
  "/litert-wasm/litertlm_wasm_compat_internal.wasm",
  "/api/ort/ort-wasm-simd-threaded.asyncify.mjs",
  "/api/ort/ort-wasm-simd-threaded.asyncify.wasm",
]);

function isNetworkOnly(url) {
  const path = new URL(url).pathname;
  return NETWORK_ONLY_PATTERNS.some((pattern) => pattern.test(path));
}

function isCacheableOrtAsset(url) {
  const path = new URL(url).pathname;
  return CACHEABLE_ORT_ASSET_PATHS.has(path);
}

function isStaticAsset(url) {
  return new URL(url).pathname.startsWith("/_next/static/");
}

// The only two chat routes — app/(app)/chat/page.tsx and .../chat/new/page.tsx.
function isShellRoute(pathname) {
  return pathname === "/chat" || pathname === "/chat/new";
}

const SHELL_ROUTES = ["/chat", "/chat/new"];
// The asset list a stored shell needs, kept beside it under its own key.
const SHELL_MANIFEST_PREFIX = "/__eco-shell-manifest";
// Script/style references in the HTML. The flight payload lists the same
// chunks without the /_next/ prefix, so both forms are matched and normalized
// to one absolute URL. Route-group parentheses (…/chunks/app/(app)/chat/…) are
// legitimate inside a chunk path, so the character class does not stop on them.
const SHELL_ASSET_PATTERNS = [
  /\/_next\/static\/[^"'\\\s<>,]+/g,
  /static\/chunks\/[^"'\\\s<>,]+/g,
  /static\/css\/[^"'\\\s<>,]+/g,
];

function shellManifestKey(pathname) {
  return SHELL_MANIFEST_PREFIX + pathname;
}

function toShellAssetUrl(match) {
  const path = match.startsWith("/_next/") ? match : `/_next/${match}`;
  return new URL(path, self.location.origin).toString();
}

function collectShellAssets(html) {
  const urls = new Set();
  for (const pattern of SHELL_ASSET_PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      urls.add(toShellAssetUrl(match[0]));
    }
  }
  return urls;
}

// Fonts are referenced from the stylesheets, not the HTML, and the shipped CSS
// uses relative urls (url(../media/…)) as often as absolute ones — so resolve
// every url() against its stylesheet and keep the same-origin static hits.
function collectCssAssets(cssText, cssUrl) {
  const urls = new Set();
  for (const match of cssText.matchAll(/url\(\s*['"]?([^)'"]+)['"]?\s*\)/g)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("data:")) continue;
    try {
      const resolved = new URL(raw, cssUrl);
      if (resolved.origin === self.location.origin && isStaticAsset(resolved.toString())) {
        urls.add(resolved.toString());
      }
    } catch {
      // Not a URL we can resolve — skip it rather than fail the capture.
    }
  }
  return urls;
}

async function readAsset(url) {
  const cached = await caches.match(url);
  if (cached) return cached;

  const response = await fetch(url);
  if (!response.ok) return null;
  return response;
}

/**
 * Capture the shell for one chat route: the HTML plus every asset it needs.
 *
 * Runs on a clone inside waitUntil, so it never touches the response the tab
 * is already rendering, and every failure path leaves the previous capture in
 * place.
 */
async function captureShell(pathname, response) {
  try {
    const html = await response.text();
    const assetUrls = collectShellAssets(html);

    for (const url of [...assetUrls]) {
      if (!url.endsWith(".css")) continue;
      const css = await readAsset(url);
      if (!css) return;
      for (const media of collectCssAssets(await css.clone().text(), url)) {
        assetUrls.add(media);
      }
    }

    const manifest = [...assetUrls].sort();
    const cache = await caches.open(SHELL_CACHE_NAME);
    // The network response's headers are kept whole — Content-Security-Policy
    // among them, which carries the nonce this HTML's script tags were served
    // with. CSP is header-only here (no <meta http-equiv>), so rebuilding the
    // response with a Content-Type alone would serve the offline shell with no
    // policy at all. Headers stay readable after the body is consumed.
    const freshHtml = () => new Response(html, { status: 200, headers: response.headers });

    // Same build as last time: the assets are already stored, so only the HTML
    // (which carries per-response state like the flight payload) is refreshed.
    const storedManifest = await cache.match(shellManifestKey(pathname));
    if (storedManifest) {
      const previous = await storedManifest.json();
      if (
        Array.isArray(previous)
        && previous.length === manifest.length
        && previous.every((url, i) => url === manifest[i])
      ) {
        await cache.put(pathname, freshHtml());
        return;
      }
    }

    for (const url of manifest) {
      const asset = await readAsset(url);
      // A shell referencing an asset we could not store is worse than the
      // offline document, so abort before the HTML or manifest is written.
      if (!asset) return;
      await cache.put(url, asset.clone());
    }

    await cache.put(pathname, freshHtml());
    await cache.put(
      shellManifestKey(pathname),
      new Response(JSON.stringify(manifest), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await pruneShellCache(cache);
  } catch {
    // A failed capture is invisible: the tab already has its response.
  }
}

// Drop anything the current manifests no longer reference — the previous
// build's chunks, after a deploy changed them.
async function pruneShellCache(cache) {
  try {
    const keep = new Set();
    for (const route of SHELL_ROUTES) {
      keep.add(new URL(route, self.location.origin).toString());
      keep.add(new URL(shellManifestKey(route), self.location.origin).toString());
      const stored = await cache.match(shellManifestKey(route));
      if (!stored) continue;
      const manifest = await stored.json();
      if (!Array.isArray(manifest)) continue;
      for (const url of manifest) {
        keep.add(new URL(url, self.location.origin).toString());
      }
    }

    for (const request of await cache.keys()) {
      const url = new URL(request.url ?? request, self.location.origin).toString();
      if (!keep.has(url)) {
        await cache.delete(request);
      }
    }
  } catch {
    // Non-critical — a shell cache that keeps a dead entry still works.
  }
}

// Captures run one at a time. Two chat tabs opened together would otherwise
// interleave: one route's prune can land between the other's asset writes and
// its manifest write, deleting chunks the manifest is about to claim.
let captureChain = Promise.resolve();

function maybeCaptureShell(event, url, response) {
  try {
    // A redirect means the site gate answered, not the app — capturing it would
    // pin the password page as the offline chat shell.
    if (!response.ok || response.redirected || !isShellRoute(url.pathname)) {
      return;
    }
    if (!(response.headers.get("Content-Type") ?? "").includes("text/html")) {
      return;
    }
    const clone = response.clone();
    captureChain = captureChain.then(() => captureShell(url.pathname, clone)).catch(() => undefined);
    event.waitUntil(captureChain);
  } catch {
    // A capture that cannot even start must not disturb the navigation.
  }
}

// LRU eviction: keep at most maxEntries in a cache (FIFO by insertion order)
async function evictOldEntries(cache, maxEntries) {
  try {
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    const excess = keys.length - maxEntries;
    for (let i = 0; i < excess; i++) {
      await cache.delete(keys[i]);
    }
  } catch {
    // Non-critical — skip eviction on error
  }
}

async function clearAppCache() {
  try {
    // The shell goes with it: a client-state reset that left a captured shell
    // behind would not be a wipe.
    await Promise.all([caches.delete(CACHE_NAME), caches.delete(SHELL_CACHE_NAME)]);
  } catch {
    // Ignore cache deletion failures during reset.
  }
}

function offlineNavigationResponse() {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Eco is offline</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f5f0e8;
        color: #2c2418;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        box-sizing: border-box;
        width: min(440px, calc(100vw - 48px));
        padding: 32px;
        border: 1px solid rgba(45, 90, 61, 0.16);
        border-radius: 28px;
        background: rgba(255, 252, 246, 0.88);
        box-shadow: 0 24px 80px rgba(44, 36, 24, 0.12);
      }
      h1 {
        margin: 0 0 12px;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 28px;
        line-height: 1.1;
      }
      p {
        margin: 0;
        color: #6d6257;
        line-height: 1.6;
      }
      button {
        margin-top: 24px;
        min-height: 44px;
        border: 0;
        border-radius: 999px;
        padding: 0 18px;
        background: #2d5a3d;
        color: white;
        font: inherit;
        font-weight: 600;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #1a1a1a; color: #ede8e0; }
        main { background: #242424; border-color: #333333; }
        p { color: #b8afa3; }
        button { background: #7bc08e; color: #102016; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Eco needs a connection to open</h1>
      <p>If Eco was already open, your local conversation can keep working there. Reconnect and refresh to load the app shell again.</p>
      <button onclick="window.location.reload()">Try again</button>
    </main>
  </body>
</html>`,
    {
      status: 503,
      statusText: "Offline",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Eco-Offline": "true",
      },
    },
  );
}

// Install: skip waiting without pre-caching route HTML. HTML fetched here would
// be paired with whatever chunks happened to be cached later; the shell is
// captured instead from a real navigation, HTML and chunks in one go.
self.addEventListener("install", (event) => {
  event.waitUntil(Promise.resolve());
  self.skipWaiting();
});

// Activate: clean up old caches, evict stale model caches, and claim all clients
self.addEventListener("activate", (event) => {
  let shouldRefreshClients = false;

  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        // Delete unrecognized caches (not our app cache, the chat shell,
        // transformers, or model caches)
        const deletions = keys
          .filter((key) => key !== CACHE_NAME && key !== SHELL_CACHE_NAME && !key.startsWith('transformers-cache') && !key.startsWith('eco-model-'))
          .map((key) => {
            if (key.startsWith('eco-v')) {
              shouldRefreshClients = true;
            }
            return caches.delete(key);
          });

        // Evict old model caches — keep at most 3 eco-model-* caches (FIFO)
        const modelCaches = keys.filter((key) => key.startsWith('eco-model-'));
        if (modelCaches.length > 3) {
          const excess = modelCaches.length - 3;
          for (let i = 0; i < excess; i++) {
            deletions.push(caches.delete(modelCaches[i]));
          }
        }

        // Cap transformers-cache entries to prevent unbounded growth
        const transformerCaches = keys.filter((key) => key.startsWith('transformers-cache'));
        for (const tcName of transformerCaches) {
          deletions.push(
            caches.open(tcName).then((cache) => evictOldEntries(cache, 200))
          );
        }

        return Promise.all(deletions);
      })
      .then(() => self.clients.claim())
      .then(async () => {
        if (!shouldRefreshClients) return;

        const clients = await self.clients.matchAll({ type: 'window' });
        await Promise.all(
          clients.map((client) => {
            if (!client.url || !('navigate' in client)) return Promise.resolve();

            const url = new URL(client.url);
            if (url.origin !== self.location.origin) return Promise.resolve();
            return client.navigate(client.url).catch(() => undefined);
          }),
        );
      })
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== CLIENT_RESET_MESSAGE_TYPE) {
    return;
  }

  suppressRuntimeCaching = true;

  const acknowledge = () => {
    if (event.ports?.[0]) {
      event.ports[0].postMessage({ ok: true });
    }
  };

  event.waitUntil(
    clearAppCache()
      .catch(() => {})
      .finally(acknowledge)
  );
});

// Fetch: route requests to the appropriate caching strategy
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (suppressRuntimeCaching) {
    return;
  }

  // Offline interception for chat completions — try network, signal offline on failure.
  // MUST come before the general NetworkOnly check so /v1/chat/completions is handled here.
  if (url.pathname === "/v1/chat/completions" || url.pathname.startsWith("/v1/chat/completions")) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({ error: "offline", message: "No network connection" }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "X-Eco-Offline": "true",
            },
          }
        );
      })
    );
    return;
  }

  if (request.method === "GET" && isCacheableOrtAsset(request.url)) {
    event.respondWith(
      caches.open(TRANSFORMERS_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) {
          return cached;
        }

        const response = await fetch(request);
        if (response.ok) {
          cache.put(request, response.clone());
        }
        return response;
      })
    );
    return;
  }

  // NetworkOnly — never cache API routes
  if (isNetworkOnly(request.url)) {
    return; // Let the browser handle it normally (no event.respondWith)
  }

  // CacheFirst — static assets are content-hashed, but only cache successful
  // responses. Caching a 400/404 chunk response can permanently poison refresh.
  if (request.method === "GET" && isStaticAsset(request.url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          return cached;
        }

        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, clone);
              evictOldEntries(cache, 150);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Navigation is network-first, always: a reachable network always wins, so a
  // deploy is picked up on the first reload like any other page.
  //
  // The chat routes additionally capture their shell from that successful
  // response (HTML and chunks together, one build — see the header), so an
  // offline reload reaches the chat the model and the conversations are
  // already on the device for. Every other path, and a chat route with no
  // capture yet, still gets the small offline document.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          maybeCaptureShell(event, url, response);
          return response;
        })
        .catch(async () => {
          if (isShellRoute(url.pathname)) {
            const cache = await caches.open(SHELL_CACHE_NAME);
            // Match on the bare pathname, so request headers never decide
            // whether the shell is found.
            const cached = await cache.match(url.pathname, {
              ignoreVary: true,
              ignoreSearch: true,
            });
            if (cached) {
              return cached;
            }
          }

          return offlineNavigationResponse();
        })
    );
    return;
  }

  // Everything else — no caching, let browser handle normally
});
