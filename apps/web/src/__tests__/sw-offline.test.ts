// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Service worker offline interception tests.
 *
 * We evaluate sw.js in a minimal SW-like environment, then invoke
 * the registered fetch handler to verify offline behavior.
 */

// Minimal Service Worker globals
let fetchHandler: ((event: { request: Request; respondWith: (r: Response | Promise<Response>) => void }) => void) | null = null;
let installHandler: ((event: { waitUntil: (p: Promise<unknown>) => void }) => void) | null = null;

function resetHandlers() {
  fetchHandler = null;
  installHandler = null;
}

// Mock caches API
const mockCacheStore = new Map<string, Response>();
const mockCache = {
  put: vi.fn(async (req: Request | string, res: Response) => {
    const key = typeof req === 'string' ? req : req.url;
    mockCacheStore.set(key, res);
  }),
  match: vi.fn(async (req: Request | string) => {
    const key = typeof req === 'string' ? req : req.url;
    return mockCacheStore.get(key) ?? undefined;
  }),
  addAll: vi.fn(async () => {}),
};

function setupGlobals() {
  resetHandlers();
  mockCacheStore.clear();
  mockCache.put.mockClear();
  mockCache.match.mockClear();
  mockCache.addAll.mockClear();

  // Minimal SW scope
  const scope: Record<string, unknown> = {
    addEventListener: (type: string, handler: (...args: unknown[]) => void) => {
      if (type === 'fetch') fetchHandler = handler as typeof fetchHandler;
      if (type === 'install') installHandler = handler as typeof installHandler;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
    caches: {
      open: vi.fn(async () => mockCache),
      keys: vi.fn(async () => []),
      match: vi.fn(async (req: Request | string) => mockCache.match(req)),
      delete: vi.fn(async () => true),
    },
    location: new URL('https://econetwork.ai/'),
    self: undefined as unknown,
  };
  scope['self'] = scope;

  // Assign to globalThis for eval
  Object.assign(globalThis, scope);
  (globalThis as Record<string, unknown>)['self'] = scope;
}

async function loadSW() {
  const fs = await import('fs');
  const path = await import('path');
  const swPath = path.resolve(__dirname, '../../public/sw.js');
  const swCode = fs.readFileSync(swPath, 'utf-8');
  // Evaluate in current scope (globalThis has SW shims)
  const fn = new Function(swCode);
  fn();
}

describe('Service worker offline interception', () => {
  beforeEach(async () => {
    setupGlobals();
    await loadSW();
  });

  it('intercepts /v1/chat/completions when offline and returns 503 with X-Eco-Offline', async () => {
    expect(fetchHandler).not.toBeNull();

    // Simulate offline: fetch will throw TypeError
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    let respondedWith: Response | null = null;
    const event = {
      request: new Request('https://api.econetwork.ai/v1/chat/completions', {
        method: 'POST',
      }),
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event);

    // Wait for the promise chain to resolve
    await vi.waitFor(() => expect(respondedWith).not.toBeNull());

    expect(respondedWith!.status).toBe(503);
    expect(respondedWith!.headers.get('X-Eco-Offline')).toBe('true');
    expect(respondedWith!.headers.get('Content-Type')).toBe('application/json');

    const body = await respondedWith!.json();
    expect(body.error).toBe('offline');

    globalThis.fetch = originalFetch;
  });

  it('returns JSON body with error "offline"', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    let respondedWith: Response | null = null;
    const event = {
      request: new Request('https://api.econetwork.ai/v1/chat/completions', {
        method: 'POST',
      }),
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull());

    const body = await respondedWith!.json();
    expect(body.error).toBe('offline');
    expect(body.message).toBeTruthy();

    globalThis.fetch = originalFetch;
  });

  it('does NOT intercept /v1/chat/completions when online (passes through)', async () => {
    const mockResponse = new Response('{"ok": true}', { status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    let respondedWith: Response | null = null;
    const event = {
      request: new Request('https://api.econetwork.ai/v1/chat/completions', {
        method: 'POST',
      }),
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull());

    // When online, fetch succeeds and response passes through
    expect(respondedWith!.status).toBe(200);

    globalThis.fetch = originalFetch;
  });

  it('does NOT intercept /v1/models even when offline', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    let respondedWithCalled = false;
    const event = {
      request: new Request('https://api.econetwork.ai/v1/models'),
      respondWith: () => {
        respondedWithCalled = true;
      },
    };

    fetchHandler!(event);

    // Wait a tick to ensure the handler has had time to potentially call respondWith
    await new Promise((r) => setTimeout(r, 50));

    // /v1/models should NOT be intercepted (falls through to the existing NetworkOnly handler)
    expect(respondedWithCalled).toBe(false);

    globalThis.fetch = originalFetch;
  });

  it('does not intercept or cache auth, app API, or model proxy routes', async () => {
    const sensitiveRoutes = [
      'https://econetwork.ai/api/auth/session',
      'https://econetwork.ai/api/gate',
      'https://econetwork.ai/api/local-models/HuggingFaceTB/SmolLM3-3B/resolve/main/model.onnx',
      'https://econetwork.ai/v1/models',
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    for (const route of sensitiveRoutes) {
      let respondedWithCalled = false;
      const event = {
        request: new Request(route),
        respondWith: () => {
          respondedWithCalled = true;
        },
      };

      fetchHandler!(event);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(respondedWithCalled, route).toBe(false);
      expect(mockCache.put, route).not.toHaveBeenCalled();
    }

    globalThis.fetch = originalFetch;
  });

  it('serves reviewed ORT runtime assets from cache when offline', async () => {
    const originalFetch = globalThis.fetch;
    const request = new Request('https://econetwork.ai/api/ort/ort-wasm-simd-threaded.asyncify.wasm');
    const cachedAsset = new Response('cached wasm', { status: 200 });
    mockCacheStore.set(request.url, cachedAsset);
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    let respondedWith: Response | null = null;
    const event = {
      request,
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull());

    expect(respondedWith!.status).toBe(200);
    await expect(respondedWith!.text()).resolves.toBe('cached wasm');
    expect(mockCache.match).toHaveBeenCalledWith(request);
    expect(globalThis.fetch).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it('serves the build-copied static engine assets from cache when offline (litert-wasm/, ort/)', async () => {
    // The engine assets moved from the /api routes (which 404 on Vercel —
    // function bundles omit node_modules) to build-copied statics; the SW
    // must treat the new paths as cacheable engine assets too.
    const originalFetch = globalThis.fetch;
    const request = new Request('https://econetwork.ai/litert-wasm/litertlm_wasm_internal.wasm');
    const cachedAsset = new Response('cached litert wasm', { status: 200 });
    mockCacheStore.set(request.url, cachedAsset);
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    let respondedWith: Response | null = null;
    const event = {
      request,
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull());

    expect(respondedWith!.status).toBe(200);
    await expect(respondedWith!.text()).resolves.toBe('cached litert wasm');
    expect(globalThis.fetch).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it('caches reviewed ORT runtime assets on the first online request', async () => {
    const originalFetch = globalThis.fetch;
    const request = new Request('https://econetwork.ai/api/ort/ort-wasm-simd-threaded.asyncify.mjs');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('fresh mjs', { status: 200 }));

    let respondedWith: Response | null = null;
    const event = {
      request,
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull());

    expect(respondedWith!.status).toBe(200);
    expect(mockCache.put).toHaveBeenCalledWith(request, expect.any(Response));

    globalThis.fetch = originalFetch;
  });

  it('navigation requests show an offline document instead of cached app HTML', async () => {
    const cachedShell = new Response('<!DOCTYPE html><html>home shell</html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    mockCacheStore.set('https://econetwork.ai/', cachedShell);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    let respondedWith: Response | null = null;

    // jsdom's Request constructor doesn't support mode: 'navigate',
    // so we create a plain object that mimics the request shape.
    const navRequest = new Request('https://econetwork.ai/');
    const event = {
      request: {
        url: navRequest.url,
        mode: 'navigate' as RequestMode,
        method: 'GET',
        headers: navRequest.headers,
        clone: () => navRequest,
      },
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res ?? null; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event as unknown as Parameters<NonNullable<typeof fetchHandler>>[0]);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull(), { timeout: 2000 });

    expect(respondedWith).toBeTruthy();
    expect(respondedWith!.status).toBe(503);
    expect(respondedWith!.headers.get('X-Eco-Offline')).toBe('true');
    expect(await respondedWith!.text()).toContain('Eco needs a connection');

    globalThis.fetch = originalFetch;
  });

  it('navigation requests ignore stale cached chat shells when offline', async () => {
    const cachedChatShell = new Response('<!DOCTYPE html><html>chat shell</html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    mockCacheStore.set('https://econetwork.ai/chat', cachedChatShell);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    let respondedWith: Response | null = null;
    const navRequest = new Request('https://econetwork.ai/');
    const event = {
      request: {
        url: navRequest.url,
        mode: 'navigate' as RequestMode,
        method: 'GET',
        headers: navRequest.headers,
        clone: () => navRequest,
      },
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res ?? null; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event as unknown as Parameters<NonNullable<typeof fetchHandler>>[0]);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull(), { timeout: 2000 });

    const body = await respondedWith!.text();
    expect(respondedWith!.status).toBe(503);
    expect(body).toContain('Eco needs a connection');
    expect(body).not.toContain('chat shell');

    globalThis.fetch = originalFetch;
  });

  it('caches successful static assets', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('console.log("ok")', {
        status: 200,
        headers: { 'Content-Type': 'application/javascript' },
      }),
    );

    let respondedWith: Response | null = null;
    const request = new Request('https://econetwork.ai/_next/static/chunks/app.js');
    const event = {
      request,
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull());

    expect(respondedWith!.status).toBe(200);
    expect(mockCache.put).toHaveBeenCalledTimes(1);
    expect(mockCacheStore.get(request.url)).toBeTruthy();

    globalThis.fetch = originalFetch;
  });

  it('does not cache failed static asset responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('missing chunk', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    let respondedWith: Response | null = null;
    const request = new Request('https://econetwork.ai/_next/static/chunks/missing.js');
    const event = {
      request,
      respondWith: (r: Response | Promise<Response>) => {
        if (r instanceof Promise) {
          r.then((res) => { respondedWith = res; });
        } else {
          respondedWith = r;
        }
      },
    };

    fetchHandler!(event);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull());

    expect(respondedWith!.status).toBe(404);
    expect(mockCache.put).not.toHaveBeenCalled();
    expect(mockCacheStore.get(request.url)).toBeUndefined();

    globalThis.fetch = originalFetch;
  });

  it('install event does not pre-cache route HTML', async () => {
    expect(installHandler).not.toBeNull();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input.toString();
      return new Response(`shell:${path}`, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });

    let waitUntilPromise: Promise<unknown> | null = null;
    const event = {
      waitUntil: (p: Promise<unknown>) => { waitUntilPromise = p; },
    };

    installHandler!(event);

    if (waitUntilPromise) {
      await waitUntilPromise;
    }

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockCache.put).not.toHaveBeenCalled();
    expect(mockCacheStore.get('/')).toBeUndefined();
    expect(mockCacheStore.get('/chat')).toBeUndefined();
    globalThis.fetch = originalFetch;
  });

  it('install event stays non-blocking when route HTML would fail', async () => {
    expect(installHandler).not.toBeNull();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input.toString();
      if (path === '/chat') {
        throw new TypeError('Failed to fetch');
      }

      return new Response('<!DOCTYPE html><html>home shell</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });

    let waitUntilPromise: Promise<unknown> | null = null;
    const event = {
      waitUntil: (p: Promise<unknown>) => { waitUntilPromise = p; },
    };

    installHandler!(event);

    if (waitUntilPromise) {
      await waitUntilPromise;
    }

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockCacheStore.get('/')).toBeUndefined();
    expect(mockCacheStore.get('/chat')).toBeUndefined();
    expect(mockCache.put).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it('install event never lets gate redirects poison offline fallback', async () => {
    expect(installHandler).not.toBeNull();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input.toString();
      if (path === '/') {
        return {
          ok: true,
          redirected: true,
          url: 'https://econetwork.ai/gate?returnTo=%2F',
          clone() {
            return this;
          },
        } as unknown as Response;
      }

      return new Response(`shell:${path}`, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });

    let waitUntilPromise: Promise<unknown> | null = null;
    const event = {
      waitUntil: (p: Promise<unknown>) => { waitUntilPromise = p; },
    };

    installHandler!(event);

    if (waitUntilPromise) {
      await waitUntilPromise;
    }

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockCacheStore.get('/')).toBeUndefined();
    expect(mockCacheStore.get('/chat')).toBeUndefined();
    expect(mockCache.put).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });
});
