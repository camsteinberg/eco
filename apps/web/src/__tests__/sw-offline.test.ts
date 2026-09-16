// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Service worker offline interception tests.
 *
 * We evaluate sw.js in a minimal SW-like environment, then invoke
 * the registered fetch handler to verify offline behavior.
 */

const ORIGIN = 'https://econetwork.ai';
const SHELL_CACHE = 'eco-shell-v1';

// Minimal Service Worker globals
let fetchHandler: ((event: { request: Request; respondWith: (r: Response | Promise<Response>) => void }) => void) | null = null;
let installHandler: ((event: { waitUntil: (p: Promise<unknown>) => void }) => void) | null = null;
let activateHandler: ((event: { waitUntil: (p: Promise<unknown>) => void }) => void) | null = null;
let messageHandler:
  | ((event: { data: unknown; ports?: unknown[]; waitUntil: (p: Promise<unknown>) => void }) => void)
  | null = null;

function resetHandlers() {
  fetchHandler = null;
  installHandler = null;
  activateHandler = null;
  messageHandler = null;
}

// Mock caches API. The app/transformers cache keeps its original semantics
// (existing cases reach into mockCacheStore directly); the shell cache is a
// second, name-keyed store whose keys are absolute URLs, matching how a real
// Cache normalizes a string key against the scope origin.
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

const shellStore = new Map<string, Response>();
function shellKey(req: Request | string): string {
  return new URL(typeof req === 'string' ? req : req.url, ORIGIN).toString();
}
// Lets a test stall one specific write, which is how the interleaving of two
// concurrent captures is made deterministic rather than timing-dependent.
let shellPutDelay: ((key: string) => Promise<void> | undefined) | null = null;

const shellCache = {
  put: vi.fn(async (req: Request | string, res: Response) => {
    const key = shellKey(req);
    await shellPutDelay?.(key);
    shellStore.set(key, res);
  }),
  // A real Cache hands out a fresh body every time; the mock must too, or the
  // manifest read during a prune would consume the stored entry.
  match: vi.fn(async (req: Request | string) => shellStore.get(shellKey(req))?.clone()),
  keys: vi.fn(async () => [...shellStore.keys()].map((url) => new Request(url))),
  delete: vi.fn(async (req: Request | string) => shellStore.delete(shellKey(req))),
  addAll: vi.fn(async () => {}),
};

// What caches.keys() reports — the activate sweep reads it.
let mockCacheNames: string[] = [];
const deletedCaches: string[] = [];

function setupGlobals() {
  resetHandlers();
  mockCacheStore.clear();
  shellStore.clear();
  mockCacheNames = [];
  deletedCaches.length = 0;
  shellPutDelay = null;
  for (const mock of [mockCache.put, mockCache.match, mockCache.addAll,
    shellCache.put, shellCache.match, shellCache.keys, shellCache.delete]) {
    mock.mockClear();
  }

  // Minimal SW scope
  const scope: Record<string, unknown> = {
    addEventListener: (type: string, handler: (...args: unknown[]) => void) => {
      if (type === 'fetch') fetchHandler = handler as typeof fetchHandler;
      if (type === 'install') installHandler = handler as typeof installHandler;
      if (type === 'activate') activateHandler = handler as typeof activateHandler;
      if (type === 'message') messageHandler = handler as typeof messageHandler;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => []) },
    caches: {
      open: vi.fn(async (name: string) => (name === SHELL_CACHE ? shellCache : mockCache)),
      keys: vi.fn(async () => mockCacheNames),
      // A real caches.match searches every cache.
      match: vi.fn(async (req: Request | string) =>
        (await mockCache.match(req)) ?? (await shellCache.match(req))),
      delete: vi.fn(async (name: string) => {
        deletedCaches.push(name);
        return true;
      }),
    },
    location: new URL('https://econetwork.ai/'),
    self: undefined as unknown,
  };
  scope['self'] = scope;

  // Assign to globalThis for eval
  Object.assign(globalThis, scope);
  (globalThis as Record<string, unknown>)['self'] = scope;
}

// jsdom's Request rejects mode: 'navigate', so a navigation is a plain object
// carrying only the fields the handler reads.
function navigationEvent(url: string) {
  const navRequest = new Request(url);
  let respondedWith: Response | null = null;
  const waited: Promise<unknown>[] = [];
  const event = {
    request: {
      url: navRequest.url,
      mode: 'navigate' as RequestMode,
      method: 'GET',
      headers: navRequest.headers,
      clone: () => navRequest,
    },
    waitUntil: (p: Promise<unknown>) => { waited.push(p); },
    respondWith: (r: Response | Promise<Response>) => {
      if (r instanceof Promise) {
        void r.then((res) => { respondedWith = res ?? null; });
      } else {
        respondedWith = r;
      }
    },
  };

  // Resolves once the response is settled AND every capture started inside
  // waitUntil has finished.
  const dispatch = async (): Promise<Response> => {
    fetchHandler!(event as unknown as Parameters<NonNullable<typeof fetchHandler>>[0]);
    await vi.waitFor(() => expect(respondedWith).not.toBeNull(), { timeout: 2000 });
    await Promise.all(waited);
    return respondedWith!;
  };

  return { dispatch };
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

  it('renders the offline card left-aligned, inside the viewport, on a neutral dark surface', async () => {
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

    // One alignment for the whole card — centring the heading alone over
    // left-aligned body copy and button orphaned it.
    expect(body).not.toContain('text-align: center');

    // Without border-box the 32px padding sits outside the width cap, so the
    // card renders 393px wide and overflows a 375px screen.
    expect(body).toContain('box-sizing: border-box');

    // Dark cards everywhere else in the app are neutral, not warm brown.
    expect(body).toContain('main { background: #242424; border-color: #333333; }');

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

/**
 * The chat app shell.
 *
 * The shell and every chunk it references are captured from ONE successful
 * navigation response, so a stored shell is always one build; a capture that
 * cannot store every asset stores nothing.
 */
describe('Service worker chat app shell', () => {
  const CHAT_PAGE_CHUNK = '/_next/static/chunks/app/(app)/chat/page-abc.js';
  const MAIN_CHUNK = '/_next/static/chunks/main-def.js';
  const CSS = '/_next/static/css/xyz.css';
  const FONT = '/_next/static/media/font.woff2';
  const NEW_PAGE_CHUNK = '/_next/static/chunks/app/(app)/chat/new/page-ghi.js';
  const MANIFEST_KEY = `${ORIGIN}/__eco-shell-manifest/chat`;
  const NEW_MANIFEST_KEY = `${ORIGIN}/__eco-shell-manifest/chat/new`;
  const CSP = "default-src 'self'; script-src 'self' 'nonce-abc123'";

  // The flight payload lists main-def without the /_next/ prefix; the route
  // group parentheses in the page chunk must survive extraction.
  const SHELL_HTML = `<!DOCTYPE html><html><head>`
    + `<link rel="stylesheet" href="${CSS}"/></head><body>`
    + `<script src="${CHAT_PAGE_CHUNK}"></script>`
    + `<script>self.__next_f.push([1,"static/chunks/main-def.js"])</script>`
    + `</body></html>`;

  // /chat/new shares the stylesheet and main chunk, and adds its own page chunk.
  const NEW_SHELL_HTML = `<!DOCTYPE html><html><head>`
    + `<link rel="stylesheet" href="${CSS}"/></head><body>`
    + `<script src="${NEW_PAGE_CHUNK}"></script>`
    + `<script>self.__next_f.push([1,"static/chunks/main-def.js"])</script>`
    + `</body></html>`;

  const CSS_TEXT = `@font-face{font-family:x;src:url(${FONT}) format("woff2")}`;

  function htmlResponse(body: string, init: ResponseInit = {}) {
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP },
      ...init,
    });
  }

  /** Serves the shell HTML plus its assets; `failing` 404s one asset path. */
  function onlineFetch(failing?: string) {
    return vi.fn(async (input: RequestInfo | URL) => {
      // Navigations arrive as the request object, asset fetches as a URL string.
      const raw = typeof input === 'string'
        ? input
        : (input as { url?: string }).url ?? input.toString();
      const path = new URL(raw, ORIGIN).pathname;
      if (failing !== undefined && path === failing) {
        return new Response('missing', { status: 404 });
      }
      if (path === '/chat') return htmlResponse(SHELL_HTML);
      if (path === '/chat/new') return htmlResponse(NEW_SHELL_HTML);
      if (path === CSS) {
        return new Response(CSS_TEXT, { status: 200, headers: { 'Content-Type': 'text/css' } });
      }
      return new Response(`asset:${path}`, { status: 200 });
    });
  }

  beforeEach(async () => {
    setupGlobals();
    await loadSW();
  });

  it('captures the chat shell, its chunks and its fonts from one online navigation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = onlineFetch();

    const response = await navigationEvent(`${ORIGIN}/chat`).dispatch();
    expect(response.status).toBe(200);

    // The HTML, keyed by the bare pathname, and every asset it references.
    const shell = shellStore.get(`${ORIGIN}/chat`);
    expect(shell).toBeTruthy();
    expect(await shell!.clone().text()).toContain('page-abc.js');
    expect(shell!.headers.get('Content-Type')).toContain('text/html');

    for (const asset of [CHAT_PAGE_CHUNK, MAIN_CHUNK, CSS, FONT]) {
      expect(shellStore.has(`${ORIGIN}${asset}`), asset).toBe(true);
    }

    const manifest = shellStore.get(MANIFEST_KEY);
    expect(manifest).toBeTruthy();
    await expect(manifest!.clone().json()).resolves.toEqual(
      [CHAT_PAGE_CHUNK, MAIN_CHUNK, CSS, FONT].map((p) => `${ORIGIN}${p}`).sort(),
    );

    globalThis.fetch = originalFetch;
  });

  it('keeps the network response headers on the stored shell, CSP nonce included', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = onlineFetch();

    await navigationEvent(`${ORIGIN}/chat`).dispatch();

    // CSP is header-only here — there is no <meta http-equiv> to fall back on,
    // so a shell served without this header would run with no policy at all.
    const shell = shellStore.get(`${ORIGIN}/chat`);
    expect(shell!.headers.get('Content-Security-Policy')).toBe(CSP);

    globalThis.fetch = originalFetch;
  });

  it('serializes overlapping captures so neither route prunes the other away', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = onlineFetch();

    // The harmful window: /chat/new has written its assets but not yet its
    // manifest when /chat prunes, so /chat's manifest is the only keep-list and
    // the new-page chunk is deleted under it. Stalling that one write puts both
    // captures in exactly that order — unless they are serialized, in which case
    // the second capture has not started yet and the stall changes nothing.
    shellPutDelay = (key) =>
      key === `${ORIGIN}/chat/new` ? new Promise<void>((r) => setTimeout(r, 50)) : undefined;

    const first = navigationEvent(`${ORIGIN}/chat`);
    const second = navigationEvent(`${ORIGIN}/chat/new`);
    await Promise.all([first.dispatch(), second.dispatch()]);

    expect(shellStore.has(`${ORIGIN}/chat`)).toBe(true);
    expect(shellStore.has(`${ORIGIN}/chat/new`)).toBe(true);
    expect(shellStore.has(MANIFEST_KEY)).toBe(true);
    expect(shellStore.has(NEW_MANIFEST_KEY)).toBe(true);

    for (const asset of [CHAT_PAGE_CHUNK, NEW_PAGE_CHUNK, MAIN_CHUNK, CSS, FONT]) {
      expect(shellStore.has(`${ORIGIN}${asset}`), asset).toBe(true);
    }

    globalThis.fetch = originalFetch;
  });

  it('never captures a gate redirect or an error response as the shell', async () => {
    const originalFetch = globalThis.fetch;

    // `redirected` is a prototype getter on Response; shadow it on the instance.
    const redirected = htmlResponse(SHELL_HTML);
    Object.defineProperty(redirected, 'redirected', { value: true });
    globalThis.fetch = vi.fn().mockResolvedValue(redirected);
    await navigationEvent(`${ORIGIN}/chat`).dispatch();
    expect(shellStore.size, 'redirect captured').toBe(0);

    globalThis.fetch = vi.fn().mockResolvedValue(htmlResponse('unauthorized', { status: 401 }));
    await navigationEvent(`${ORIGIN}/chat`).dispatch();
    expect(shellStore.size, '401 captured').toBe(0);

    globalThis.fetch = originalFetch;
  });

  it('serves the captured shell when a chat reload is offline', async () => {
    shellStore.set(`${ORIGIN}/chat`, htmlResponse('<!DOCTYPE html><html>captured chat shell</html>'));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const response = await navigationEvent(`${ORIGIN}/chat`).dispatch();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('captured chat shell');

    globalThis.fetch = originalFetch;
  });

  it('falls back to the offline document when no shell has been captured', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const response = await navigationEvent(`${ORIGIN}/chat`).dispatch();

    expect(response.status).toBe(503);
    expect(response.headers.get('X-Eco-Offline')).toBe('true');
    expect(await response.text()).toContain('Eco needs a connection');

    globalThis.fetch = originalFetch;
  });

  it('does not serve the chat shell for another route', async () => {
    shellStore.set(`${ORIGIN}/chat`, htmlResponse('<!DOCTYPE html><html>captured chat shell</html>'));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const response = await navigationEvent(`${ORIGIN}/privacy`).dispatch();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain('Eco needs a connection');
    expect(body).not.toContain('captured chat shell');

    globalThis.fetch = originalFetch;
  });

  it('stores neither HTML nor manifest when one asset cannot be fetched', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = onlineFetch(MAIN_CHUNK);

    const response = await navigationEvent(`${ORIGIN}/chat`).dispatch();

    // The navigation itself is untouched by the failed capture.
    expect(response.status).toBe(200);
    expect(shellStore.has(`${ORIGIN}/chat`)).toBe(false);
    expect(shellStore.has(MANIFEST_KEY)).toBe(false);

    globalThis.fetch = originalFetch;
  });

  it('activate keeps the shell cache and still sweeps unknown caches', async () => {
    expect(activateHandler).not.toBeNull();
    mockCacheNames = ['eco-v5', SHELL_CACHE, 'eco-model-abc', 'transformers-cache', 'some-old-cache'];

    let waitUntilPromise: Promise<unknown> | null = null;
    activateHandler!({ waitUntil: (p: Promise<unknown>) => { waitUntilPromise = p; } });
    if (waitUntilPromise) await waitUntilPromise;

    expect(deletedCaches).toContain('some-old-cache');
    expect(deletedCaches).not.toContain(SHELL_CACHE);
    expect(deletedCaches).not.toContain('eco-v5');
  });

  it('the client-state reset deletes the shell cache too', async () => {
    expect(messageHandler).not.toBeNull();

    let waitUntilPromise: Promise<unknown> | null = null;
    messageHandler!({
      data: { type: 'eco-client-state-reset' },
      waitUntil: (p: Promise<unknown>) => { waitUntilPromise = p; },
    });
    if (waitUntilPromise) await waitUntilPromise;

    expect(deletedCaches).toContain(SHELL_CACHE);
    expect(deletedCaches).toContain('eco-v5');
  });
});
