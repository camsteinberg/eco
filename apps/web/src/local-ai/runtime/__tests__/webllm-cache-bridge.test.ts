// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebLLM cache-bridge contract tests.
 *
 * The load-bearing invariant is verified against the REAL `hasModelInCache`
 * from `@mlc-ai/web-llm` run over an in-memory `caches` global: after a bridge
 * download, the library itself must see the model as fully cached (so
 * `engine.reload()` is a pure cache hit). This pins the library's actual
 * cache-key semantics rather than a hand-copied stand-in — a web-llm bump that
 * changed them would fail here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../types';
import type { CacheStorageLike, Storage, StorageKey, CachedEntry } from '../../download/storage';
import { AdapterError } from '../types';
import {
  bridgeDownloadWebLLMModel,
  webllmModelInCache,
} from '../webllm-cache-bridge';
import { WebLLMAdapter } from '../webllm-adapter';

// ─── In-memory Cache API (keys by request.url, exactly like the browser) ─────

class MemCache {
  // Buffer bytes on put and hand out a fresh Response per match — the real
  // Cache API stores bytes, not a live stream, so each match is independently
  // readable (a stored stream-backed Response would be single-use, which the
  // browser is not).
  store = new Map<string, ArrayBuffer>();
  private urlOf(req: RequestInfo | URL): string {
    return typeof req === 'string' ? new Request(req).url : (req as Request).url;
  }
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    this.store.set(this.urlOf(req), await res.arrayBuffer());
  }
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const buf = this.store.get(this.urlOf(req));
    return buf === undefined ? undefined : new Response(buf);
  }
  async keys(): Promise<readonly Request[]> {
    return [...this.store.keys()].map((u) => new Request(u));
  }
  async delete(req: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(this.urlOf(req));
  }
  // tvmjs's hasAllKeys path never calls add() (the bytes are already cached),
  // but its fetchWithCache add-on-miss would; supply it for completeness.
  async add(req: RequestInfo | URL): Promise<void> {
    this.store.set(this.urlOf(req), new ArrayBuffer(1));
  }
}

class MemCaches implements CacheStorageLike {
  caches = new Map<string, MemCache>();
  async open(name: string): Promise<MemCache> {
    if (!this.caches.has(name)) this.caches.set(name, new MemCache());
    return this.caches.get(name)!;
  }
  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

// ─── Fake Eco storage: returns the staged file bytes, records removals ────────

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The MLC repo files a q4f16 model ships, keyed by repo-relative path. */
const FILE_BYTES: Record<string, Uint8Array> = {
  'tensor-cache.json': enc(
    JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 4 }], metadata: {} }),
  ),
  'params_shard_0.bin': new Uint8Array([1, 2, 3, 4]),
  'mlc-chat-config.json': enc(JSON.stringify({ model_type: 'qwen2' })),
  'tokenizer.json': enc('{}'),
};

const FILES = Object.keys(FILE_BYTES);

function makeEcoStorage(overrides?: { missing?: string }): {
  storage: Storage;
  removed: string[];
} {
  const removed: string[] = [];
  const storage = {
    async get(key: StorageKey): Promise<CachedEntry | null> {
      const filePath = FILES.find((f) => key.url.endsWith(f));
      if (!filePath || filePath === overrides?.missing) return null;
      const bytes = FILE_BYTES[filePath]!;
      return { response: new Response(bytes as unknown as BodyInit), sizeBytes: bytes.length };
    },
    async remove(key: StorageKey): Promise<void> {
      removed.push(key.url);
    },
  } as unknown as Storage;
  return { storage, removed };
}

const MODEL: ModelConfig = {
  id: 'candidate/qwen2-0.5b-webllm',
  friendlyName: 'Qwen2 0.5B',
  vendor: 'MLC',
  sizeGB: 0.3,
  runtime: 'webllm',
  format: 'mlc-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
  bestFor: 't',
  knownLimitation: 'k',
  evidenceTier: 'proven',
  artifact: {
    hfId: 'mlc-ai/Qwen2-0.5B-Instruct-q4f16_1-MLC',
    revision: 'main',
    files: FILES,
  },
};

const MLC_ID = 'Qwen2-0.5B-Instruct-q4f16_1-MLC';

let memCaches: MemCaches;

beforeEach(() => {
  memCaches = new MemCaches();
  vi.stubGlobal('caches', memCaches);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Acceptance invariant (real hasModelInCache) ─────────────────────────────

describe('bridgeDownloadWebLLMModel — acceptance invariant', () => {
  it('populates WebLLM cache so the REAL hasModelInCache (and adapter.weightsCached) return true', async () => {
    const { storage, removed } = makeEcoStorage();
    const download = vi.fn().mockResolvedValue(undefined);

    // Default hasModelInCache = the real @mlc-ai/web-llm one; default caches =
    // the stubbed in-memory global. Origin defaults to the jsdom location so the
    // adapter check below resolves the same keys.
    await bridgeDownloadWebLLMModel(MODEL, { storage, download });

    // Real library confirms the model is cache-complete.
    const adapter = new WebLLMAdapter();
    expect(await adapter.weightsCached(MODEL)).toBe(true);

    // The download pipeline actually ran, and every Eco staging copy was freed.
    expect(download).toHaveBeenCalledTimes(1);
    expect(removed).toHaveLength(FILES.length);
  });

  it('routes files into the correct WebLLM namespaces', async () => {
    const { storage } = makeEcoStorage();
    await bridgeDownloadWebLLMModel(MODEL, { storage, download: vi.fn().mockResolvedValue(undefined) });

    const base = `${window.location.origin}/webllm/models/${MLC_ID}/resolve/main/`;
    const modelCache = await memCaches.open('webllm/model');
    const configCache = await memCaches.open('webllm/config');

    expect(modelCache.store.has(`${base}tensor-cache.json`)).toBe(true);
    expect(modelCache.store.has(`${base}params_shard_0.bin`)).toBe(true);
    expect(modelCache.store.has(`${base}tokenizer.json`)).toBe(true);
    expect(configCache.store.has(`${base}mlc-chat-config.json`)).toBe(true);
    // config file is NOT duplicated into the model namespace
    expect(modelCache.store.has(`${base}mlc-chat-config.json`)).toBe(false);
  });

  it('forwards tracker and signal to the download seam', async () => {
    const { storage } = makeEcoStorage();
    const download = vi.fn().mockResolvedValue(undefined);
    const tracker = { reportDownloadProgress: vi.fn() } as never;
    const signal = new AbortController().signal;

    await bridgeDownloadWebLLMModel(MODEL, { storage, download, tracker, signal });

    expect(download).toHaveBeenCalledWith(MODEL, { tracker, signal });
  });
});

// ─── Returning-user fast path ────────────────────────────────────────────────

describe('bridgeDownloadWebLLMModel — fast path', () => {
  it('skips download and copy when the model is already cached, marking download complete', async () => {
    const { storage, removed } = makeEcoStorage();
    const download = vi.fn().mockResolvedValue(undefined);
    const tracker = { reportDownloadProgress: vi.fn() } as never;

    await bridgeDownloadWebLLMModel(MODEL, {
      storage,
      download,
      tracker,
      hasModelInCache: async () => true,
    });

    expect(download).not.toHaveBeenCalled();
    expect(removed).toHaveLength(0);
    expect((tracker as { reportDownloadProgress: ReturnType<typeof vi.fn> }).reportDownloadProgress)
      .toHaveBeenCalledWith(1, 1);
  });
});

// ─── Fail-loud contract ──────────────────────────────────────────────────────

describe('bridgeDownloadWebLLMModel — fails loudly', () => {
  it('throws init-failed naming the contract break when hasModelInCache stays false', async () => {
    const { storage } = makeEcoStorage();

    await expect(
      bridgeDownloadWebLLMModel(MODEL, {
        storage,
        download: vi.fn().mockResolvedValue(undefined),
        hasModelInCache: async () => false, // never becomes true
      }),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'init-failed',
    });
  });

  it('throws init-failed when a downloaded file is missing from Eco storage', async () => {
    const { storage } = makeEcoStorage({ missing: 'params_shard_0.bin' });

    await expect(
      bridgeDownloadWebLLMModel(MODEL, {
        storage,
        download: vi.fn().mockResolvedValue(undefined),
        // proceed past the fast path, then fail at the missing-file copy
        hasModelInCache: async () => false,
      }),
    ).rejects.toThrowError(/missing from Eco storage/i);
  });

  it('rejects a model without artifact.hfId', async () => {
    const noArtifact = { ...MODEL, artifact: undefined } as ModelConfig;
    await expect(
      bridgeDownloadWebLLMModel(noArtifact, { storage: makeEcoStorage().storage }),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

// ─── webllmModelInCache (probe gate helper) ──────────────────────────────────

describe('webllmModelInCache', () => {
  it('returns the real hasModelInCache verdict after a bridge populate', async () => {
    const { storage } = makeEcoStorage();
    await bridgeDownloadWebLLMModel(MODEL, { storage, download: vi.fn().mockResolvedValue(undefined) });
    expect(await webllmModelInCache(MODEL)).toBe(true);
  });

  it('returns false for a model without an artifact', async () => {
    const noArtifact = { ...MODEL, artifact: undefined } as ModelConfig;
    expect(await webllmModelInCache(noArtifact)).toBe(false);
  });

  it('fails closed when the cache check throws', async () => {
    expect(
      await webllmModelInCache(MODEL, {
        hasModelInCache: async () => {
          throw new Error('boom');
        },
      }),
    ).toBe(false);
  });
});
