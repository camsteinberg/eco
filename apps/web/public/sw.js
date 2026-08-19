// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eco Service Worker
 *
 * Caching strategies:
 * - CacheFirst for successful immutable static assets (_next/static/*)
 * - CacheFirst for reviewed ONNX Runtime assets needed by prepared local models
 * - NetworkOnly for API routes (/v1/*, /api/*)
 * - NetworkOnly for navigations with a small offline fallback document
 * - No-op for everything else
 */

const CACHE_NAME = "eco-v5";
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
    await caches.delete(CACHE_NAME);
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
        text-align: center;
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
        main { background: rgba(38, 35, 30, 0.92); border-color: rgba(123, 192, 142, 0.22); }
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

// Install: skip waiting without pre-caching route HTML. Cached HTML can point at
// old Next.js asset hashes after deploys and cause broken refreshes.
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
        // Delete unrecognized caches (not our app cache, transformers, or model caches)
        const deletions = keys
          .filter((key) => key !== CACHE_NAME && !key.startsWith('transformers-cache') && !key.startsWith('eco-model-'))
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

  // Navigation HTML is network-only. Serving cached app HTML after a deploy is
  // worse than showing a small offline fallback because stale HTML references
  // missing hashed chunks and leaves users with a broken, unstyled shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => offlineNavigationResponse())
    );
    return;
  }

  // Everything else — no caching, let browser handle normally
});
