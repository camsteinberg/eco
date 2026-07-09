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
  listActiveDownloads,
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
    this.store.set(url, response.clone());
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

const MODEL_ID = 'local/phi3-mini-4k-q4f16';

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
        fetcher: createFetcher({ [a.url]: { body: a.body, status: 503 } }),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);
  });
});

// ─── DI seam: downloadModel ────────────────────────────────────────────────

describe('downloadModel — resolver DI', () => {
  const model: ModelConfig = {
    id: MODEL_ID,
    friendlyName: 'Phi-3 Mini',
    vendor: 'Microsoft',
    sizeGB: 2.14,
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
      // Second range request (index 1) fails once, then the retry succeeds.
      fetcher: createRangeFetcher({ [url]: body }, { failOnceAtRequest: 1 }),
    });
    expect(result.filesFetched).toBe(1);
    expect((await storage.get({ modelId: MODEL_ID, url }))!.sizeBytes).toBe(body.byteLength);
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
