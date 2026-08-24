// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
// @vitest-environment node

/**
 * Phase H — download.ts unit tests.
 *
 * Runs under the `node` environment (not jsdom): these tests exercise the
 * web-platform fetch/Response/Blob/ReadableStream surface directly, and
 * jsdom's polyfill does NOT faithfully preserve a streamed binary body
 * through `new Response(stream).blob()` (it mangles the byte count). Node's
 * undici implementation matches real browsers, so the streaming download
 * path is verified against faithful Response/Blob semantics here.
 *
 * Tests use an in-memory CacheStorage fake (the same shape as Phase G's
 * storage.test.ts) and a fake fetcher. The two important regression
 * checks live here:
 *
 *  - Bug #4 regression: a CDN response with content-length stripped on
 *    chunked transfer is fetched, stored, and subsequently passes
 *    storage.verify + countCached.
 *
 *  - L6 MEDIUM-04: the orchestrator never calls HEAD. Sizes come from
 *    the plan, so the "double HEAD" path that exists in the legacy
 *    code can't even be exercised here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  CacheApiStorage,
  type CacheLike,
  type CacheStorageLike,
  countCached,
  type FileSpec,
  type Storage,
} from '../storage';
import {
  type DownloadPlan,
  DownloadAbortedError,
  DownloadFailedError,
  DownloadIntegrityError,
  DownloadResolverMissingError,
  InsufficientStorageError,
  cancelDownload,
  downloadByPlan,
  downloadModel,
  hasDownloadPlanResolver,
  isModelFullyCached,
  listActiveDownloads,
  probeBlobStorage,
  setDownloadPlanResolver,
} from '../download';
import { recordEvidence } from '../../evidence/ledger';
import type { ModelConfig } from '../../types';

// download.ts records download-fail rows through the ledger + device profile as
// direct module imports (not seams). This file runs under the `node` env (no
// localStorage), so we spy on those modules to observe the origin write.
vi.mock('../../evidence/ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../evidence/ledger')>()),
  recordEvidence: vi.fn(),
}));
vi.mock('../../device/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../device/profile')>()),
  getDeviceProfile: vi.fn(() => ({
    browserClass: 'chromium' as const,
    webgpuSupport: 'webgpu' as const,
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto' as const,
  })),
}));

// ─── In-memory CacheStorage fake ───────────────────────────────────────────

class MemoryCache implements CacheLike {
  private readonly store = new Map<string, Response>();

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const url = requestKey(request);
    // Model real Cache.put: it reads the response body to completion before the
    // promise resolves. Buffer here rather than storing a lazy stream clone —
    // otherwise a streamed body (putStreamed) wouldn't be consumed until a much
    // later match(), after the caller has already swept its source parts. The
    // zero-retention streamed store relies on this drain-before-resolve.
    const headers = new Headers(response.headers);
    const buffered = await response.blob();
    this.store.set(url, new Response(buffered, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }));
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = requestKey(request);
    const cached = this.store.get(url);
    return cached ? cached.clone() : undefined;
  }

  async keys(): Promise<readonly Request[]> {
    return Array.from(this.store.keys()).map((url) => new Request(url));
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(requestKey(request));
  }
}

class MemoryCacheStorage implements CacheStorageLike {
  private readonly caches = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.caches.keys());
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

function requestKey(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// ─── Fake fetcher ──────────────────────────────────────────────────────────

type FixtureBody = Uint8Array | { chunks: Uint8Array[] };

type Fixture = {
  body: FixtureBody;
  /** When set, omit content-length on the response (mimics chunked transfer). */
  stripContentLength?: boolean;
  status?: number;
  delayMs?: number;
};

function createFetcher(fixtures: Record<string, Fixture>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    const fixture = fixtures[url];
    if (!fixture) {
      return new Response(null, { status: 404 });
    }
    const status = fixture.status ?? 200;
    if (status !== 200) {
      return new Response(null, { status });
    }

    if (fixture.delayMs) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve(undefined), fixture.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }

    const body = 'chunks' in fixture.body
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of (fixture.body as { chunks: Uint8Array[] }).chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        })
      : fixture.body;

    const headers: HeadersInit = fixture.stripContentLength
      ? { 'transfer-encoding': 'chunked' }
      : { 'content-length': String(byteLength(fixture.body)) };

    return new Response(body as unknown as BodyInit, { status: 200, headers });
  }) as typeof fetch;
}

function byteLength(body: FixtureBody): number {
  if ('chunks' in body) {
    return body.chunks.reduce((sum, c) => sum + c.byteLength, 0);
  }
  return body.byteLength;
}

function byteArr(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

// ─── Test fixtures ─────────────────────────────────────────────────────────

const MODEL_ID = 'local/qwen3-0.6b';

/**
 * Zeroes the transient-retry backoff for tests that drive a retry path. What a
 * retry DOES is asserted here; the real jittered schedule is asserted directly
 * in retry.test.ts, so paying seconds of real sleep here would only slow the
 * suite.
 */
const NO_RETRY_BACKOFF = 0;

function makePlan(files: ReadonlyArray<{ url: string; body: Uint8Array }>): DownloadPlan {
  return {
    modelId: MODEL_ID,
    files: files.map((f) => ({ url: f.url, sizeBytes: f.body.byteLength })),
  };
}

let cacheStorage: MemoryCacheStorage;
let storage: CacheApiStorage;

beforeEach(() => {
  cacheStorage = new MemoryCacheStorage();
  storage = new CacheApiStorage(cacheStorage);
  setDownloadPlanResolver(null);
});

afterEach(async () => {
  // Make sure nothing leaks into the next test.
  for (const id of listActiveDownloads()) {
    await cancelDownload(id);
  }
  setDownloadPlanResolver(null);
});

// ─── Happy path ────────────────────────────────────────────────────────────

describe('downloadByPlan — cold cache', () => {
  it('fetches every file and writes Eco-Cache-Size on each entry', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3, 4, 5) };
    const b = { url: 'https://test/b.bin', body: byteArr(10, 11, 12) };
    const plan = makePlan([a, b]);

    const result = await downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({
        [a.url]: { body: a.body },
        [b.url]: { body: b.body },
      }),
    });

    expect(result.filesFetched).toBe(2);
    expect(result.filesSkipped).toBe(0);
    expect(result.bytesDownloaded).toBe(a.body.byteLength + b.body.byteLength);

    const files: FileSpec[] = plan.files.map((f) => ({ url: f.url, sizeBytes: f.sizeBytes }));
    expect(await countCached(storage, plan.modelId, files)).toBe(2);
  });

  it('reports loaded === total at completion', async () => {
    const body = byteArr(1, 2, 3, 4);
    const plan = makePlan([{ url: 'https://test/x.bin', body }]);

    const result = await downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({ 'https://test/x.bin': { body } }),
    });

    expect(result.tracker.snapshot().percent).toBeCloseTo(1);
  });
});

// ─── CDN transport + source-agnostic single-GET integrity ──────────────────

describe('downloadByPlan — fetchUrl transport + single-GET SHA', () => {
  it('fetches from fetchUrl but stores under the stable url identity', async () => {
    const body = byteArr(1, 2, 3, 4, 5);
    const identity = 'https://test/a.bin'; // stable storage key (proxy path in prod)
    const cdn = 'https://cdn.example.com/a.bin'; // transport source (R2 in prod)
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: identity, fetchUrl: cdn, sizeBytes: body.byteLength }],
    };

    // Only the CDN url serves bytes; the identity url is not a fixture (would 404).
    const result = await downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({ [cdn]: { body } }),
    });

    expect(result.filesFetched).toBe(1);
    // Stored under the STABLE identity, not the CDN url — so a later kill-switch
    // (fetchUrl back to the proxy) still finds the cached file. This is the
    // property that makes the CDN flag safe to toggle.
    expect(await storage.has({ modelId: plan.modelId, url: identity })).toBe(true);
    expect(await storage.has({ modelId: plan.modelId, url: cdn })).toBe(false);
  });

  it('verifies a single-GET body against a matching LFS SHA-256 oid', async () => {
    const body = byteArr(9, 8, 7, 6, 5, 4);
    const oid = bytesToHex(sha256(body)); // 64-hex LFS content sha256
    const url = 'https://test/w.bin';
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url, sizeBytes: body.byteLength, oid }],
    };

    const result = await downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({ [url]: { body } }),
    });
    expect(result.filesFetched).toBe(1);
    expect(await storage.has({ modelId: plan.modelId, url })).toBe(true);
  });

  it('throws DownloadIntegrityError on a single-GET SHA-256 mismatch and stores nothing', async () => {
    const body = byteArr(1, 1, 1, 1);
    const wrongOid = bytesToHex(sha256(byteArr(2, 2, 2, 2))); // 64-hex, but not this body
    const url = 'https://test/bad.bin';
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url, sizeBytes: body.byteLength, oid: wrongOid }],
    };

    await expect(
      downloadByPlan(plan, { storage, fetcher: createFetcher({ [url]: { body } }) }),
    ).rejects.toThrow(DownloadIntegrityError);

    // A corrupt download must never stamp a cache entry.
    expect(await storage.has({ modelId: plan.modelId, url })).toBe(false);
  });

  it('skips SHA verification when the oid is a git-blob sha1 (40 hex)', async () => {
    const body = byteArr(3, 3, 3);
    const gitBlobOid = 'a'.repeat(40); // sha1, not an LFS content sha256
    const url = 'https://test/config.json';
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url, sizeBytes: body.byteLength, oid: gitBlobOid }],
    };

    const result = await downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({ [url]: { body } }),
    });
    expect(result.filesFetched).toBe(1); // no throw despite oid != sha256(body)
  });
});

// ─── CDN → proxy transport fallback ────────────────────────────────────────
//
// A file's bytes normally come from `fetchUrl` (the R2 CDN when configured);
// `url` is the stable same-origin proxy path Eco always serves. On a
// transport-level CDN failure — a 5xx/408/429, a network error, corrupt bytes,
// OR a 403/404 mirror miss (the CDN never received an artifact the proxy still
// re-emits from HF) — the download retries ONCE against the proxy, pinning
// fetchUrl to url, so a CDN outage or an incompletely-mirrored model no longer
// fails downloads with no client-side recovery. Integrity and storage identity
// are unchanged.

describe('downloadByPlan — CDN → proxy transport fallback', () => {
  const IDENTITY = 'https://test/proxy/w.bin'; // stable storage identity (proxy path in prod)
  const CDN = 'https://cdn.example.com/w.bin'; // distinct transport source (R2 in prod)

  /**
   * A fetcher that dispatches per-URL and records every requested URL. Each
   * handler receives the RequestInit and returns a Response (or throws / rejects
   * to simulate a network error). Unmapped URLs 404.
   */
  function dispatch(
    log: string[],
    handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
  ): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;
      log.push(url);
      const handler = handlers[url];
      if (!handler) return new Response(null, { status: 404 });
      return handler(init);
    }) as typeof fetch;
  }

  function okBody(body: Uint8Array): Response {
    return new Response(body as unknown as BodyInit, {
      status: 200,
      headers: { 'content-length': String(body.byteLength) },
    });
  }

  /** Answer a Range request with a 206 slice (or the full 200 body when unranged). */
  function rangeResponse(full: Uint8Array, init?: RequestInit): Response {
    const rangeHeader = init?.headers ? new Headers(init.headers).get('range') : null;
    if (!rangeHeader) return okBody(full);
    const match = /bytes=(\d+)-(\d+)?/.exec(rangeHeader);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] != null
      ? Math.min(Number(match[2]), full.byteLength - 1)
      : full.byteLength - 1;
    const slice = full.subarray(start, end + 1);
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': String(slice.byteLength),
        'content-range': `bytes ${start}-${end}/${full.byteLength}`,
      },
    });
  }

  it('falls back to the proxy when the CDN whole-file fetch returns 503', async () => {
    const body = byteArr(1, 2, 3, 4, 5);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength }],
    };
    const log: string[] = [];

    const result = await downloadByPlan(plan, {
      storage,
      retryBaseDelayMs: NO_RETRY_BACKOFF,
      fetcher: dispatch(log, {
        [CDN]: () => new Response(null, { status: 503 }),
        [IDENTITY]: () => okBody(body),
      }),
    });

    expect(result.filesFetched).toBe(1);
    // Stored under the stable identity, never the CDN url.
    expect(await storage.has({ modelId: MODEL_ID, url: IDENTITY })).toBe(true);
    expect(await storage.has({ modelId: MODEL_ID, url: CDN })).toBe(false);
    // Both sources were exercised: CDN first, then the proxy fallback.
    expect(log).toContain(CDN);
    expect(log).toContain(IDENTITY);
  });

  it('falls back to the proxy when the CDN fetch throws a network error', async () => {
    const body = byteArr(9, 9, 9);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength }],
    };
    const log: string[] = [];

    const result = await downloadByPlan(plan, {
      storage,
      retryBaseDelayMs: NO_RETRY_BACKOFF,
      fetcher: dispatch(log, {
        [CDN]: () => { throw new TypeError('Failed to fetch'); },
        [IDENTITY]: () => okBody(body),
      }),
    });

    expect(result.filesFetched).toBe(1);
    expect(await storage.has({ modelId: MODEL_ID, url: IDENTITY })).toBe(true);
    expect(log).toContain(CDN);
    expect(log).toContain(IDENTITY);
  });

  it('falls back on a CDN Range-chunk failure after per-chunk retries are spent', async () => {
    const CHUNK = 4; // tiny threshold so the small body exercises the chunk path
    const body = Uint8Array.from({ length: 10 }, (_, i) => (i % 251) + 1);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength, oid: oidOf(body) }],
    };
    const log: string[] = [];

    const result = await downloadByPlan(plan, {
      storage,
      rangeChunkBytes: CHUNK,
      retryBaseDelayMs: NO_RETRY_BACKOFF,
      fetcher: dispatch(log, {
        [CDN]: () => new Response(null, { status: 503 }),
        [IDENTITY]: (init) => rangeResponse(body, init),
      }),
    });

    expect(result.filesFetched).toBe(1);
    expect((await storage.get({ modelId: MODEL_ID, url: IDENTITY }))!.sizeBytes)
      .toBe(body.byteLength);
    // The CDN was retried (transient 503) before the proxy served the chunks.
    expect(log.filter((u) => u === CDN).length).toBeGreaterThanOrEqual(1);
    expect(log.filter((u) => u === IDENTITY).length).toBeGreaterThanOrEqual(1);
  });

  it('finalizes a chunked download parts-native — get() composes the persisted parts', async () => {
    // The WebKit-mobile fix (2026-07-17): a chunked file is never assembled in
    // memory and never written as a whole-file body. Its persisted parts ARE the
    // terminal storage; finalizeParts stamps a manifest, and get() composes the
    // parts on read (one open at a time). Proof: the identity reads back the
    // exact body from the parts, is flagged parts-native, and the parts remain
    // on disk as the file's storage rather than being swept as a resume aid.
    const CHUNK = 4;
    const body = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
    // No oid: this fixture relies on the size check alone (sha-bearing fixtures
    // cover the integrity path elsewhere).
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: IDENTITY, sizeBytes: body.byteLength }],
    };

    const result = await downloadByPlan(plan, {
      storage,
      rangeChunkBytes: CHUNK,
      fetcher: dispatch([], { [IDENTITY]: (init) => rangeResponse(body, init) }),
    });

    expect(result.filesFetched).toBe(1);
    expect(await storage.isPartsNative({ modelId: MODEL_ID, url: IDENTITY })).toBe(true);
    const stored = await storage.get({ modelId: MODEL_ID, url: IDENTITY });
    const storedBytes = new Uint8Array(await stored!.response.arrayBuffer());
    expect([...storedBytes]).toEqual([...body]);
    // The parts remain — they ARE the storage, not a swept resume aid.
    expect(await partEntries(await storage.listForModel(MODEL_ID))).not.toHaveLength(0);
  });

  it('falls back to the proxy on a CDN 404 (mirror missing the artifact)', async () => {
    // The production bug: a model shipped in the catalog but never mirrored to
    // R2 → every CDN request 404s. The identical path resolves on the proxy
    // (Eco's HF re-emit), so the download must complete there, not fail.
    const body = byteArr(1, 2, 3, 4);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength }],
    };
    const log: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await downloadByPlan(plan, {
      storage,
      fetcher: dispatch(log, {
        [CDN]: () => new Response(null, { status: 404 }),
        [IDENTITY]: () => okBody(body),
      }),
    });

    expect(result.filesFetched).toBe(1);
    expect(await storage.has({ modelId: MODEL_ID, url: IDENTITY })).toBe(true);
    // Both sources exercised: CDN first (the doomed request that detects drift),
    // then the proxy that actually serves.
    expect(log).toContain(CDN);
    expect(log).toContain(IDENTITY);
    // Exactly one warning, naming the mirror miss so drift is visible in the field.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('[eco-model-cdn]');
    expect(warn.mock.calls[0]![0]).toContain('404');
    expect(warn.mock.calls[0]![0]).toContain('mirror is likely missing');
    warn.mockRestore();
  });

  it('falls back to the proxy on a CDN 403 (mirror miss / forbidden object)', async () => {
    const body = byteArr(7, 7, 7, 7, 7);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength }],
    };
    const log: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await downloadByPlan(plan, {
      storage,
      fetcher: dispatch(log, {
        [CDN]: () => new Response(null, { status: 403 }),
        [IDENTITY]: () => okBody(body),
      }),
    });

    expect(result.filesFetched).toBe(1);
    expect(await storage.has({ modelId: MODEL_ID, url: IDENTITY })).toBe(true);
    expect(log).toContain(CDN);
    expect(log).toContain(IDENTITY);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('403');
    warn.mockRestore();
  });

  it('after a mid-file CDN 404 the proxy serves the rest — later chunks never re-probe the CDN', async () => {
    // A partially-mirrored file: the CDN answers the first chunk then 404s. The
    // fallback re-enters the chunked path pinned to the proxy, resuming from the
    // persisted first chunk. The doomed-CDN cost stays bounded to the single
    // failing request — the CDN is hit for offsets 0 and 4, never for offset 8.
    const CHUNK = 4;
    const body = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength, oid: oidOf(body) }],
    };
    const log: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await downloadByPlan(plan, {
      storage,
      rangeChunkBytes: CHUNK,
      fetcher: dispatch(log, {
        [CDN]: (init) => {
          const range = init?.headers ? new Headers(init.headers).get('range') : null;
          // Serve only the first chunk (offset 0); 404 everything after it.
          if (range && /bytes=0-/.test(range)) return rangeResponse(body, init);
          return new Response(null, { status: 404 });
        },
        [IDENTITY]: (init) => rangeResponse(body, init),
      }),
    });

    expect(result.filesFetched).toBe(1);
    expect((await storage.get({ modelId: MODEL_ID, url: IDENTITY }))!.sizeBytes)
      .toBe(body.byteLength);
    // CDN hit exactly twice (chunk 0 served + chunk 1 that 404'd); no doomed
    // per-chunk probe for the tail once the file has fallen back to the proxy.
    expect(log.filter((u) => u === CDN)).toHaveLength(2);
    expect(log.filter((u) => u === IDENTITY).length).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('still throws DownloadFailedError when the proxy also 404s after fallback', async () => {
    // Fallback is a single retry — if the same-origin proxy is ALSO missing the
    // artifact, the download fails honestly rather than looping.
    const body = byteArr(1, 2, 3, 4);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength }],
    };
    const log: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      downloadByPlan(plan, {
        storage,
        fetcher: dispatch(log, {
          [CDN]: () => new Response(null, { status: 404 }),
          [IDENTITY]: () => new Response(null, { status: 404 }),
        }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    // Both were tried, in order, exactly once each — no third attempt.
    expect(log).toEqual([CDN, IDENTITY]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('names the CDN transport URL in the error when a hard 4xx does not fall back', async () => {
    // A 410 Gone is a genuine bad-object error, not mirror drift, so no fallback
    // fires. The thrown message must name the URL actually requested — the CDN
    // source — so field diagnosis is not misdirected to the proxy identity,
    // while the structured `url` stays the stable storage key.
    const CHUNK = 4;
    const body = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength, oid: oidOf(body) }],
    };
    const log: string[] = [];

    const err = await downloadByPlan(plan, {
      storage,
      rangeChunkBytes: CHUNK,
      fetcher: dispatch(log, {
        [CDN]: () => new Response(null, { status: 410 }),
        [IDENTITY]: (init) => rangeResponse(body, init),
      }),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DownloadFailedError);
    expect((err as DownloadFailedError).message).toContain(CDN);
    expect((err as DownloadFailedError).message).not.toContain(IDENTITY);
    expect((err as DownloadFailedError).url).toBe(IDENTITY);
    // No fallback on a hard 4xx that isn't 403/404 — the proxy is never touched.
    expect(log).not.toContain(IDENTITY);
  });

  it('makes no source-switch attempt when fetchUrl is unset', async () => {
    const body = byteArr(1, 2, 3);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, sizeBytes: body.byteLength }],
    };
    const log: string[] = [];

    await expect(
      downloadByPlan(plan, {
        storage,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        fetcher: dispatch(log, { [IDENTITY]: () => new Response(null, { status: 503 }) }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    // The transient retries and nothing more: one attempt plus its two retries,
    // all against the single source. A phantom source switch (the proxy IS the
    // source that just failed) would double this to six.
    expect(log).toEqual([IDENTITY, IDENTITY, IDENTITY]);
  });

  it('does not fall back when aborted mid-fetch (no proxy request)', async () => {
    const body = byteArr(1, 2, 3, 4);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength }],
    };
    const controller = new AbortController();
    const log: string[] = [];

    // Signals when the CDN fetch is actually entered, so the abort lands
    // mid-fetch (not during the earlier verify/preflight passes) — the case
    // the guarantee is about.
    let onCdnEntered: () => void;
    const cdnEntered = new Promise<void>((resolve) => { onCdnEntered = resolve; });
    // The CDN fetch hangs until aborted, then rejects like a real cancelled fetch.
    const cdnHang = (init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        onCdnEntered();
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });

    const promise = downloadByPlan(plan, {
      storage,
      signal: controller.signal,
      fetcher: dispatch(log, { [CDN]: cdnHang, [IDENTITY]: () => okBody(body) }),
    });

    await cdnEntered;
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(DownloadAbortedError);
    expect(log).toContain(CDN);
    expect(log).not.toContain(IDENTITY);
  });

  it('falls back to the proxy when the CDN serves bytes that fail the SHA check', async () => {
    const correct = byteArr(5, 6, 7, 8);
    const wrong = byteArr(1, 1, 1, 1); // same length → passes the size check, fails SHA
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: correct.byteLength, oid: oidOf(correct) }],
    };
    const log: string[] = [];

    const result = await downloadByPlan(plan, {
      storage,
      fetcher: dispatch(log, {
        [CDN]: () => okBody(wrong),
        [IDENTITY]: () => okBody(correct),
      }),
    });

    expect(result.filesFetched).toBe(1);
    // The correct (proxy) bytes are what got stored — a corrupt CDN never wins.
    expect(await storage.has({ modelId: MODEL_ID, url: IDENTITY })).toBe(true);
    expect(log).toContain(CDN);
    expect(log).toContain(IDENTITY);
  });
});

// ─── Resumable: warm cache ─────────────────────────────────────────────────

describe('downloadByPlan — warm cache (resumable)', () => {
  it('skips files that already pass storage.verify', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3, 4, 5) };
    const b = { url: 'https://test/b.bin', body: byteArr(10, 11, 12) };
    const plan = makePlan([a, b]);

    // Pre-populate `a` only.
    await storage.put(
      { modelId: plan.modelId, url: a.url },
      new Response(a.body as unknown as BodyInit),
    );

    let bFetchCount = 0;
    let aFetchCount = 0;
    const fetcher: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString?.() ?? '';
      if (url === a.url) {
        aFetchCount++;
        return new Response(a.body as unknown as BodyInit, { status: 200 });
      }
      bFetchCount++;
      return new Response(b.body as unknown as BodyInit, { status: 200 });
    }) as typeof fetch;

    const result = await downloadByPlan(plan, { storage, fetcher });

    expect(result.filesSkipped).toBe(1);
    expect(result.filesFetched).toBe(1);
    expect(aFetchCount).toBe(0);
    expect(bFetchCount).toBe(1);
  });
});

// ─── Bug #4 regression: chunked transfer (no content-length) ───────────────

describe('downloadByPlan — Bug #4 regression', () => {
  it('a CDN response with content-length stripped is stored and counted correctly', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(99, 99, 99, 99, 99) };
    const plan = makePlan([a]);

    await downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({
        [a.url]: { body: a.body, stripContentLength: true },
      }),
    });

    const files: FileSpec[] = plan.files.map((f) => ({ url: f.url, sizeBytes: f.sizeBytes }));
    // Critical: countCached must succeed because storage.put stamped the
    // actual byte count, not the (missing) content-length header.
    expect(await countCached(storage, plan.modelId, files)).toBe(1);

    // And the cache entry must survive a second countCached pass — the
    // legacy code path deleted on size-predicate failure (Bug #4).
    expect(await countCached(storage, plan.modelId, files)).toBe(1);
  });

  it('stored entry survives a second verify pass when content-length was stripped', async () => {
    // The byte-content roundtrip (Uint8Array → Response → blob → cache →
    // arrayBuffer) is exercised in Phase L's Playwright pass against the
    // real browser — jsdom's Response polyfill doesn't faithfully
    // preserve binary body contents through `new Response(blob)`, which
    // is why Phase G's storage tests already restrict themselves to
    // sizeBytes assertions rather than byte-equality.
    //
    // The Phase H regression we DO assert here: when the upstream
    // response is missing content-length (the Bug #4 trigger), the
    // stored entry is correctly sized AND survives repeated
    // verify/countCached calls. That's the structural property Phase G
    // guarantees and Phase H now relies on.
    const url = 'https://test/chunked.bin';
    const payload = byteArr(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url, sizeBytes: payload.byteLength }],
    };

    await downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({
        [url]: { body: payload, stripContentLength: true },
      }),
    });

    const files: FileSpec[] = plan.files.map((f) => ({ url: f.url, sizeBytes: f.sizeBytes }));
    expect(await countCached(storage, plan.modelId, files)).toBe(1);
    // Second pass — verify must NOT delete the entry on a successful match.
    expect(await countCached(storage, plan.modelId, files)).toBe(1);
    // The entry is reachable through storage.get and reports the right size.
    const cached = await storage.get({ modelId: MODEL_ID, url });
    expect(cached).not.toBeNull();
    expect(cached!.sizeBytes).toBe(payload.byteLength);
  });
});

// ─── Abort + cancel ────────────────────────────────────────────────────────

describe('downloadByPlan — abort + cancel', () => {
  it('throws DownloadAbortedError when external signal aborts before start', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3) };
    const plan = makePlan([a]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadByPlan(plan, {
        storage,
        signal: controller.signal,
        fetcher: createFetcher({ [a.url]: { body: a.body } }),
      }),
    ).rejects.toBeInstanceOf(DownloadAbortedError);
  });

  it('cancelDownload aborts an in-flight operation', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3) };
    const plan = makePlan([a]);

    const promise = downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({ [a.url]: { body: a.body, delayMs: 100 } }),
    });

    // Wait a microtask so the operation is registered before we cancel.
    await Promise.resolve();
    await cancelDownload(plan.modelId);

    await expect(promise).rejects.toBeInstanceOf(DownloadAbortedError);
  });

  it('clears the in-flight registry on completion', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2) };
    const plan = makePlan([a]);
    await downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({ [a.url]: { body: a.body } }),
    });
    expect(listActiveDownloads()).not.toContain(plan.modelId);
  });

  it('rejects a concurrent download for the same modelId', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3) };
    const plan = makePlan([a]);

    const first = downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({ [a.url]: { body: a.body, delayMs: 50 } }),
    });

    await Promise.resolve();
    await expect(
      downloadByPlan(plan, { storage, fetcher: createFetcher({ [a.url]: { body: a.body } }) }),
    ).rejects.toThrow(/already in flight/);

    await first; // Let the first complete cleanly.
  });
});

// ─── Failure paths ─────────────────────────────────────────────────────────

describe('downloadByPlan — failure paths', () => {
  it('throws DownloadFailedError on HTTP non-2xx', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1) };
    const plan = makePlan([a]);

    await expect(
      downloadByPlan(plan, {
        storage,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        fetcher: createFetcher({ [a.url]: { body: a.body, status: 503 } }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);
  });
});

// ─── Transient retry (single-GET path) ─────────────────────────────────────
//
// The single-GET path had NO retry at all: one blip on a 40 KB config file
// failed the whole model, and with no CDN configured there is no second source
// to fall back to either. Retry is the inner axis — same source, short backoff.

describe('downloadByPlan — transient retry', () => {
  const URL_S = 'https://test/config.json';

  function okBody(body: Uint8Array): Response {
    return new Response(body as unknown as BodyInit, {
      status: 200,
      headers: { 'content-length': String(body.byteLength) },
    });
  }

  /** Fails the first `failures` requests to any url, then serves `body`. */
  function flaky(
    body: Uint8Array,
    failures: number,
    log: string[],
    status = 503,
  ): typeof fetch {
    let seen = 0;
    return (async (input: RequestInfo | URL) => {
      log.push(typeof input === 'string' ? input : (input as Request).url);
      seen += 1;
      return seen <= failures ? new Response(null, { status }) : okBody(body);
    }) as typeof fetch;
  }

  it('absorbs a transient blip on the single-GET path and completes', async () => {
    const body = byteArr(4, 5, 6);
    const log: string[] = [];

    const result = await downloadByPlan(
      { modelId: MODEL_ID, files: [{ url: URL_S, sizeBytes: body.byteLength }] },
      { storage, retryBaseDelayMs: NO_RETRY_BACKOFF, fetcher: flaky(body, 1, log) },
    );

    expect(result.filesFetched).toBe(1);
    expect(log).toHaveLength(2); // the blip, then the retry that landed
    expect((await storage.get({ modelId: MODEL_ID, url: URL_S }))!.sizeBytes)
      .toBe(body.byteLength);
  });

  it('survives blips right up to the retry budget', async () => {
    const body = byteArr(1, 2);
    const log: string[] = [];

    const result = await downloadByPlan(
      { modelId: MODEL_ID, files: [{ url: URL_S, sizeBytes: body.byteLength }] },
      { storage, retryBaseDelayMs: NO_RETRY_BACKOFF, fetcher: flaky(body, 2, log) },
    );

    expect(result.filesFetched).toBe(1);
    expect(log).toHaveLength(3);
  });

  it('gives up once the budget is spent — a dead host still fails honestly', async () => {
    const body = byteArr(1, 2);
    const log: string[] = [];

    await expect(
      downloadByPlan(
        { modelId: MODEL_ID, files: [{ url: URL_S, sizeBytes: body.byteLength }] },
        { storage, retryBaseDelayMs: NO_RETRY_BACKOFF, fetcher: flaky(body, 3, log) },
      ),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    expect(log).toHaveLength(3);
    expect(await storage.has({ modelId: MODEL_ID, url: URL_S })).toBe(false);
  });

  it('does not retry a hard 4xx — a bad object will not heal on a re-request', async () => {
    const body = byteArr(1, 2);
    const log: string[] = [];

    await expect(
      downloadByPlan(
        { modelId: MODEL_ID, files: [{ url: URL_S, sizeBytes: body.byteLength }] },
        { storage, retryBaseDelayMs: NO_RETRY_BACKOFF, fetcher: flaky(body, 1, log, 410) },
      ),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    expect(log).toHaveLength(1);
  });

  it('retries a network error (no status), not just an HTTP one', async () => {
    const body = byteArr(7, 8, 9);
    const log: string[] = [];
    let seen = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      log.push(typeof input === 'string' ? input : (input as Request).url);
      seen += 1;
      if (seen === 1) throw new TypeError('Failed to fetch');
      return okBody(body);
    }) as typeof fetch;

    const result = await downloadByPlan(
      { modelId: MODEL_ID, files: [{ url: URL_S, sizeBytes: body.byteLength }] },
      { storage, retryBaseDelayMs: NO_RETRY_BACKOFF, fetcher },
    );

    expect(result.filesFetched).toBe(1);
    expect(log).toHaveLength(2);
  });

  it('protects the proxy-fallback attempt too — a blip after the source switch', async () => {
    const IDENTITY = 'https://test/proxy/w.bin';
    const CDN = 'https://cdn.example.com/w.bin';
    const body = byteArr(3, 1, 4, 1, 5);
    const log: string[] = [];
    let proxyHits = 0;

    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      log.push(url);
      if (url === CDN) return new Response(null, { status: 404 }); // mirror miss
      proxyHits += 1;
      return proxyHits === 1 ? new Response(null, { status: 502 }) : okBody(body);
    }) as typeof fetch;

    const result = await downloadByPlan(
      {
        modelId: MODEL_ID,
        files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength }],
      },
      { storage, retryBaseDelayMs: NO_RETRY_BACKOFF, fetcher },
    );

    expect(result.filesFetched).toBe(1);
    // A 404 is a mirror miss, not a blip: one CDN request, then the proxy — whose
    // own blip is absorbed by the retry rather than failing the download.
    expect(log.filter((u) => u === CDN)).toHaveLength(1);
    expect(log.filter((u) => u === IDENTITY)).toHaveLength(2);
  });

  it('aborts immediately rather than finishing the retry cycle', async () => {
    const body = byteArr(1, 2, 3);
    const controller = new AbortController();
    const log: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      log.push(typeof input === 'string' ? input : (input as Request).url);
      controller.abort();
      return new Response(null, { status: 503 });
    }) as typeof fetch;

    await expect(
      downloadByPlan(
        { modelId: MODEL_ID, files: [{ url: URL_S, sizeBytes: body.byteLength }] },
        {
          storage,
          signal: controller.signal,
          retryBaseDelayMs: NO_RETRY_BACKOFF,
          fetcher,
        },
      ),
    ).rejects.toBeInstanceOf(DownloadAbortedError);

    expect(log).toHaveLength(1); // the abort beat the retry
  });
});

// ─── DI seam: downloadModel ────────────────────────────────────────────────

describe('downloadModel — resolver DI', () => {
  const model: ModelConfig = {
    id: MODEL_ID,
    friendlyName: 'Qwen3',
    vendor: 'Alibaba',
    sizeGB: 0.57,
    runtime: 'transformers',
    format: 'onnx-q4f16',
    capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
    bestFor: 'test',
    knownLimitation: 'test',
    evidenceTier: 'proven',
  };

  it('throws DownloadResolverMissingError when no resolver is registered', async () => {
    expect(hasDownloadPlanResolver()).toBe(false);
    await expect(downloadModel(model)).rejects.toBeInstanceOf(DownloadResolverMissingError);
  });

  it('delegates to the registered resolver', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(7, 7, 7) };
    setDownloadPlanResolver(async () => makePlan([a]));
    expect(hasDownloadPlanResolver()).toBe(true);

    const result = await downloadModel(model, {
      storage,
      fetcher: createFetcher({ [a.url]: { body: a.body } }),
    });
    expect(result.modelId).toBe(MODEL_ID);
    expect(result.filesFetched).toBe(1);
  });

  it('clearing the resolver returns hasDownloadPlanResolver to false', () => {
    setDownloadPlanResolver(async () => ({ modelId: 'x', files: [] }));
    expect(hasDownloadPlanResolver()).toBe(true);
    setDownloadPlanResolver(null);
    expect(hasDownloadPlanResolver()).toBe(false);
  });

  // ── slice 3: download-fail recorded at the origin ──
  describe('download-fail ledger recording (choke point)', () => {
    const recordEvidenceMock = vi.mocked(recordEvidence);
    beforeEach(() => recordEvidenceMock.mockClear());

    it('records a download-fail row with a classified errorCode on HTTP failure', async () => {
      const a = { url: 'https://test/a.bin', body: byteArr(1) };
      setDownloadPlanResolver(async () => makePlan([a]));

      await expect(
        downloadModel(model, {
          storage,
          retryBaseDelayMs: NO_RETRY_BACKOFF,
          fetcher: createFetcher({ [a.url]: { body: a.body, status: 503 } }),
        }),
      ).rejects.toBeInstanceOf(DownloadFailedError);

      // Exactly one write — the single origin writer makes double-counting
      // structurally impossible (setup / switch / upgrade all funnel here).
      expect(recordEvidenceMock).toHaveBeenCalledTimes(1);
      expect(recordEvidenceMock).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: MODEL_ID, outcome: 'download-fail', errorCode: 'failed' }),
      );
    });

    it('does NOT record a row when the download is aborted (resumable, not a failure)', async () => {
      const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3) };
      setDownloadPlanResolver(async () => makePlan([a]));
      const controller = new AbortController();
      controller.abort();

      await expect(
        downloadModel(model, {
          storage,
          signal: controller.signal,
          fetcher: createFetcher({ [a.url]: { body: a.body } }),
        }),
      ).rejects.toBeInstanceOf(DownloadAbortedError);

      expect(recordEvidenceMock).not.toHaveBeenCalled();
    });

    it('writes NO row when a transient blip is absorbed by the retry', async () => {
      // The whole point of the retry layer: a flaky-network user must not
      // accumulate download-fail rows that the recommender later reads as
      // "this model doesn't work on this device".
      const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3) };
      setDownloadPlanResolver(async () => makePlan([a]));

      let seen = 0;
      const fetcher = (async () => {
        seen += 1;
        return seen === 1
          ? new Response(null, { status: 503 })
          : new Response(a.body as unknown as BodyInit, {
              status: 200,
              headers: { 'content-length': String(a.body.byteLength) },
            });
      }) as typeof fetch;

      const result = await downloadModel(model, {
        storage,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        fetcher,
      });

      expect(result.filesFetched).toBe(1);
      expect(recordEvidenceMock).not.toHaveBeenCalled();
    });
  });
});

// ─── Size mismatch — store actual bytes, refetch on next pass ──────────────

describe('downloadByPlan — body byte count diverges from plan.sizeBytes', () => {
  it('stores the actual byte count (not the plan value) and rejects the entry on the next verify', async () => {
    // Plan claims 10 bytes; fetcher returns 5. Phase G's storage.put
    // stamps Eco-Cache-Size from the body, so the entry is stamped at 5.
    // The next storage.verify(file, plan.sizeBytes=10) must therefore
    // fail (5 !== 10) and the entry must NOT be counted as cached. This
    // is the structural property that lets resumed downloads recover
    // from partial-body corruption WITHOUT a content-length predicate.
    const url = 'https://test/short.bin';
    const actualBody = byteArr(1, 2, 3, 4, 5); // 5 bytes
    const claimedSize = 10;                     // plan says 10
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url, sizeBytes: claimedSize }],
    };

    await downloadByPlan(plan, {
      storage,
      fetcher: createFetcher({ [url]: { body: actualBody } }),
    });

    // Storage entry reports the actual count, not the claimed count.
    const cached = await storage.get({ modelId: MODEL_ID, url });
    expect(cached).not.toBeNull();
    expect(cached!.sizeBytes).toBe(actualBody.byteLength);

    // countCached against the plan's (mismatched) sizeBytes must return 0,
    // and must NOT delete the entry (decoupled from delete — Invariant 7).
    const files: FileSpec[] = plan.files.map((f) => ({ url: f.url, sizeBytes: f.sizeBytes }));
    expect(await countCached(storage, plan.modelId, files)).toBe(0);

    // Entry still exists at the actually-stored size — refetch on re-run.
    const afterCount = await storage.get({ modelId: MODEL_ID, url });
    expect(afterCount).not.toBeNull();
    expect(afterCount!.sizeBytes).toBe(actualBody.byteLength);
  });
});

// ─── No-HEAD invariant (L6 MEDIUM-04) ──────────────────────────────────────

describe('downloadByPlan — no HEAD pass (L6 MEDIUM-04)', () => {
  it('never issues a HEAD request', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3) };
    const plan = makePlan([a]);

    const methodsObserved: string[] = [];
    const fetcher: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      methodsObserved.push(init?.method ?? 'GET');
      return new Response(a.body as unknown as BodyInit, { status: 200 });
    }) as typeof fetch;

    await downloadByPlan(plan, { storage, fetcher });

    expect(methodsObserved).toEqual(['GET']);
    expect(methodsObserved.includes('HEAD')).toBe(false);
  });
});

// ─── Range-chunked large files ─────────────────────────────────────────────
//
// Files above the chunk threshold download via sequential HTTP Range requests
// so no single request can blow the proxy function's time budget (the 2 GB
// .litertlm "Failed to fetch" regression). Range requests bypass the proxy's
// full-GET SHA verification, so integrity moves client-side: the assembled
// blob is SHA-256'd and checked against the manifest oid.

function oidOf(body: Uint8Array): string {
  return bytesToHex(sha256.create().update(body).digest());
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  // Emit in two pieces so the progress/transform path sees multiple chunks.
  const mid = Math.ceil(bytes.byteLength / 2);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes.subarray(0, mid));
        if (mid < bytes.byteLength) controller.enqueue(bytes.subarray(mid));
      }
      controller.close();
    },
  });
}

type RangeFetcherOptions = {
  /** Ignore the Range header and answer 200 with the full body (range-unaware origin). */
  ignoreRange?: boolean;
  /** Delay each response, rejecting with AbortError if the signal aborts first. */
  delayMs?: number;
  /** Records every requested `bytes=start-end` Range value (or 'full' for a 200). */
  onRequest?: (range: string) => void;
  /** Fail the Nth (0-indexed) range request once with a network error, then succeed. */
  failOnceAtRequest?: number;
};

function createRangeFetcher(
  bodyByUrl: Record<string, Uint8Array>,
  options: RangeFetcherOptions = {},
): typeof fetch {
  let requestIndex = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    const full = bodyByUrl[url];
    if (!full) return new Response(null, { status: 404 });

    const rangeHeader = init?.headers
      ? new Headers(init.headers).get('range')
      : null;
    const index = requestIndex++;
    options.onRequest?.(rangeHeader ?? 'full');

    if (options.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, options.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }

    if (options.failOnceAtRequest === index) {
      throw new TypeError('Failed to fetch');
    }

    if (!rangeHeader || options.ignoreRange) {
      return new Response(streamOf(full) as unknown as BodyInit, {
        status: 200,
        headers: { 'content-length': String(full.byteLength) },
      });
    }

    const match = /bytes=(\d+)-(\d+)?/.exec(rangeHeader);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] != null
      ? Math.min(Number(match[2]), full.byteLength - 1)
      : full.byteLength - 1;
    const slice = full.subarray(start, end + 1);

    return new Response(streamOf(slice) as unknown as BodyInit, {
      status: 206,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': String(slice.byteLength),
        'content-range': `bytes ${start}-${end}/${full.byteLength}`,
      },
    });
  }) as typeof fetch;
}

describe('downloadByPlan — range-chunked large files', () => {
  const CHUNK = 4; // tiny threshold so small test bodies exercise the chunk path

  function bigBody(n: number): Uint8Array {
    return Uint8Array.from({ length: n }, (_, i) => (i % 251) + 1);
  }

  function chunkedPlan(url: string, body: Uint8Array, oid?: string): DownloadPlan {
    return {
      modelId: MODEL_ID,
      files: [{ url, sizeBytes: body.byteLength, oid: oid ?? oidOf(body) }],
    };
  }

  it('downloads a file larger than the chunk size via sequential Range requests', async () => {
    const url = 'https://test/big.bin';
    const body = bigBody(10); // 10 bytes / 4 = 3 range requests
    const ranges: string[] = [];
    const result = await downloadByPlan(chunkedPlan(url, body), {
      storage,
      rangeChunkBytes: CHUNK,
      fetcher: createRangeFetcher({ [url]: body }, { onRequest: (r) => ranges.push(r) }),
    });

    expect(result.filesFetched).toBe(1);
    expect(result.bytesDownloaded).toBe(body.byteLength);
    expect(ranges).toEqual(['bytes=0-3', 'bytes=4-7', 'bytes=8-9']);

    const cached = await storage.get({ modelId: MODEL_ID, url });
    expect(cached).not.toBeNull();
    expect(cached!.sizeBytes).toBe(body.byteLength);
    expect(await countCached(storage, MODEL_ID, [{ url, sizeBytes: body.byteLength }])).toBe(1);
  });

  it('reports loaded === total at completion across chunks', async () => {
    const url = 'https://test/big.bin';
    const body = bigBody(13);
    const result = await downloadByPlan(chunkedPlan(url, body), {
      storage,
      rangeChunkBytes: CHUNK,
      fetcher: createRangeFetcher({ [url]: body }),
    });
    expect(result.tracker.snapshot().percent).toBeCloseTo(1);
  });

  it('verifies SHA-256 against the manifest oid and rejects a mismatch without storing', async () => {
    const url = 'https://test/big.bin';
    const body = bigBody(12);
    await expect(
      downloadByPlan(chunkedPlan(url, body, '0'.repeat(64)), {
        storage,
        rangeChunkBytes: CHUNK,
        fetcher: createRangeFetcher({ [url]: body }),
      }),
    ).rejects.toBeInstanceOf(DownloadIntegrityError);

    // No entry is stamped on integrity failure — the next pass refetches cleanly.
    expect(await storage.get({ modelId: MODEL_ID, url })).toBeNull();
  });

  it('skips the SHA check when no oid is available (heuristic-fallback plan)', async () => {
    const url = 'https://test/big.bin';
    const body = bigBody(10);
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url, sizeBytes: body.byteLength }], // no oid
    };
    const result = await downloadByPlan(plan, {
      storage,
      rangeChunkBytes: CHUNK,
      fetcher: createRangeFetcher({ [url]: body }),
    });
    expect(result.filesFetched).toBe(1);
    expect((await storage.get({ modelId: MODEL_ID, url }))!.sizeBytes).toBe(body.byteLength);
  });

  it('falls back to the whole body when the origin ignores Range (200)', async () => {
    const url = 'https://test/big.bin';
    const body = bigBody(10);
    const result = await downloadByPlan(chunkedPlan(url, body), {
      storage,
      rangeChunkBytes: CHUNK,
      fetcher: createRangeFetcher({ [url]: body }, { ignoreRange: true }),
    });
    expect(result.filesFetched).toBe(1);
    expect((await storage.get({ modelId: MODEL_ID, url }))!.sizeBytes).toBe(body.byteLength);
  });

  it('retries a transient chunk failure and completes', async () => {
    const url = 'https://test/big.bin';
    const body = bigBody(10);
    const result = await downloadByPlan(chunkedPlan(url, body), {
      storage,
      rangeChunkBytes: CHUNK,
      retryBaseDelayMs: NO_RETRY_BACKOFF,
      // Second range request (index 1) fails once, then the retry succeeds.
      fetcher: createRangeFetcher({ [url]: body }, { failOnceAtRequest: 1 }),
    });
    expect(result.filesFetched).toBe(1);
    expect((await storage.get({ modelId: MODEL_ID, url }))!.sizeBytes).toBe(body.byteLength);
  });

  it('backs off between chunk retries and still completes', async () => {
    const url = 'https://test/big.bin';
    const body = bigBody(10);
    const started = Date.now();
    const result = await downloadByPlan(chunkedPlan(url, body), {
      storage,
      rangeChunkBytes: CHUNK,
      // Real but tiny, so the wiring is proven without a 500ms sleep.
      retryBaseDelayMs: 20,
      fetcher: createRangeFetcher({ [url]: body }, { failOnceAtRequest: 1 }),
    });
    expect(result.filesFetched).toBe(1);
    expect((await storage.get({ modelId: MODEL_ID, url }))!.sizeBytes).toBe(body.byteLength);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15); // 20ms less max jitter
  });

  it('throws DownloadAbortedError when aborted mid-chunk', async () => {
    const url = 'https://test/big.bin';
    const body = bigBody(12);
    const controller = new AbortController();
    const promise = downloadByPlan(chunkedPlan(url, body), {
      storage,
      signal: controller.signal,
      rangeChunkBytes: CHUNK,
      fetcher: createRangeFetcher({ [url]: body }, { delayMs: 100 }),
    });
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(DownloadAbortedError);
    expect(await storage.get({ modelId: MODEL_ID, url })).toBeNull();
  });

  it('keeps small files on the single-GET path (no Range header)', async () => {
    const url = 'https://test/small.bin';
    const body = bigBody(3); // below CHUNK threshold
    const ranges: string[] = [];
    await downloadByPlan(chunkedPlan(url, body), {
      storage,
      rangeChunkBytes: CHUNK,
      fetcher: createRangeFetcher({ [url]: body }, { onRequest: (r) => ranges.push(r) }),
    });
    expect(ranges).toEqual(['full']); // single GET, no Range
  });
});

// ─── Storage-headroom preflight ────────────────────────────────────────────
//
// Before writing weights, decline up-front when there isn't room (the incognito
// ~2 GB QuotaExceededError case), so setup can surface an honest "not enough
// space" message instead of a doomed download. Fails open on an unknown estimate.

describe('downloadByPlan — storage headroom', () => {
  it('declines up-front with InsufficientStorageError when the estimate is too small', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3, 4, 5, 6, 7, 8, 9, 10) };
    let fetched = 0;
    await expect(
      downloadByPlan(makePlan([a]), {
        storage,
        estimateStorage: async () => ({ usage: 0, quota: 5 }), // available 5 < 10 × 1.1
        fetcher: (async () => { fetched++; return new Response(a.body as unknown as BodyInit); }) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(InsufficientStorageError);

    expect(fetched).toBe(0); // declined before any fetch
    expect(await storage.get({ modelId: MODEL_ID, url: a.url })).toBeNull();
  });

  it('states the shortfall in the same decimal GB the model tiles show', async () => {
    // The sentence the user reads has to be reconcilable with the size on the
    // tile they just tapped (~1.7 GB), so both are decimal GB. Dividing by
    // 2^30 while printing "GB" quoted a number that matched nothing.
    const error = new InsufficientStorageError(1_700_000_000, 400_000_000);

    expect(error.message).toBe(
      'Eco needs about 1.7 GB of free space for this model, but only about 0.4 GB is available on this device.',
    );
    expect(error.requiredBytes).toBe(1_700_000_000);
    expect(error.availableBytes).toBe(400_000_000);
  });

  it('claims no available figure when the failure origin had none', async () => {
    const error = new InsufficientStorageError(1_700_000_000);

    expect(error.message).toBe(
      'Eco ran out of free space while setting up this model. It needs about 1.7 GB.',
    );
    expect(error.message).not.toContain('—');
    expect(error.availableBytes).toBeUndefined();
  });

  it('proceeds when the estimate shows enough room', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3, 4, 5) };
    const result = await downloadByPlan(makePlan([a]), {
      storage,
      estimateStorage: async () => ({ usage: 0, quota: 1_000_000 }),
      fetcher: createFetcher({ [a.url]: { body: a.body } }),
    });
    expect(result.filesFetched).toBe(1);
  });

  it('fails open and proceeds when no estimate is available', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3) };
    const result = await downloadByPlan(makePlan([a]), {
      storage,
      estimateStorage: async () => null,
      fetcher: createFetcher({ [a.url]: { body: a.body } }),
    });
    expect(result.filesFetched).toBe(1);
  });

  it('maps a mid-write QuotaExceededError to InsufficientStorageError', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3, 4) };
    class QuotaCache extends MemoryCache {
      override async put(): Promise<void> {
        throw new DOMException('quota', 'QuotaExceededError');
      }
    }
    class QuotaCacheStorage extends MemoryCacheStorage {
      override async open(): Promise<MemoryCache> {
        return new QuotaCache();
      }
    }
    const quotaStorage = new CacheApiStorage(new QuotaCacheStorage());

    await expect(
      downloadByPlan(makePlan([a]), {
        storage: quotaStorage,
        estimateStorage: async () => null, // skip preflight so we reach the write
        fetcher: createFetcher({ [a.url]: { body: a.body } }),
      }),
    ).rejects.toBeInstanceOf(InsufficientStorageError);
  });
});

// ─── Full disk vs dead host: blob-assembly failure attribution ─────────────
//
// On a nearly-full disk Chromium refuses to back a large Blob and rejects
// `new Response(stream).blob()` with a fetch-shaped `TypeError: Failed to
// fetch` — no network involved. Taken literally that told a user whose disk was
// full to "check your connection". The probe reproduces the same Blob locally
// to tell the two apart; everything inconclusive keeps the network wording.

/** A 200 whose body errors as soon as it is read — the shape of both causes. */
function erroringBodyFetcher(contentLength: number): typeof fetch {
  return (async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('Failed to fetch'));
      },
    }) as unknown as BodyInit,
    { status: 200, headers: { 'content-length': String(contentLength) } },
  )) as typeof fetch;
}

describe('downloadByPlan — blob-assembly failure attribution', () => {
  const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3, 4, 5, 6, 7, 8) };

  it('raises the honest storage error when the device cannot make a blob that size', async () => {
    const probe = vi.fn(async () => true);
    let thrown: unknown;
    try {
      await downloadByPlan(makePlan([a]), {
        storage,
        estimateStorage: async () => null, // preflight says nothing — this is the case it misses
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        probeBlobStorageExhausted: probe,
        fetcher: erroringBodyFetcher(a.body.byteLength),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InsufficientStorageError);
    // The quota path's figures: required bytes, no available claim.
    expect((thrown as InsufficientStorageError).requiredBytes).toBe(a.body.byteLength);
    expect((thrown as InsufficientStorageError).availableBytes).toBeUndefined();
    expect((thrown as Error).message).toContain('ran out of free space');
    // Probed for the bytes the assembly was trying to hold.
    expect(probe).toHaveBeenCalledWith(a.body.byteLength);
  });

  it('keeps the network attribution when a blob that size is still creatable', async () => {
    const probe = vi.fn(async () => false);
    let thrown: unknown;
    try {
      await downloadByPlan(makePlan([a]), {
        storage,
        estimateStorage: async () => null,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        probeBlobStorageExhausted: probe,
        fetcher: erroringBodyFetcher(a.body.byteLength),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DownloadFailedError);
    expect(thrown).not.toBeInstanceOf(InsufficientStorageError);
    expect((thrown as Error).message).toContain('Network error streaming');
    expect(probe).toHaveBeenCalled();
  });

  it('treats a probe that itself fails as inconclusive (network wording stands)', async () => {
    const probe = vi.fn(async () => {
      throw new Error('probe blew up');
    });
    await expect(
      downloadByPlan(makePlan([a]), {
        storage,
        estimateStorage: async () => null,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        probeBlobStorageExhausted: probe,
        fetcher: erroringBodyFetcher(a.body.byteLength),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);
    expect(probe).toHaveBeenCalled();
  });

  it('lets an abort win over the probe', async () => {
    const probe = vi.fn(async () => true);
    const controller = new AbortController();
    const fetcher = (async () => {
      controller.abort();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.error(new TypeError('Failed to fetch'));
          },
        }) as unknown as BodyInit,
        { status: 200, headers: { 'content-length': String(a.body.byteLength) } },
      );
    }) as typeof fetch;

    await expect(
      downloadByPlan(makePlan([a]), {
        storage,
        signal: controller.signal,
        estimateStorage: async () => null,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        probeBlobStorageExhausted: probe,
        fetcher,
      }),
    ).rejects.toBeInstanceOf(DownloadAbortedError);
    expect(probe).not.toHaveBeenCalled();
  });

  it('costs a healthy download nothing — the probe never runs', async () => {
    const probe = vi.fn(async () => true);
    const result = await downloadByPlan(makePlan([a]), {
      storage,
      estimateStorage: async () => null,
      probeBlobStorageExhausted: probe,
      fetcher: createFetcher({ [a.url]: { body: a.body } }),
    });

    expect(result.filesFetched).toBe(1);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('probeBlobStorage', () => {
  const realArrayBuffer = Response.prototype.arrayBuffer;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports exhaustion when only small blobs can still be created', async () => {
    // Reproduce the browser's behaviour on a full disk: a KB-sized blob is
    // fine, a large one rejects with the fetch-shaped TypeError.
    const limit = 8 * 1024;
    vi.spyOn(Response.prototype, 'blob').mockImplementation(async function (this: Response) {
      const bytes = new Uint8Array(await realArrayBuffer.call(this));
      if (bytes.byteLength > limit) throw new TypeError('Failed to fetch');
      return new Blob([bytes]);
    });

    await expect(probeBlobStorage(64 * 1024)).resolves.toBe(true);
  });

  it('reports no exhaustion on a healthy device', async () => {
    await expect(probeBlobStorage(64 * 1024)).resolves.toBe(false);
  });

  it('declines to judge a blob no bigger than its own control', async () => {
    vi.spyOn(Response.prototype, 'blob').mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(probeBlobStorage(1024)).resolves.toBe(false);
  });

  it('reports no exhaustion when even the small control blob fails', async () => {
    // The environment cannot make blobs at all (or the probe is unsupported):
    // that is not evidence of a full disk, so the network wording stands.
    vi.spyOn(Response.prototype, 'blob').mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(probeBlobStorage(64 * 1024)).resolves.toBe(false);
  });
});

// ─── Default fetch receiver (regression: "Illegal invocation") ──────────────
//
// The fetch loop holds its fetcher on a ctx object and calls it as
// `ctx.fetcher(...)`, which binds `this` to the ctx. The browser's native fetch
// brand-checks its receiver and throws "Failed to execute 'fetch' on 'Window':
// Illegal invocation" when `this` isn't the global — so the DEFAULT fetcher must
// be bound to the global, not passed raw. Injected test fakes don't brand-check,
// which is exactly why this only surfaced in a real browser (prod, 2026-07-01).

describe('downloadByPlan — default fetch receiver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invokes the global fetch with a valid receiver when no fetcher is injected', async () => {
    const a = { url: 'https://test/a.bin', body: byteArr(1, 2, 3, 4) };
    const fetchSpy = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return new Response(a.body as unknown as BodyInit, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    // No `fetcher` option → exercises the default, which must be receiver-safe.
    const result = await downloadByPlan(makePlan([a]), {
      storage,
      estimateStorage: async () => null,
    });

    expect(result.filesFetched).toBe(1);
    expect(fetchSpy).toHaveBeenCalled();
  });
});

// ─── Mid-file chunk resume (PR-L1) ─────────────────────────────────────────
//
// A chunked download persists each completed 32 MiB Range chunk under its own
// storage entry (key: `${file.url}.ecopart.${stamp}.${offset}`), so an
// interruption resumes mid-file instead of restarting from byte 0. Parts are
// swept only AFTER the whole-file store succeeds; a failed store retains them
// for the next attempt; clearModel reclaims any leftovers.

const PART_MARKER = '.ecopart.';

/** Entries in a model namespace that are chunk-parts (not the final file). */
function partEntries(
  list: { url: string; sizeBytes: number | null }[],
): { url: string; sizeBytes: number | null }[] {
  return list.filter((e) => e.url.includes(PART_MARKER));
}

/** Byte offset encoded in a part key url. */
function partOffset(url: string): number {
  const tail = url.slice(url.indexOf(PART_MARKER) + PART_MARKER.length);
  return Number(tail.slice(tail.lastIndexOf('.') + 1));
}

/** Sorted offsets of the part entries currently in `modelId`'s namespace. */
async function partOffsets(store: CacheApiStorage, modelId: string): Promise<number[]> {
  const parts = partEntries(await store.listForModel(modelId));
  return parts.map((e) => partOffset(e.url)).sort((a, b) => a - b);
}

type ParsedRange = { start: number; end: number | null; raw: string };

function parseRangeHeader(init?: RequestInit): ParsedRange | null {
  const header = init?.headers ? new Headers(init.headers).get('range') : null;
  if (!header) return null;
  const match = /bytes=(\d+)-(\d+)?/.exec(header);
  if (!match) return null;
  return { start: Number(match[1]), end: match[2] != null ? Number(match[2]) : null, raw: header };
}

function slice206(full: Uint8Array, range: ParsedRange): Response {
  const end = range.end == null ? full.byteLength - 1 : Math.min(range.end, full.byteLength - 1);
  const s = full.subarray(range.start, end + 1);
  return new Response(s as unknown as BodyInit, {
    status: 206,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(s.byteLength),
      'content-range': `bytes ${range.start}-${end}/${full.byteLength}`,
    },
  });
}

/** A 206 whose body errors mid-stream — simulates a dropped connection. */
function erroring206(full: Uint8Array, range: ParsedRange): Response {
  const end = range.end == null ? full.byteLength - 1 : Math.min(range.end, full.byteLength - 1);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError('network drop mid-chunk'));
    },
  });
  return new Response(body as unknown as BodyInit, {
    status: 206,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(end - range.start + 1),
      'content-range': `bytes ${range.start}-${end}/${full.byteLength}`,
    },
  });
}

type RangeHandler = (range: ParsedRange | null, init?: RequestInit) => Response | Promise<Response>;

/** URL-keyed range fetcher that records every {url, range} it is asked for. */
function rangeDispatch(
  log: { url: string; range: string }[],
  handlers: Record<string, RangeHandler>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    const range = parseRangeHeader(init);
    log.push({ url, range: range?.raw ?? 'full' });
    const handler = handlers[url];
    if (!handler) return new Response(null, { status: 404 });
    return handler(range, init);
  }) as typeof fetch;
}

/** Serves any Range as a 206 slice of `body` (200 full body when unranged). */
function serveRanges(body: Uint8Array): RangeHandler {
  return (range) => (range ? slice206(body, range) : new Response(
    body as unknown as BodyInit,
    { status: 200, headers: { 'content-length': String(body.byteLength) } },
  ));
}

/** Serves ranges below `failFrom`, 503s at/after it — a mid-file interruption. */
function serveThen503(body: Uint8Array, failFrom: number): RangeHandler {
  return (range) => {
    if (range && range.start >= failFrom) return new Response(null, { status: 503 });
    return range ? slice206(body, range) : new Response(body as unknown as BodyInit, { status: 200 });
  };
}

const RESUME_CHUNK = 4; // tiny threshold so small bodies exercise the chunk path

function chunkedFile(url: string, body: Uint8Array, oid?: string): DownloadPlan {
  return {
    modelId: MODEL_ID,
    files: [{ url, sizeBytes: body.byteLength, oid: oid ?? oidOf(body) }],
  };
}

function body16(): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, i) => (i % 251) + 1);
}

describe('downloadByPlan — mid-file chunk resume', () => {
  const URL_A = 'https://test/big.bin';

  it('persists a part entry at each completed chunk boundary mid-run', async () => {
    const body = body16(); // 4 chunks of 4 bytes
    await expect(
      downloadByPlan(chunkedFile(URL_A, body), {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: RESUME_CHUNK,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        // Fail from offset 8 → chunks at 0 and 4 persist, then interrupt.
        fetcher: rangeDispatch([], { [URL_A]: serveThen503(body, 8) }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    expect(await partOffsets(storage, MODEL_ID)).toEqual([0, 4]);
    // No final entry was stamped — only the two parts exist.
    expect(await storage.has({ modelId: MODEL_ID, url: URL_A })).toBe(false);
  });

  it('resumes from the persisted offset instead of restarting at byte 0', async () => {
    const body = body16();
    // Run 1: interrupt after two chunks (offsets 0, 4 persist).
    await expect(
      downloadByPlan(chunkedFile(URL_A, body), {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: RESUME_CHUNK,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        fetcher: rangeDispatch([], { [URL_A]: serveThen503(body, 8) }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    // Run 2: same storage, healthy fetcher — must resume at bytes=8-.
    const log: { url: string; range: string }[] = [];
    const result = await downloadByPlan(chunkedFile(URL_A, body), {
      storage,
      estimateStorage: async () => null,
      rangeChunkBytes: RESUME_CHUNK,
      fetcher: rangeDispatch(log, { [URL_A]: serveRanges(body) }),
    });

    expect(result.filesFetched).toBe(1);
    const ranges = log.map((e) => e.range);
    expect(ranges[0]).toBe('bytes=8-11'); // first request resumes, not bytes=0-
    expect(ranges).not.toContain('bytes=0-3');
    expect(ranges).toEqual(['bytes=8-11', 'bytes=12-15']);
  });

  it('assembles a SHA-verified file and stores it under the stable url identity', async () => {
    const body = body16();
    const oid = oidOf(body);
    const result = await downloadByPlan(chunkedFile(URL_A, body, oid), {
      storage,
      estimateStorage: async () => null,
      rangeChunkBytes: RESUME_CHUNK,
      fetcher: rangeDispatch([], { [URL_A]: serveRanges(body) }),
    });

    expect(result.filesFetched).toBe(1);
    const cached = await storage.get({ modelId: MODEL_ID, url: URL_A });
    expect(cached).not.toBeNull();
    expect(cached!.sizeBytes).toBe(body.byteLength);
  });

  it('retains the part entries as parts-native terminal storage (never a whole-file body)', async () => {
    const body = body16();
    await downloadByPlan(chunkedFile(URL_A, body), {
      storage,
      estimateStorage: async () => null,
      rangeChunkBytes: RESUME_CHUNK,
      fetcher: rangeDispatch([], { [URL_A]: serveRanges(body) }),
    });

    // The parts are NOT swept — they ARE the file's storage now. The identity
    // is a parts-native manifest that composes them; verify + get see the whole
    // file transparently.
    expect(await partEntries(await storage.listForModel(MODEL_ID))).toHaveLength(4);
    expect(await storage.has({ modelId: MODEL_ID, url: URL_A })).toBe(true);
    expect(await storage.isPartsNative({ modelId: MODEL_ID, url: URL_A })).toBe(true);
    expect(await storage.verify({ modelId: MODEL_ID, url: URL_A }, body.byteLength)).toBe(true);
    const stored = await storage.get({ modelId: MODEL_ID, url: URL_A });
    expect([...new Uint8Array(await stored!.response.arrayBuffer())]).toEqual([...body]);
  });

  it('discards a partial chunk (mid-stream failure) and resumes from the last completed boundary', async () => {
    const body = body16();
    // Chunk 0 (0-3) serves; chunk 1 (4-7) errors mid-stream persistently.
    const failing: RangeHandler = (range) => {
      if (range && range.start >= 4) return erroring206(body, range);
      return range ? slice206(body, range) : new Response(body as unknown as BodyInit, { status: 200 });
    };
    await expect(
      downloadByPlan(chunkedFile(URL_A, body), {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: RESUME_CHUNK,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        fetcher: rangeDispatch([], { [URL_A]: failing }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    // Only the completed chunk 0 was persisted — the mid-stream chunk 1 left nothing.
    expect(await partOffsets(storage, MODEL_ID)).toEqual([0]);

    const log: { url: string; range: string }[] = [];
    const result = await downloadByPlan(chunkedFile(URL_A, body), {
      storage,
      estimateStorage: async () => null,
      rangeChunkBytes: RESUME_CHUNK,
      fetcher: rangeDispatch(log, { [URL_A]: serveRanges(body) }),
    });
    expect(result.filesFetched).toBe(1);
    expect(log[0]!.range).toBe('bytes=4-7'); // resumes from the completed boundary
  });

  it('ignores and cleans stale-stamp parts when the expected bytes change between runs', async () => {
    const bodyOld = body16(); // stamp s16 (no oid)
    // Run 1: interrupt after two chunks under the old size stamp.
    await expect(
      downloadByPlan({ modelId: MODEL_ID, files: [{ url: URL_A, sizeBytes: 16 }] }, {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: RESUME_CHUNK,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        fetcher: rangeDispatch([], { [URL_A]: serveThen503(bodyOld, 8) }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);
    expect(await partOffsets(storage, MODEL_ID)).toEqual([0, 4]);

    // Run 2: the file now expects 20 bytes (stamp s20). The s16 parts are stale
    // and must be swept, not stitched — the download restarts from byte 0.
    const bodyNew = Uint8Array.from({ length: 20 }, (_, i) => (i % 251) + 100);
    const log: { url: string; range: string }[] = [];
    const result = await downloadByPlan({ modelId: MODEL_ID, files: [{ url: URL_A, sizeBytes: 20 }] }, {
      storage,
      estimateStorage: async () => null,
      rangeChunkBytes: RESUME_CHUNK,
      fetcher: rangeDispatch(log, { [URL_A]: serveRanges(bodyNew) }),
    });

    expect(result.filesFetched).toBe(1);
    expect(log[0]!.range).toBe('bytes=0-3'); // fresh start, stale parts ignored
    // No s16 parts survive; the retained parts are the fresh s20 set (5 × 4 bytes),
    // which the parts-native manifest composes back into the 20-byte file.
    const retained = await partEntries(await storage.listForModel(MODEL_ID));
    expect(retained.every((e) => e.url.includes('.ecopart.s20.'))).toBe(true);
    expect(retained.some((e) => e.url.includes('.ecopart.s16.'))).toBe(false);
    expect(retained).toHaveLength(5);
    expect((await storage.get({ modelId: MODEL_ID, url: URL_A }))!.sizeBytes).toBe(20);
  });

  it('nets persisted parts out of the storage preflight so a resumable file is not false-declined', async () => {
    const body = body16(); // 16 bytes total
    // Run 1: interrupt after two chunks → 8 bytes of parts on disk.
    await expect(
      downloadByPlan(chunkedFile(URL_A, body), {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: RESUME_CHUNK,
        retryBaseDelayMs: NO_RETRY_BACKOFF,
        fetcher: rangeDispatch([], { [URL_A]: serveThen503(body, 8) }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    // Run 2: only 12 bytes free. Full 16 would decline (16 × 1.1 = 17.6 > 12),
    // but netting the 8 persisted bytes leaves 8 (× 1.1 = 8.8 ≤ 12) → proceeds.
    const result = await downloadByPlan(chunkedFile(URL_A, body), {
      storage,
      estimateStorage: async () => ({ usage: 0, quota: 12 }),
      rangeChunkBytes: RESUME_CHUNK,
      fetcher: rangeDispatch([], { [URL_A]: serveRanges(body) }),
    });
    expect(result.filesFetched).toBe(1);
  });

  it('retains parts when the final whole-file store fails, so the next attempt resumes', async () => {
    const body = body16();
    // A cache that throws QuotaExceeded ONLY for the final (non-part) key.
    class FinalPutQuotaCache extends MemoryCache {
      override async put(request: RequestInfo | URL, response: Response): Promise<void> {
        const url = typeof request === 'string'
          ? request
          : request instanceof URL ? request.toString() : (request as Request).url;
        if (!url.includes(PART_MARKER)) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        return super.put(request, response);
      }
    }
    // One shared cache instance so the parts written during the run are visible
    // to the post-run assertion (open() must return the SAME cache each call).
    const sharedCache = new FinalPutQuotaCache();
    class SharedQuotaStorage extends MemoryCacheStorage {
      override async open(): Promise<MemoryCache> {
        return sharedCache;
      }
    }
    const quotaStorage = new CacheApiStorage(new SharedQuotaStorage());

    await expect(
      downloadByPlan(chunkedFile(URL_A, body), {
        storage: quotaStorage,
        estimateStorage: async () => null,
        rangeChunkBytes: RESUME_CHUNK,
        fetcher: rangeDispatch([], { [URL_A]: serveRanges(body) }),
      }),
    ).rejects.toBeInstanceOf(InsufficientStorageError);

    // Parts survive the failed final store — the resume bytes are preserved.
    expect(await partOffsets(quotaStorage, MODEL_ID)).toEqual([0, 4, 8, 12]);
  });

  it('leaves parts on abort, and clearModel sweeps them', async () => {
    const body = body16();
    const controller = new AbortController();
    let onChunk1Entered!: () => void;
    const chunk1Entered = new Promise<void>((resolve) => { onChunk1Entered = resolve; });
    // Chunk 0 serves immediately (and is persisted before the loop fetches
    // chunk 1); chunk 1 hangs until aborted.
    const handler: RangeHandler = (range, init) => {
      if (range && range.start >= 4) {
        return new Promise<Response>((_resolve, reject) => {
          onChunk1Entered();
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      return slice206(body, range!);
    };

    const promise = downloadByPlan(chunkedFile(URL_A, body), {
      storage,
      signal: controller.signal,
      estimateStorage: async () => null,
      rangeChunkBytes: RESUME_CHUNK,
      fetcher: rangeDispatch([], { [URL_A]: handler }),
    });

    await chunk1Entered;
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(DownloadAbortedError);

    // The completed chunk 0 remains — cancel intentionally preserves resume bytes.
    expect(await partOffsets(storage, MODEL_ID)).toEqual([0]);
    // clearModel is the sweep that reclaims them.
    await storage.clearModel(MODEL_ID);
    expect(await storage.listForModel(MODEL_ID)).toHaveLength(0);
  });

  it('completes with zero new range requests when every part is present but the final entry is missing', async () => {
    const body = body16();
    const stamp = `s${body.byteLength}`; // no oid → size stamp
    // Manually persist all four parts (an interrupt between the last chunk write
    // and the final whole-file store), leaving no final entry.
    for (let offset = 0; offset < body.byteLength; offset += RESUME_CHUNK) {
      const slice = body.subarray(offset, offset + RESUME_CHUNK);
      await storage.put(
        { modelId: MODEL_ID, url: `${URL_A}${PART_MARKER}${stamp}.${offset}` },
        new Response(slice as unknown as BodyInit),
      );
    }

    const log: { url: string; range: string }[] = [];
    const result = await downloadByPlan({ modelId: MODEL_ID, files: [{ url: URL_A, sizeBytes: 16 }] }, {
      storage,
      estimateStorage: async () => null,
      rangeChunkBytes: RESUME_CHUNK,
      fetcher: rangeDispatch(log, { [URL_A]: serveRanges(body) }),
    });

    expect(result.filesFetched).toBe(1);
    expect(log).toHaveLength(0); // completed entirely from persisted parts
    expect(await storage.has({ modelId: MODEL_ID, url: URL_A })).toBe(true);
    // Parts-native: the persisted parts become the terminal storage, not swept.
    expect(await storage.isPartsNative({ modelId: MODEL_ID, url: URL_A })).toBe(true);
    expect(await partEntries(await storage.listForModel(MODEL_ID))).toHaveLength(4);
  });

  it('L2 composition: a CDN failure mid-chunked-file resumes on the proxy retry, not from byte 0', async () => {
    const IDENTITY = 'https://test/proxy/big.bin';
    const CDN = 'https://cdn.example.com/big.bin';
    const body = body16();
    const plan: DownloadPlan = {
      modelId: MODEL_ID,
      files: [{ url: IDENTITY, fetchUrl: CDN, sizeBytes: body.byteLength, oid: oidOf(body) }],
    };
    const log: { url: string; range: string }[] = [];

    const result = await downloadByPlan(plan, {
      storage,
      estimateStorage: async () => null,
      rangeChunkBytes: RESUME_CHUNK,
      retryBaseDelayMs: NO_RETRY_BACKOFF,
      fetcher: rangeDispatch(log, {
        // CDN serves the first two chunks (0, 4) then 503s persistently at 8.
        [CDN]: serveThen503(body, 8),
        // Proxy serves everything — the fallback transport.
        [IDENTITY]: serveRanges(body),
      }),
    });

    expect(result.filesFetched).toBe(1);
    // The proxy attempt RESUMED: its first Range is the resume offset, never 0.
    const firstProxyRange = log.find((e) => e.url === IDENTITY)?.range;
    expect(firstProxyRange).toBe('bytes=8-11');
    expect(log.filter((e) => e.url === IDENTITY).map((e) => e.range))
      .toEqual(['bytes=8-11', 'bytes=12-15']);
    // The SHA-verified file is stored under the stable identity as parts-native
    // (its parts retained as the terminal storage across the CDN→proxy resume).
    expect((await storage.get({ modelId: MODEL_ID, url: IDENTITY }))!.sizeBytes)
      .toBe(body.byteLength);
    expect(await storage.isPartsNative({ modelId: MODEL_ID, url: IDENTITY })).toBe(true);
    expect(await partEntries(await storage.listForModel(MODEL_ID))).toHaveLength(4);
  });

  it('fallback (no finalizeParts): stores the chunked file via putStreamed — never assembling it in memory', async () => {
    // Backends WITHOUT finalizeParts (test fakes; never a real backend) take the
    // zero-retention whole-file finalize: the store goes through putStreamed
    // (which streams the persisted parts one at a time), NOT put (which would
    // take an assembled whole-file Blob). No oid so the only get() calls are the
    // stream's per-part reads — letting us assert they happen in offset order.
    const body = body16();
    const getCalls: string[] = [];
    const putUrls: string[] = [];
    const streamed: { url: string; sizeBytes: number; drained: Promise<Uint8Array> }[] = [];

    // A Storage that delegates to the real CacheApiStorage but observes the
    // store calls. putStreamed tees the incoming stream: one branch is drained
    // for the byte assertion, the other feeds the real backend so the download
    // completes and sweeps normally.
    const spy: Storage = {
      backend: storage.backend,
      async put(key, response) { putUrls.push(key.url); return storage.put(key, response); },
      async putStreamed(key, streamBody, sizeBytes) {
        const [a, b] = streamBody.tee();
        streamed.push({ url: key.url, sizeBytes, drained: drainStream(a) });
        return storage.putStreamed!(key, b, sizeBytes);
      },
      async get(key) { getCalls.push(key.url); return storage.get(key); },
      has: (key) => storage.has(key),
      verify: (key, size) => storage.verify(key, size),
      remove: (key) => storage.remove(key),
      listForModel: (id) => storage.listForModel(id),
      clearModel: (id) => storage.clearModel(id),
    };

    const result = await downloadByPlan(
      { modelId: MODEL_ID, files: [{ url: URL_A, sizeBytes: body.byteLength }] },
      {
        storage: spy,
        estimateStorage: async () => null,
        rangeChunkBytes: RESUME_CHUNK,
        fetcher: rangeDispatch([], { [URL_A]: serveRanges(body) }),
      },
    );

    expect(result.filesFetched).toBe(1);
    // The identity was stored by streaming, with the authoritative total size…
    expect(streamed).toHaveLength(1);
    expect(streamed[0]!.url).toBe(URL_A);
    expect(streamed[0]!.sizeBytes).toBe(body.byteLength);
    // …and never by a whole-file put (put is used only for the chunk-parts).
    expect(putUrls).not.toContain(URL_A);
    expect(putUrls.every((u) => u.includes(PART_MARKER))).toBe(true);
    // Draining the stream the caller handed putStreamed yields the exact bytes.
    expect([...(await streamed[0]!.drained)]).toEqual([...body]);
    // The parts were read back sequentially, in byte-offset order.
    const partGets = getCalls.filter((u) => u.includes(PART_MARKER));
    expect(partGets.map(partOffset)).toEqual([0, 4, 8, 12]);
  });

  it('parts-native (finalizeParts present): finalizes with ordered keys + total, no whole-file store, no sweep', async () => {
    // When the backend implements finalizeParts, the chunked store must take the
    // parts-native branch: finalizeParts is called with the ordered part keys and
    // the authoritative total, NEITHER put nor putStreamed touches the identity,
    // and the parts are NOT swept (they are the terminal storage).
    const body = body16();
    const putUrls: string[] = [];
    const streamedUrls: string[] = [];
    const removedUrls: string[] = [];
    const finalized: { url: string; partKeys: readonly string[]; sizeBytes: number }[] = [];

    const spy: Storage = {
      backend: storage.backend,
      async put(key, response) { putUrls.push(key.url); return storage.put(key, response); },
      async putStreamed(key, streamBody, sizeBytes) {
        streamedUrls.push(key.url);
        return storage.putStreamed!(key, streamBody, sizeBytes);
      },
      async finalizeParts(key, partKeys, sizeBytes) {
        finalized.push({ url: key.url, partKeys, sizeBytes });
        return storage.finalizeParts!(key, partKeys, sizeBytes);
      },
      get: (key) => storage.get(key),
      has: (key) => storage.has(key),
      verify: (key, size) => storage.verify(key, size),
      remove: (key) => { removedUrls.push(key.url); return storage.remove(key); },
      isPartsNative: (key) => storage.isPartsNative(key),
      listForModel: (id) => storage.listForModel(id),
      clearModel: (id) => storage.clearModel(id),
    };

    const result = await downloadByPlan(
      { modelId: MODEL_ID, files: [{ url: URL_A, sizeBytes: body.byteLength }] },
      {
        storage: spy,
        estimateStorage: async () => null,
        rangeChunkBytes: RESUME_CHUNK,
        fetcher: rangeDispatch([], { [URL_A]: serveRanges(body) }),
      },
    );

    expect(result.filesFetched).toBe(1);
    // finalizeParts was called once, for the identity, with the total and the
    // ordered (offset-ascending) part keys.
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.url).toBe(URL_A);
    expect(finalized[0]!.sizeBytes).toBe(body.byteLength);
    expect(finalized[0]!.partKeys.map(partOffset)).toEqual([0, 4, 8, 12]);
    // No whole-file store touched the identity.
    expect(putUrls).not.toContain(URL_A);
    expect(streamedUrls).not.toContain(URL_A);
    // The parts were NOT swept — no remove() targeted a part key.
    expect(removedUrls.filter((u) => u.includes(PART_MARKER))).toHaveLength(0);
    expect(await partEntries(await storage.listForModel(MODEL_ID))).toHaveLength(4);
  });

  it('fails closed when a persisted part is corrupt — DownloadIntegrityError, parts swept, nothing stored', async () => {
    const body = body16();
    const oid = oidOf(body);
    // Manually stage all four parts under the oid stamp, but tamper one part's
    // bytes (same length → passes size/contiguity, fails the streamed SHA). No
    // final entry exists, so resume adopts the parts and the integrity pass runs
    // before any store — the corrupt-download-never-stamps invariant.
    for (let offset = 0; offset < body.byteLength; offset += RESUME_CHUNK) {
      const slice = offset === 8
        ? Uint8Array.from({ length: RESUME_CHUNK }, () => 0)
        : body.subarray(offset, offset + RESUME_CHUNK);
      await storage.put(
        { modelId: MODEL_ID, url: `${URL_A}${PART_MARKER}${oid}.${offset}` },
        new Response(slice as unknown as BodyInit),
      );
    }

    const log: { url: string; range: string }[] = [];
    await expect(
      downloadByPlan(chunkedFile(URL_A, body, oid), {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: RESUME_CHUNK,
        fetcher: rangeDispatch(log, { [URL_A]: serveRanges(body) }),
      }),
    ).rejects.toBeInstanceOf(DownloadIntegrityError);

    // The whole file was reconstructed from parts (no refetch), so the integrity
    // check — not a size shortfall — is what caught the corruption.
    expect(log).toHaveLength(0);
    // Corrupt parts are swept and the identity is never stamped.
    expect(await partEntries(await storage.listForModel(MODEL_ID))).toHaveLength(0);
    expect(await storage.has({ modelId: MODEL_ID, url: URL_A })).toBe(false);
  });
});

// ─── 416 on a heuristic-estimate overshoot (Fix A) ─────────────────────────
//
// A heuristic-fallback plan's per-file sizeBytes is an ESTIMATE. When a resumed
// download's persisted parts already cover the origin's real (smaller) size, the
// loop still wants more (the plan total overshoots) and requests a range past
// EOF → the origin answers 416. A 416 is EOF evidence, not a failure: its
// Content-Range total is the authoritative correction. A 416 without a
// Content-Range can't be corrected, so the resumed parts are cleared for a clean
// retry rather than wedging on the same unsatisfiable range forever.

describe('downloadByPlan — 416 range past EOF (heuristic overshoot)', () => {
  const URL_416 = 'https://test/overshoot.bin';
  const CHUNK = 4;

  /** Seed contiguous parts covering `realTotal` under the plan's size stamp. */
  async function seedParts(planSize: number, realTotal: number): Promise<Uint8Array> {
    const body = Uint8Array.from({ length: realTotal }, (_, i) => (i % 251) + 1);
    const stamp = `s${planSize}`;
    for (let offset = 0; offset < realTotal; offset += CHUNK) {
      const slice = body.subarray(offset, offset + CHUNK);
      await storage.put(
        { modelId: MODEL_ID, url: `${URL_416}${PART_MARKER}${stamp}.${offset}` },
        new Response(slice as unknown as BodyInit),
      );
    }
    return body;
  }

  it('a 416 with Content-Range corrects the total, completes, and sweeps nothing', async () => {
    const realTotal = 8;
    const planSize = 12; // overshoot; > realTotal by one chunk so the loop still requests
    await seedParts(planSize, realTotal);

    const log: { url: string; range: string }[] = [];
    const result = await downloadByPlan(
      { modelId: MODEL_ID, files: [{ url: URL_416, sizeBytes: planSize }] },
      {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: CHUNK,
        // The only reachable range (bytes past the resumed EOF) is unsatisfiable →
        // 416 carrying the origin's real total.
        fetcher: rangeDispatch(log, {
          [URL_416]: () =>
            new Response(null, { status: 416, headers: { 'content-range': `bytes */${realTotal}` } }),
        }),
      },
    );

    expect(result.filesFetched).toBe(1);
    // finalizeParts stamped the CORRECTED real total, not the plan's overshoot.
    expect((await storage.get({ modelId: MODEL_ID, url: URL_416 }))!.sizeBytes).toBe(realTotal);
    expect(await storage.verify({ modelId: MODEL_ID, url: URL_416 }, realTotal)).toBe(true);
    // Exactly one range request — the unsatisfiable probe that corrected the total.
    expect(log).toHaveLength(1);
    // The parts are retained as the parts-native terminal storage, not swept.
    expect(await partEntries(await storage.listForModel(MODEL_ID))).toHaveLength(2);
  });

  it('a 416 with no Content-Range clears the resumed parts and fails for a clean retry', async () => {
    const realTotal = 8;
    const planSize = 12;
    const body = await seedParts(planSize, realTotal);

    await expect(
      downloadByPlan({ modelId: MODEL_ID, files: [{ url: URL_416, sizeBytes: planSize }] }, {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: CHUNK,
        fetcher: rangeDispatch([], { [URL_416]: () => new Response(null, { status: 416 }) }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    // The un-correctable 416 swept the resumed parts — a clean slate.
    expect(await partEntries(await storage.listForModel(MODEL_ID))).toHaveLength(0);

    // A subsequent attempt with a healthy origin re-downloads from byte 0.
    const log: { url: string; range: string }[] = [];
    const result = await downloadByPlan(
      { modelId: MODEL_ID, files: [{ url: URL_416, sizeBytes: planSize }] },
      {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: CHUNK,
        fetcher: rangeDispatch(log, { [URL_416]: serveRanges(body) }),
      },
    );
    expect(result.filesFetched).toBe(1);
    expect(log[0]!.range).toBe('bytes=0-3'); // restarted from byte 0
  });

  it('a 404 mid-resume still fails fast WITHOUT sweeping the resumed parts (regression)', async () => {
    const realTotal = 8;
    const planSize = 12;
    await seedParts(planSize, realTotal);

    await expect(
      downloadByPlan({ modelId: MODEL_ID, files: [{ url: URL_416, sizeBytes: planSize }] }, {
        storage,
        estimateStorage: async () => null,
        rangeChunkBytes: CHUNK,
        fetcher: rangeDispatch([], { [URL_416]: () => new Response(null, { status: 404 }) }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    // A 404 is a hard failure, not EOF evidence — the resume bytes are preserved.
    expect(await partOffsets(storage, MODEL_ID)).toEqual([0, 4]);
  });
});

// ─── Estimate sizes gate on intactness, not byte-equality (Fix B) ───────────
//
// A heuristic-fallback plan's sizeBytes is a progress figure, never an integrity
// criterion. A file correctly stored (stamped with its ACTUAL bytes) must not
// fail verification forever against a heuristic estimate. isModelFullyCached
// therefore checks intactness for estimate-flagged files, and byte-equality only
// for reviewed (non-estimate) sizes.

describe('isModelFullyCached — estimate sizes gate on intactness', () => {
  it('is true when an estimate-size file is intact even though the stamp differs from the estimate', async () => {
    const url = 'https://test/est.onnx';
    await storage.put({ modelId: MODEL_ID, url }, new Response(byteArr(1, 2, 3, 4, 5) as unknown as BodyInit));
    const model = { id: MODEL_ID } as ModelConfig;
    setDownloadPlanResolver(async () => ({
      modelId: MODEL_ID,
      files: [{ url, sizeBytes: 9999, sizeIsEstimate: true }], // estimate ≠ stored 5
    }));

    expect(await isModelFullyCached(model, { storage })).toBe(true);
  });

  it('is still false when a NON-estimate size mismatches the stored stamp (regression)', async () => {
    const url = 'https://test/reviewed.onnx';
    await storage.put({ modelId: MODEL_ID, url }, new Response(byteArr(1, 2, 3, 4, 5) as unknown as BodyInit));
    const model = { id: MODEL_ID } as ModelConfig;
    setDownloadPlanResolver(async () => ({
      modelId: MODEL_ID,
      files: [{ url, sizeBytes: 9999 }], // reviewed size → byte-equality required
    }));

    expect(await isModelFullyCached(model, { storage })).toBe(false);
  });
});

/** Read a ReadableStream fully into one Uint8Array (test helper). */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
