// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
// @vitest-environment node

/**
 * Phase G — storage.ts unit tests.
 *
 * Runs under the `node` environment (not jsdom): the parts-native roundtrip
 * reads bytes back through a streamed composed Response, and jsdom's Response/
 * Blob polyfill does NOT faithfully preserve a binary body through
 * `.arrayBuffer()` (it stringifies blob bodies — the same unfaithfulness the
 * download.ts tests avoid). Node's undici implementation matches real browsers.
 *
 * The Cache API and OPFS are not implemented in either environment, so these
 * tests inject an in-memory `MemoryCacheStorage` fake into `CacheApiStorage` and
 * a hand-rolled `MemoryOpfsRoot` into `OpfsStorage`; the real OPFS path is
 * verified in Phase L's Playwright pass.
 *
 * Bug #4 regression test lives in this file (CDN strips content-length →
 * stored entry must NOT auto-delete on count).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CacheApiStorage,
  type CacheStorageLike,
  type CacheLike,
  cleanCorrupted,
  countCached,
  ECO_CACHE_SIZE_HEADER,
  type FileSpec,
  OpfsStorage,
  type OpfsRoot,
  type OpfsDirHandle,
  type OpfsFileHandle,
} from '../storage';

// ─── In-memory CacheStorage fake ────────────────────────────────────────────

class MemoryCache implements CacheLike {
  private readonly store = new Map<string, Response>();

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const url = requestKey(request);
    // Clone so callers can still read the body if they kept a reference.
    this.store.set(url, response.clone());
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = requestKey(request);
    const cached = this.store.get(url);
    return cached ? cached.clone() : undefined;
  }

  async keys(request?: RequestInfo | URL): Promise<readonly Request[]> {
    // Honour the argument exactly as the browser does: only the matching entry.
    const urls = request === undefined
      ? Array.from(this.store.keys())
      : this.store.has(requestKey(request)) ? [requestKey(request)] : [];
    return urls.map((url) => new Request(url));
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
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  // Normalise as the browser's Cache does (`new Request(x).url`), resolving a
  // relative proxy path against a fixed origin, so a url read back from keys()
  // addresses the same entry as the string it was stored under.
  return new Request(new URL(raw, 'http://localhost/')).url;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const MODEL = 'local/qwen3-0.6b';

function chunkedTransferResponse(payload: Uint8Array): Response {
  // Mimic a CDN that strips content-length on chunked transfer: the headers
  // contain only transfer-encoding, NOT content-length. The body still has
  // the bytes; storage.put() must derive the size from the body, not from
  // any header. Cast through `BodyInit` is needed because TS's strict typing
  // narrows BodyInit to ArrayBuffer-backed Uint8Array; runtime accepts either.
  return new Response(payload as unknown as BodyInit, {
    status: 200,
    headers: { 'transfer-encoding': 'chunked' },
  });
}

// ─── put() always writes Eco-Cache-Size (Invariant 6) ────────────────────────

describe('CacheApiStorage.put — Eco-Cache-Size header', () => {
  let storage: CacheApiStorage;
  let cacheStorage: MemoryCacheStorage;

  beforeEach(() => {
    cacheStorage = new MemoryCacheStorage();
    storage = new CacheApiStorage(cacheStorage);
  });

  it('writes Eco-Cache-Size on every put, even when source response lacks content-length', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await storage.put(
      { modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' },
      chunkedTransferResponse(payload),
    );

    const entry = await storage.get({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' });
    expect(entry).not.toBeNull();
    expect(entry!.sizeBytes).toBe(8);
    expect(entry!.response.headers.get(ECO_CACHE_SIZE_HEADER)).toBe('8');
  });

  it('overwrites Eco-Cache-Size with the body size even if the source response had a lying content-length', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const lyingResponse = new Response(payload, {
      headers: { 'content-length': '9999' }, // wrong on purpose
    });
    await storage.put(
      { modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' },
      lyingResponse,
    );

    const entry = await storage.get({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' });
    expect(entry!.sizeBytes).toBe(4);
  });
});

describe('CacheApiStorage.putStreamed — streams a known-size body without materializing it', () => {
  let storage: CacheApiStorage;
  let cacheStorage: MemoryCacheStorage;

  beforeEach(() => {
    cacheStorage = new MemoryCacheStorage();
    storage = new CacheApiStorage(cacheStorage);
  });

  function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        // Two enqueues so the reader path sees more than one pull.
        const mid = Math.ceil(bytes.byteLength / 2);
        controller.enqueue(bytes.subarray(0, mid));
        controller.enqueue(bytes.subarray(mid));
        controller.close();
      },
    });
  }

  it('stamps Eco-Cache-Size with the vouched size and stores the streamed bytes', async () => {
    const payload = new Uint8Array([3, 1, 4, 1, 5, 9, 2, 6]);
    await storage.putStreamed(
      { modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' },
      streamOf(payload),
      payload.byteLength,
    );

    const entry = await storage.get({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' });
    expect(entry).not.toBeNull();
    // The size is the caller's vouched figure, stamped verbatim (never read
    // from the body — that materialization is exactly what putStreamed avoids).
    expect(entry!.sizeBytes).toBe(payload.byteLength);
    expect(entry!.response.headers.get(ECO_CACHE_SIZE_HEADER)).toBe(String(payload.byteLength));
    // The body round-trips: get() returns the bytes that were streamed in.
    const stored = new Uint8Array(await entry!.response.arrayBuffer());
    expect([...stored]).toEqual([...payload]);
  });

  it('stamps the vouched size verbatim even when it differs from the body length', async () => {
    // putStreamed trusts the caller's figure (the download's authoritative total)
    // rather than measuring the body — verify() reads exactly what was stamped.
    const payload = new Uint8Array([1, 2, 3, 4]);
    await storage.putStreamed(
      { modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' },
      streamOf(payload),
      99,
    );
    const entry = await storage.get({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' });
    expect(entry!.sizeBytes).toBe(99);
    expect(await storage.verify({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' }, 99)).toBe(true);
  });
});

describe('CacheApiStorage.finalizeParts — parts-native terminal storage', () => {
  let storage: CacheApiStorage;

  beforeEach(() => {
    storage = new CacheApiStorage(new MemoryCacheStorage());
  });

  const IDENTITY = 'https://cdn/qwen3/model.onnx_data';
  const chunks = [
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]),
    new Uint8Array([17, 18, 19, 20, 21, 22, 23, 24]),
  ];
  const whole = new Uint8Array([...chunks[0]!, ...chunks[1]!, ...chunks[2]!]); // 24 bytes

  /** Stage each chunk as its own cache entry (as the chunked download does),
   *  returning the ordered part keys + aggregate total. */
  async function stageParts(): Promise<{ partKeys: string[]; total: number }> {
    const partKeys: string[] = [];
    let offset = 0;
    for (const chunk of chunks) {
      const key = `${IDENTITY}.ecopart.s24.${offset}`;
      await storage.put({ modelId: MODEL, url: key }, new Response(chunk as unknown as BodyInit));
      partKeys.push(key);
      offset += chunk.byteLength;
    }
    return { partKeys, total: offset };
  }

  it('get() composes the parts into the exact original bytes with the aggregate size', async () => {
    const { partKeys, total } = await stageParts();
    await storage.finalizeParts({ modelId: MODEL, url: IDENTITY }, partKeys, total);

    const entry = await storage.get({ modelId: MODEL, url: IDENTITY });
    expect(entry).not.toBeNull();
    expect(entry!.sizeBytes).toBe(24);
    expect(entry!.response.headers.get(ECO_CACHE_SIZE_HEADER)).toBe('24');
    expect([...new Uint8Array(await entry!.response.arrayBuffer())]).toEqual([...whole]);
    expect(await storage.isPartsNative({ modelId: MODEL, url: IDENTITY })).toBe(true);
  });

  it('verify() is true for the stamped total, false for a wrong total', async () => {
    const { partKeys, total } = await stageParts();
    await storage.finalizeParts({ modelId: MODEL, url: IDENTITY }, partKeys, total);
    expect(await storage.verify({ modelId: MODEL, url: IDENTITY }, 24)).toBe(true);
    expect(await storage.verify({ modelId: MODEL, url: IDENTITY }, 23)).toBe(false);
  });

  it('verify() is false when a listed part is deleted out from under the manifest', async () => {
    const { partKeys, total } = await stageParts();
    await storage.finalizeParts({ modelId: MODEL, url: IDENTITY }, partKeys, total);
    // Remove the middle part directly (a plain entry, so remove() just deletes it).
    await storage.remove({ modelId: MODEL, url: partKeys[1]! });
    expect(await storage.verify({ modelId: MODEL, url: IDENTITY }, 24)).toBe(false);
  });

  it('remove(identity) deletes the manifest AND every listed part', async () => {
    const { partKeys, total } = await stageParts();
    await storage.finalizeParts({ modelId: MODEL, url: IDENTITY }, partKeys, total);
    await storage.remove({ modelId: MODEL, url: IDENTITY });
    expect(await storage.has({ modelId: MODEL, url: IDENTITY })).toBe(false);
    for (const key of partKeys) {
      expect(await storage.has({ modelId: MODEL, url: key })).toBe(false);
    }
    expect(await storage.listForModel(MODEL)).toHaveLength(0);
  });

  it('get() surfaces a read error when a listed part is missing (no silent truncation)', async () => {
    const { partKeys, total } = await stageParts();
    await storage.finalizeParts({ modelId: MODEL, url: IDENTITY }, partKeys, total);
    // Drop a middle part but leave the manifest; a read must fail, not truncate.
    await storage.remove({ modelId: MODEL, url: partKeys[1]! });
    const entry = await storage.get({ modelId: MODEL, url: IDENTITY });
    expect(entry).not.toBeNull();
    await expect(entry!.response.arrayBuffer()).rejects.toThrow();
  });

  it('leaves plain whole-file entries unaffected — not parts-native, body round-trips', async () => {
    await storage.put(
      { modelId: MODEL, url: 'https://cdn/qwen3/config.json' },
      new Response(new Uint8Array([9, 9, 9])),
    );
    expect(await storage.isPartsNative({ modelId: MODEL, url: 'https://cdn/qwen3/config.json' })).toBe(false);
    const entry = await storage.get({ modelId: MODEL, url: 'https://cdn/qwen3/config.json' });
    expect(entry!.sizeBytes).toBe(3);
    expect([...new Uint8Array(await entry!.response.arrayBuffer())]).toEqual([9, 9, 9]);
  });
});

describe('CacheApiStorage.verifyIntact — existence + intactness, not byte-equality', () => {
  let storage: CacheApiStorage;
  let cacheStorage: MemoryCacheStorage;

  beforeEach(() => {
    cacheStorage = new MemoryCacheStorage();
    storage = new CacheApiStorage(cacheStorage);
  });

  const IDENTITY = 'https://cdn/qwen3/model.onnx_data';
  const chunks = [
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]),
    new Uint8Array([17, 18, 19, 20, 21, 22, 23, 24]),
  ];

  async function stageParts(): Promise<{ partKeys: string[]; total: number }> {
    const partKeys: string[] = [];
    let offset = 0;
    for (const chunk of chunks) {
      const key = `${IDENTITY}.ecopart.s24.${offset}`;
      await storage.put({ modelId: MODEL, url: key }, new Response(chunk as unknown as BodyInit));
      partKeys.push(key);
      offset += chunk.byteLength;
    }
    return { partKeys, total: offset };
  }

  it('is true for a whole-file entry regardless of the stored size', async () => {
    await storage.put({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' }, new Response(new Uint8Array(42)));
    // Any expected size would do — verifyIntact never compares against one.
    expect(await storage.verifyIntact!({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' })).toBe(true);
  });

  it('is false for a missing entry', async () => {
    expect(await storage.verifyIntact!({ modelId: MODEL, url: 'https://cdn/qwen3/absent.onnx' })).toBe(false);
  });

  it('is false for a legacy entry with no Eco-Cache-Size stamp', async () => {
    const cache = await cacheStorage.open('eco-local-ai-' + MODEL.replace(/[^a-zA-Z0-9._-]/g, '_'));
    await cache.put('https://cdn/qwen3/legacy.onnx', new Response(new Uint8Array(5)));
    expect(await storage.verifyIntact!({ modelId: MODEL, url: 'https://cdn/qwen3/legacy.onnx' })).toBe(false);
  });

  it('is true for a parts-native manifest when every listed part is present', async () => {
    const { partKeys, total } = await stageParts();
    await storage.finalizeParts({ modelId: MODEL, url: IDENTITY }, partKeys, total);
    expect(await storage.verifyIntact!({ modelId: MODEL, url: IDENTITY })).toBe(true);
  });

  it('is false for a parts-native manifest when a listed part was deleted', async () => {
    const { partKeys, total } = await stageParts();
    await storage.finalizeParts({ modelId: MODEL, url: IDENTITY }, partKeys, total);
    await storage.remove({ modelId: MODEL, url: partKeys[1]! });
    expect(await storage.verifyIntact!({ modelId: MODEL, url: IDENTITY })).toBe(false);
  });
});

describe('CacheApiStorage.verify — Eco-Cache-Size only, no content-length fallback', () => {
  let storage: CacheApiStorage;
  let cacheStorage: MemoryCacheStorage;

  beforeEach(() => {
    cacheStorage = new MemoryCacheStorage();
    storage = new CacheApiStorage(cacheStorage);
  });

  it('returns true when Eco-Cache-Size matches expected', async () => {
    await storage.put({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' }, new Response(new Uint8Array(5)));
    expect(
      await storage.verify({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' }, 5),
    ).toBe(true);
  });

  it('returns false when Eco-Cache-Size mismatches expected (but does NOT delete)', async () => {
    await storage.put({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' }, new Response(new Uint8Array(5)));
    expect(
      await storage.verify({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' }, 9),
    ).toBe(false);
    // Entry must still exist.
    expect(await storage.has({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' })).toBe(true);
  });

  it('returns false when Eco-Cache-Size is missing entirely (legacy untagged entry)', async () => {
    // Manually inject a cache entry without the Eco-Cache-Size header to
    // simulate an entry written by an older client.
    const cache = await cacheStorage.open('eco-local-ai-' + MODEL.replace(/[^a-zA-Z0-9._-]/g, '_'));
    await cache.put('https://cdn/qwen3/legacy.onnx', new Response(new Uint8Array(5)));

    expect(
      await storage.verify({ modelId: MODEL, url: 'https://cdn/qwen3/legacy.onnx' }, 5),
    ).toBe(false);
    // Entry still survives — verify never deletes.
    expect(await storage.has({ modelId: MODEL, url: 'https://cdn/qwen3/legacy.onnx' })).toBe(true);
  });

  it('IGNORES content-length even when Eco-Cache-Size is absent (no fallback)', async () => {
    const cache = await cacheStorage.open('eco-local-ai-' + MODEL.replace(/[^a-zA-Z0-9._-]/g, '_'));
    await cache.put(
      'https://cdn/qwen3/legacy.onnx',
      new Response(new Uint8Array(5), { headers: { 'content-length': '5' } }),
    );
    // content-length is right but Eco-Cache-Size is missing → verify is false.
    expect(
      await storage.verify({ modelId: MODEL, url: 'https://cdn/qwen3/legacy.onnx' }, 5),
    ).toBe(false);
  });
});

// ─── countCached() does NOT delete on mismatch (Invariant 7) ─────────────────

describe('countCached — decoupled from delete (Invariant 7)', () => {
  const files: FileSpec[] = [
    { url: 'https://cdn/qwen3/a.onnx', sizeBytes: 100 },
    { url: 'https://cdn/qwen3/b.onnx', sizeBytes: 200 },
    { url: 'https://cdn/qwen3/c.onnx', sizeBytes: 300 },
  ];

  let storage: CacheApiStorage;
  let cacheStorage: MemoryCacheStorage;

  beforeEach(() => {
    cacheStorage = new MemoryCacheStorage();
    storage = new CacheApiStorage(cacheStorage);
  });

  it('returns the number of files whose Eco-Cache-Size matches expected', async () => {
    await storage.put({ modelId: MODEL, url: files[0]!.url }, new Response(new Uint8Array(100)));
    await storage.put({ modelId: MODEL, url: files[1]!.url }, new Response(new Uint8Array(200)));
    // c.onnx not stored.
    const count = await countCached(storage, MODEL, files);
    expect(count).toBe(2);
  });

  it('does NOT delete entries that mismatch (Bug #4 regression)', async () => {
    // Store a.onnx with WRONG size.
    await storage.put({ modelId: MODEL, url: files[0]!.url }, new Response(new Uint8Array(99)));
    // b.onnx correct.
    await storage.put({ modelId: MODEL, url: files[1]!.url }, new Response(new Uint8Array(200)));

    const count = await countCached(storage, MODEL, files);
    expect(count).toBe(1); // only b passes verify

    // The mismatched entry must STILL EXIST — counting is not deletion.
    expect(await storage.has({ modelId: MODEL, url: files[0]!.url })).toBe(true);
  });

  it('does NOT delete entries that lack Eco-Cache-Size (legacy untagged)', async () => {
    const cache = await cacheStorage.open('eco-local-ai-' + MODEL.replace(/[^a-zA-Z0-9._-]/g, '_'));
    await cache.put(files[0]!.url, new Response(new Uint8Array(100)));
    await storage.put({ modelId: MODEL, url: files[1]!.url }, new Response(new Uint8Array(200)));

    const count = await countCached(storage, MODEL, files);
    // a.onnx (legacy untagged) fails verify → not counted.
    expect(count).toBe(1);
    // But it survives — count never deletes.
    expect(await storage.has({ modelId: MODEL, url: files[0]!.url })).toBe(true);
  });
});

// ─── Bug #4 regression: chunked-transfer response can be counted ─────────────

describe('Bug #4 regression', () => {
  it('stores a chunked-transfer response (no content-length) and verify+count succeed', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storage = new CacheApiStorage(cacheStorage);
    const payload = new Uint8Array(8192);

    await storage.put(
      { modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' },
      chunkedTransferResponse(payload),
    );

    const verified = await storage.verify(
      { modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' },
      8192,
    );
    expect(verified).toBe(true);

    const count = await countCached(storage, MODEL, [
      { url: 'https://cdn/qwen3/model.onnx', sizeBytes: 8192 },
    ]);
    expect(count).toBe(1);

    // Most importantly: the entry survives count, even if count had been called repeatedly.
    await countCached(storage, MODEL, [
      { url: 'https://cdn/qwen3/model.onnx', sizeBytes: 8192 },
    ]);
    expect(await storage.has({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' })).toBe(true);
  });
});

// ─── cleanCorrupted — the only explicit deletion path ────────────────────────

describe('cleanCorrupted — explicit cleanup', () => {
  it('removes only mismatched entries, returns the count of removed', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storage = new CacheApiStorage(cacheStorage);
    const files: FileSpec[] = [
      { url: 'https://cdn/a', sizeBytes: 100 },
      { url: 'https://cdn/b', sizeBytes: 200 },
    ];

    await storage.put({ modelId: MODEL, url: files[0]!.url }, new Response(new Uint8Array(50))); // wrong
    await storage.put({ modelId: MODEL, url: files[1]!.url }, new Response(new Uint8Array(200))); // right

    const removed = await cleanCorrupted(storage, MODEL, files);
    expect(removed).toBe(1);
    expect(await storage.has({ modelId: MODEL, url: files[0]!.url })).toBe(false);
    expect(await storage.has({ modelId: MODEL, url: files[1]!.url })).toBe(true);
  });

  it('does not touch missing entries (does not auto-create or error)', async () => {
    const storage = new CacheApiStorage(new MemoryCacheStorage());
    const files: FileSpec[] = [{ url: 'https://cdn/missing', sizeBytes: 100 }];
    const removed = await cleanCorrupted(storage, MODEL, files);
    expect(removed).toBe(0);
  });
});

// ─── Model scoping ──────────────────────────────────────────────────────────

describe('Per-model scoping', () => {
  it('entries from one modelId are not visible from another', async () => {
    const storage = new CacheApiStorage(new MemoryCacheStorage());
    await storage.put({ modelId: 'local/a', url: 'https://cdn/file' }, new Response(new Uint8Array(10)));
    expect(await storage.has({ modelId: 'local/a', url: 'https://cdn/file' })).toBe(true);
    expect(await storage.has({ modelId: 'local/b', url: 'https://cdn/file' })).toBe(false);
  });

  it('clearModel wipes one model without touching others', async () => {
    const storage = new CacheApiStorage(new MemoryCacheStorage());
    await storage.put({ modelId: 'local/a', url: 'https://cdn/file' }, new Response(new Uint8Array(10)));
    await storage.put({ modelId: 'local/b', url: 'https://cdn/file' }, new Response(new Uint8Array(10)));

    await storage.clearModel('local/a');
    expect(await storage.has({ modelId: 'local/a', url: 'https://cdn/file' })).toBe(false);
    expect(await storage.has({ modelId: 'local/b', url: 'https://cdn/file' })).toBe(true);
  });

  it('listForModel returns urls and Eco-Cache-Size values for the model', async () => {
    const storage = new CacheApiStorage(new MemoryCacheStorage());
    await storage.put({ modelId: 'local/a', url: 'https://cdn/x' }, new Response(new Uint8Array(7)));
    await storage.put({ modelId: 'local/a', url: 'https://cdn/y' }, new Response(new Uint8Array(11)));

    const entries = await storage.listForModel('local/a');
    const byUrl = new Map(entries.map((e) => [e.url, e.sizeBytes]));
    expect(byUrl.get('https://cdn/x')).toBe(7);
    expect(byUrl.get('https://cdn/y')).toBe(11);
  });
});

// ─── OPFS contract smoke test (minimal — Phase L exercises the real path) ────

class MemoryOpfsFile implements OpfsFileHandle {
  data: Uint8Array = new Uint8Array(0);
  async createWritable() {
    return {
      write: async (chunk: Blob | ArrayBuffer | Uint8Array) => {
        // Use ArrayBuffer.isView for cross-realm Uint8Array detection (jsdom
        // creates typed arrays in a different realm than test code; `instanceof`
        // is unreliable — see .claude/rules/testing.md JSDOM workaround).
        if (ArrayBuffer.isView(chunk)) {
          const view = chunk as ArrayBufferView;
          this.data = new Uint8Array(
            view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
          );
        } else if (chunk instanceof ArrayBuffer) {
          this.data = new Uint8Array(chunk);
        } else if (chunk != null && typeof (chunk as Blob).size === 'number') {
          // Best-effort Blob capture under jsdom — only the byte length matters
          // for the storage contract (the data file's bytes are opaque here).
          this.data = new Uint8Array((chunk as Blob).size);
        }
      },
      close: async () => undefined,
    };
  }
  async getFile() {
    // jsdom's File lacks .text() and .arrayBuffer(). Return a File-like
    // with both methods so the storage code's readSize path can exercise
    // its real helpers under jsdom.
    const bytes = this.data;
    return {
      size: bytes.length,
      name: 'mem',
      type: '',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(bytes),
    } as unknown as File;
  }
}

class MemoryOpfsDir implements OpfsDirHandle {
  files = new Map<string, MemoryOpfsFile>();

  async getFileHandle(name: string, options?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f) {
      if (!options?.create) throw new Error('not found');
      f = new MemoryOpfsFile();
      this.files.set(name, f);
    }
    return f;
  }
  async removeEntry(name: string) {
    this.files.delete(name);
  }
  async *values() {
    for (const name of this.files.keys()) yield { name, kind: 'file' as const };
  }
}

class MemoryOpfsRoot implements OpfsRoot {
  dirs = new Map<string, MemoryOpfsDir>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw new Error('not found');
      dir = new MemoryOpfsDir();
      this.dirs.set(name, dir);
    }
    return dir;
  }
  async removeEntry(name: string) {
    this.dirs.delete(name);
  }
}

describe('OpfsStorage — contract smoke (in-memory fake)', () => {
  it('roundtrips a put + get with the correct size', async () => {
    const root = new MemoryOpfsRoot();
    const storage = new OpfsStorage(root);
    await storage.put(
      { modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' },
      new Response(new Uint8Array(42)),
    );
    const entry = await storage.get({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' });
    expect(entry?.sizeBytes).toBe(42);
  });

  it('verify uses recorded size, not response headers', async () => {
    const root = new MemoryOpfsRoot();
    const storage = new OpfsStorage(root);
    await storage.put(
      { modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' },
      chunkedTransferResponse(new Uint8Array(128)),
    );
    expect(
      await storage.verify({ modelId: MODEL, url: 'https://cdn/qwen3/model.onnx' }, 128),
    ).toBe(true);
  });

  it('clearModel removes everything for one model', async () => {
    const root = new MemoryOpfsRoot();
    const storage = new OpfsStorage(root);
    await storage.put({ modelId: MODEL, url: 'https://cdn/x' }, new Response(new Uint8Array(1)));
    await storage.clearModel(MODEL);
    expect(await storage.has({ modelId: MODEL, url: 'https://cdn/x' })).toBe(false);
  });

  it('verifyIntact is true for a present entry (any size), false for a missing one', async () => {
    const root = new MemoryOpfsRoot();
    const storage = new OpfsStorage(root);
    await storage.put({ modelId: MODEL, url: 'https://cdn/w.onnx' }, new Response(new Uint8Array(64)));
    expect(await storage.verifyIntact!({ modelId: MODEL, url: 'https://cdn/w.onnx' })).toBe(true);
    expect(await storage.verifyIntact!({ modelId: MODEL, url: 'https://cdn/absent.onnx' })).toBe(false);
  });
});

// ─── listModelCacheNames + sweepOrphanedParts (boot-time dead-bytes sweep) ───

describe('CacheApiStorage.listModelCacheNames — Eco namespaces only', () => {
  it('returns only eco-local-ai-* namespaces, skipping foreign caches', async () => {
    const backend = new MemoryCacheStorage();
    const storage = new CacheApiStorage(backend);
    await storage.put({ modelId: 'local/a', url: 'https://cdn/a' }, new Response(new Uint8Array(1)));
    await storage.put({ modelId: 'candidate/b', url: 'https://cdn/b' }, new Response(new Uint8Array(1)));
    // A foreign (retired-runtime) cache that must never be enumerated as Eco's.
    await backend.open('webllm/model');

    const names = await storage.listModelCacheNames();

    expect(names).toContain('eco-local-ai-local_a');
    expect(names).toContain('eco-local-ai-candidate_b');
    expect(names).not.toContain('webllm/model');
  });
});

describe('CacheApiStorage.sweepOrphanedParts — keeps terminal parts, removes orphans', () => {
  const M = 'candidate/parts-model';
  const WEIGHTS = 'https://cdn/parts-model/weights.bin';

  it('removes a chunk-part no parts-native manifest claims', async () => {
    const storage = new CacheApiStorage(new MemoryCacheStorage());
    const orphan = `${WEIGHTS}.ecopart.s1000.0`;
    await storage.put({ modelId: M, url: orphan }, new Response(new Uint8Array(500)));

    const removed = await storage.sweepOrphanedParts(M);

    expect(removed).toBe(1);
    expect(await storage.has({ modelId: M, url: orphan })).toBe(false);
  });

  it('keeps parts a parts-native manifest references (they ARE the file bytes)', async () => {
    const storage = new CacheApiStorage(new MemoryCacheStorage());
    const partKeys = [`${WEIGHTS}.ecopart.s1000.0`, `${WEIGHTS}.ecopart.s1000.500`];
    for (const key of partKeys) {
      await storage.put({ modelId: M, url: key }, new Response(new Uint8Array(500)));
    }
    await storage.finalizeParts({ modelId: M, url: WEIGHTS }, partKeys, 1_000);

    const removed = await storage.sweepOrphanedParts(M);

    expect(removed).toBe(0);
    for (const key of partKeys) {
      expect(await storage.has({ modelId: M, url: key })).toBe(true);
    }
    // The composed file still reads back through the surviving manifest+parts.
    expect(await storage.verify({ modelId: M, url: WEIGHTS }, 1_000)).toBe(true);
  });

  it('leaves whole-file entries untouched while sweeping their leftover parts', async () => {
    const storage = new CacheApiStorage(new MemoryCacheStorage());
    // A completed whole-file store plus a stray resume part that the post-store
    // sweep never removed.
    await storage.put({ modelId: M, url: WEIGHTS }, new Response(new Uint8Array(1_000)));
    const stray = `${WEIGHTS}.ecopart.s1000.0`;
    await storage.put({ modelId: M, url: stray }, new Response(new Uint8Array(500)));

    const removed = await storage.sweepOrphanedParts(M);

    expect(removed).toBe(1);
    expect(await storage.has({ modelId: M, url: stray })).toBe(false);
    expect(await storage.verify({ modelId: M, url: WEIGHTS }, 1_000)).toBe(true);
  });

  it('no-ops (0) when the model has no cache namespace, never creating one', async () => {
    const backend = new MemoryCacheStorage();
    const storage = new CacheApiStorage(backend);

    const removed = await storage.sweepOrphanedParts('local/never-cached');

    expect(removed).toBe(0);
    expect(await backend.has('eco-local-ai-local_never-cached')).toBe(false);
  });
});

afterEach(() => {
  // No-op; tests own their own storage fakes.
});

// ─── Cached bodies are opened only when they are read ───────────────────────
//
// A `match()` result carries the entry's body. In Safari (measured on macOS)
// that body is loaded into memory and held until a garbage collection even
// when it is never read, so a presence check must not call `match()` at all,
// and a header-only read must cancel the body it opened. This cache hands out bodies that record
// whether they were read or cancelled (`highWaterMark: 0`, so `pull` runs only
// on an actual read).

class BodyTrackingCache implements CacheLike {
  private readonly store = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  readonly matchedUrls: string[] = [];
  opened = 0;
  read = 0;
  cancelled = 0;

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.store.set(requestKey(request), { bytes, headers: new Headers(response.headers) });
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = requestKey(request);
    this.matchedUrls.push(url);
    const entry = this.store.get(url);
    if (!entry) return undefined;
    this.opened += 1;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        this.read += 1;
        controller.enqueue(entry.bytes);
        controller.close();
      },
      cancel: () => {
        this.cancelled += 1;
      },
    }, { highWaterMark: 0 });
    return new Response(body, { headers: entry.headers });
  }

  async keys(request?: RequestInfo | URL): Promise<readonly Request[]> {
    const urls = request === undefined
      ? Array.from(this.store.keys())
      : this.store.has(requestKey(request)) ? [requestKey(request)] : [];
    return urls.map((url) => new Request(url));
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(requestKey(request));
  }

  /** Bodies handed out that were neither read nor cancelled. */
  get openBodies(): number {
    return this.opened - this.read - this.cancelled;
  }

  resetTally(): void {
    this.matchedUrls.length = 0;
    this.opened = 0;
    this.read = 0;
    this.cancelled = 0;
  }
}

class BodyTrackingCacheStorage implements CacheStorageLike {
  readonly caches = new Map<string, BodyTrackingCache>();
  async open(name: string): Promise<BodyTrackingCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new BodyTrackingCache();
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

describe('CacheApiStorage — cached bodies are opened only when read', () => {
  const IDENTITY = 'https://cdn/qwen3/model.onnx_data';
  const WHOLE = 'https://cdn/qwen3/model.onnx';
  const LEGACY = 'https://cdn/qwen3/legacy.onnx';
  const ORPHAN = 'https://cdn/qwen3/abandoned.bin.ecopart.s3.0';
  const PART_BYTES = 8;
  const PART_COUNT = 3;

  let storage: CacheApiStorage;
  let cache: BodyTrackingCache;
  let partKeys: string[];

  // Cancels are issued, not awaited, by the code under test; let them land.
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(async () => {
    const cacheStorage = new BodyTrackingCacheStorage();
    storage = new CacheApiStorage(cacheStorage);
    cache = await cacheStorage.open('eco-local-ai-' + MODEL.replace(/[^a-zA-Z0-9._-]/g, '_'));
    partKeys = [];
    for (let i = 0; i < PART_COUNT; i++) {
      const key = `${IDENTITY}.ecopart.s24.${i * PART_BYTES}`;
      await storage.put({ modelId: MODEL, url: key }, new Response(new Uint8Array(PART_BYTES).fill(i)));
      partKeys.push(key);
    }
    await storage.finalizeParts({ modelId: MODEL, url: IDENTITY }, partKeys, PART_BYTES * PART_COUNT);
    await storage.put({ modelId: MODEL, url: WHOLE }, new Response(new Uint8Array(5)));
    await cache.put(LEGACY, new Response(new Uint8Array(4))); // no size stamp
    await storage.put({ modelId: MODEL, url: ORPHAN }, new Response(new Uint8Array(3)));
    cache.resetTally();
  });

  it('has() answers by key for an identity, a part and a missing url, opening no entry', async () => {
    expect(await storage.has({ modelId: MODEL, url: IDENTITY })).toBe(true);
    expect(await storage.has({ modelId: MODEL, url: partKeys[1]! })).toBe(true);
    expect(await storage.has({ modelId: MODEL, url: WHOLE })).toBe(true);
    // Absent while the cache holds other entries: the lookup honours its key.
    expect(await storage.has({ modelId: MODEL, url: 'https://cdn/qwen3/absent.onnx' })).toBe(false);
    expect(cache.matchedUrls).toEqual([]);
  });

  it('verify() checks a parts-native file\'s parts by key, still catching a missing part', async () => {
    expect(await storage.verify({ modelId: MODEL, url: IDENTITY }, PART_BYTES * PART_COUNT)).toBe(true);
    expect(await storage.verifyIntact!({ modelId: MODEL, url: IDENTITY })).toBe(true);

    await cache.delete(partKeys[1]!);
    expect(await storage.verify({ modelId: MODEL, url: IDENTITY }, PART_BYTES * PART_COUNT)).toBe(false);

    await settle();
    expect(cache.matchedUrls.filter((url) => url.includes('.ecopart.'))).toEqual([]);
    // Only the identity's small manifest was opened, and it was read.
    expect(cache.matchedUrls).toEqual([IDENTITY, IDENTITY, IDENTITY]);
    expect(cache.openBodies).toBe(0);
  });

  it('remove() deletes a parts-native file\'s listed parts and releases every body it opens', async () => {
    await storage.remove({ modelId: MODEL, url: IDENTITY });
    // A parts-native remove opens only the manifest, never a part.
    expect(cache.matchedUrls).toEqual([IDENTITY]);
    await storage.remove({ modelId: MODEL, url: WHOLE });
    await storage.remove({ modelId: MODEL, url: ORPHAN }); // a part key, passed directly

    const left = (await cache.keys()).map((request) => request.url);
    expect(left).toEqual([LEGACY]);
    expect(cache.matchedUrls).toEqual([IDENTITY, WHOLE, ORPHAN]);
    await settle();
    expect(cache.openBodies).toBe(0);
  });

  // Each header-only read keeps its answer and releases every body it opens.
  it.each<[string, (s: CacheApiStorage) => Promise<unknown>, (result: unknown) => void]>([
    ['isPartsNative on a whole entry', (s) => s.isPartsNative({ modelId: MODEL, url: WHOLE }),
      (r) => expect(r).toBe(false)],
    ['isPartsNative on a manifest', (s) => s.isPartsNative({ modelId: MODEL, url: IDENTITY }),
      (r) => expect(r).toBe(true)],
    ['verifyIntact on a whole entry', (s) => s.verifyIntact({ modelId: MODEL, url: WHOLE }),
      (r) => expect(r).toBe(true)],
    ['verify with a mismatched size', (s) => s.verify({ modelId: MODEL, url: WHOLE }, 99),
      (r) => expect(r).toBe(false)],
    ['verify on an unstamped entry', (s) => s.verify({ modelId: MODEL, url: LEGACY }, 4),
      (r) => expect(r).toBe(false)],
    ['get on an unstamped entry', (s) => s.get({ modelId: MODEL, url: LEGACY }),
      (r) => expect(r).toBeNull()],
    ['listForModel over the whole namespace', (s) => s.listForModel(MODEL), (r) => {
      const sizes = new Map((r as { url: string; sizeBytes: number | null }[]).map((e) => [e.url, e.sizeBytes]));
      expect(sizes.size).toBe(PART_COUNT + 4);
      expect(sizes.get(IDENTITY)).toBe(PART_BYTES * PART_COUNT);
      expect(sizes.get(partKeys[0]!)).toBe(PART_BYTES);
      expect(sizes.get(WHOLE)).toBe(5);
      expect(sizes.get(LEGACY)).toBeNull();
    }],
    ['sweepOrphanedParts', (s) => s.sweepOrphanedParts(MODEL), (r) => expect(r).toBe(1)],
  ])('%s releases every body it opens', async (_name, run, check) => {
    check(await run(storage));
    await settle();
    expect(cache.opened).toBeGreaterThan(0);
    expect(cache.openBodies).toBe(0);
  });

  it('sweepOrphanedParts still keeps a manifest\'s parts and drops an orphan', async () => {
    await storage.sweepOrphanedParts(MODEL);
    const left = (await cache.keys()).map((request) => request.url);
    expect(left).not.toContain(ORPHAN);
    for (const key of partKeys) expect(left).toContain(key);
    await settle();
    expect(cache.openBodies).toBe(0);
  });
});
