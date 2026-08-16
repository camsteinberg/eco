// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, beforeEach } from 'vitest';
import { CacheApiStorage, type CacheLike, type CacheStorageLike } from '../../download/storage';
import { createStorageBridge } from '../storage-bridge';

class MemoryCache implements CacheLike {
  private store = new Map<string, Response>();
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    this.store.set(key(req), res.clone());
  }
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const r = this.store.get(key(req));
    return r ? r.clone() : undefined;
  }
  async keys(): Promise<readonly Request[]> {
    return Array.from(this.store.keys()).map((u) => new Request(u));
  }
  async delete(req: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(key(req));
  }
}

class MemoryCacheStorage implements CacheStorageLike {
  private caches = new Map<string, MemoryCache>();
  async open(name: string): Promise<MemoryCache> {
    let c = this.caches.get(name);
    if (!c) { c = new MemoryCache(); this.caches.set(name, c); }
    return c;
  }
  async has(name: string): Promise<boolean> { return this.caches.has(name); }
  async keys(): Promise<string[]> { return Array.from(this.caches.keys()); }
  async delete(name: string): Promise<boolean> { return this.caches.delete(name); }
}

function key(req: RequestInfo | URL): string {
  if (typeof req === 'string') return req;
  if (req instanceof URL) return req.toString();
  return req.url;
}

const MODEL_ID = 'local/qwen3-0.6b';

let storage: CacheApiStorage;

beforeEach(() => {
  storage = new CacheApiStorage(new MemoryCacheStorage());
});

describe('createStorageBridge', () => {
  it('match returns a Response for a stored URL', async () => {
    const url = 'https://hf.co/test/config.json';
    await storage.put({ modelId: MODEL_ID, url }, new Response(new Uint8Array([1, 2, 3])));

    const bridge = createStorageBridge({ storage, modelId: MODEL_ID });
    const result = await bridge.match(url);
    expect(result).toBeDefined();
    expect(result?.headers.get('x-eco-cache-size-bytes')).toBe('3');
  });

  it('match sets Content-Length from the verified cache size so the loader preallocates', async () => {
    const url = 'https://hf.co/test/model.onnx_data';
    await storage.put({ modelId: MODEL_ID, url }, new Response(new Uint8Array([1, 2, 3, 4, 5])));

    const bridge = createStorageBridge({ storage, modelId: MODEL_ID });
    const result = await bridge.match(url);

    expect(result?.headers.get('content-length')).toBe('5');
    // The verified-size header is preserved alongside it.
    expect(result?.headers.get('x-eco-cache-size-bytes')).toBe('5');
    // (Body passthrough via `new Response(response.body, …)` is a standard
    // browser pattern verified in real runtimes; jsdom can't round-trip a
    // re-wrapped stream, so we don't assert body bytes here.)
  });

  it('match returns undefined for an unknown URL', async () => {
    const bridge = createStorageBridge({ storage, modelId: MODEL_ID });
    const result = await bridge.match('https://hf.co/test/missing.json');
    expect(result).toBeUndefined();
  });

  it('match returns undefined when called with undefined (TJS #1249 guard)', async () => {
    const bridge = createStorageBridge({ storage, modelId: MODEL_ID });
    const result = await bridge.match(undefined);
    expect(result).toBeUndefined();
  });

  it('match accepts a Request object', async () => {
    const url = 'https://hf.co/test/x.bin';
    await storage.put({ modelId: MODEL_ID, url }, new Response(new Uint8Array([7])));

    const bridge = createStorageBridge({ storage, modelId: MODEL_ID });
    const result = await bridge.match(new Request(url));
    expect(result).toBeDefined();
  });

  it('put forwards through to storage.put', async () => {
    const url = 'https://hf.co/test/x.bin';
    const bridge = createStorageBridge({ storage, modelId: MODEL_ID });
    await bridge.put(url, new Response(new Uint8Array([1, 2, 3, 4])));

    const direct = await storage.get({ modelId: MODEL_ID, url });
    expect(direct).not.toBeNull();
    expect(direct!.sizeBytes).toBe(4);
  });

  it('put does NOT clobber a parts-native manifest with a whole-file body', async () => {
    // TJS calls put() after a remote fetch. For a chunked weight already stored
    // parts-native, overwriting the manifest with the whole fetched body would
    // both destroy the manifest and perform the single huge Cache-API put
    // parts-native exists to avoid — so the bridge must skip it.
    const url = 'https://hf.co/test/model.onnx_data';
    const partKeys = [`${url}.ecopart.s6.0`, `${url}.ecopart.s6.3`];
    await storage.put({ modelId: MODEL_ID, url: partKeys[0]! }, new Response(new Uint8Array([1, 2, 3])));
    await storage.put({ modelId: MODEL_ID, url: partKeys[1]! }, new Response(new Uint8Array([4, 5, 6])));
    await storage.finalizeParts({ modelId: MODEL_ID, url }, partKeys, 6);

    const bridge = createStorageBridge({ storage, modelId: MODEL_ID });
    await bridge.put(url, new Response(new Uint8Array(6))); // TJS re-put attempt

    // Still parts-native, its parts intact — the whole-body put was refused.
    expect(await storage.isPartsNative({ modelId: MODEL_ID, url })).toBe(true);
    for (const key of partKeys) {
      expect(await storage.has({ modelId: MODEL_ID, url: key })).toBe(true);
    }
    expect((await storage.get({ modelId: MODEL_ID, url }))!.sizeBytes).toBe(6);
  });

  it('two bridges with different modelIds keep caches separate', async () => {
    const a = createStorageBridge({ storage, modelId: 'model-a' });
    const b = createStorageBridge({ storage, modelId: 'model-b' });

    await a.put('https://hf.co/x', new Response(new Uint8Array([1])));
    expect(await b.match('https://hf.co/x')).toBeUndefined();
    expect(await a.match('https://hf.co/x')).toBeDefined();
  });
});
