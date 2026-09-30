// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Behaviour of our local patch to `@mlc-ai/web-llm` (patches/), run through the
 * library's public API with a fake WebGPU adapter and a fake Cache API.
 */

import { MLCEngine } from '@mlc-ai/web-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MiB = 1 << 20;
type Limits = Record<string, number | undefined>;

describe('WebGPU limits requested by the patched loader', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'gpu');
    vi.restoreAllMocks();
  });

  function installAdapter(maxBufferSize: number, maxStorageBufferBindingSize: number): Limits[] {
    const requested: Limits[] = [];
    const adapter = {
      limits: {
        maxBufferSize,
        maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: 32 * 1024,
        maxStorageBuffersPerShaderStage: 10,
        maxComputeInvocationsPerWorkgroup: 1024,
      },
      features: new Set<string>(),
      info: { vendor: 'test', description: '' },
      requestDevice: ({ requiredLimits }: { requiredLimits: Limits }) => {
        requested.push(requiredLimits);
        return Promise.resolve({ limits: requiredLimits, features: new Set<string>() });
      },
    };
    const gpu = { requestAdapter: () => Promise.resolve(adapter) };
    Object.defineProperty(navigator, 'gpu', { value: gpu, configurable: true });
    return requested;
  }

  it.each([
    ['a phone-class adapter (256 MiB)', 256 * MiB, 256 * MiB, 256 * MiB, 256 * MiB],
    ['an adapter between the floor and 1 GiB', 768 * MiB, 512 * MiB, 768 * MiB, 512 * MiB],
    ['an adapter above 1 GiB', 4096 * MiB, 2048 * MiB, 1024 * MiB, 1024 * MiB],
  ])('requests the adapter limit, capped at 1 GiB, for %s', async (_, buf, bind, wantBuf, wantBind) => {
    const requested = installAdapter(buf, bind);
    const bound = await new MLCEngine({ logLevel: 'SILENT' }).getMaxStorageBufferBindingSize();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ maxBufferSize: wantBuf, maxStorageBufferBindingSize: wantBind });
    expect(bound).toBe(wantBind);
  });

  it('still refuses an adapter below the 128 MiB binding floor', async () => {
    installAdapter(256 * MiB, 64 * MiB);
    await expect(new MLCEngine({ logLevel: 'SILENT' }).getMaxStorageBufferBindingSize()).rejects.toThrow(
      /maxStorageBufferBindingSize/,
    );
  });
});

describe('Cache API presence check in the patched loader', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('checks presence by key, so each cached artifact body is read once', async () => {
    const base = 'https://models.test/m/resolve/main/';
    const bodies = new Map([
      [`${base}mlc-chat-config.json`, '{}'],
      ['https://models.test/m.wasm', 'not a wasm module'],
    ]);
    const matched: string[] = [];
    const keyed: string[] = [];
    const cache = {
      match: (req: Request) => {
        matched.push(req.url);
        const body = bodies.get(req.url);
        return Promise.resolve(body === undefined ? undefined : new Response(body));
      },
      keys: (req: Request) => {
        keyed.push(req.url);
        return Promise.resolve(bodies.has(req.url) ? [req] : []);
      },
      add: () => Promise.reject(new Error('unexpected network fetch')),
    };
    vi.stubGlobal('caches', { open: () => Promise.resolve(cache) });
    const engine = new MLCEngine({
      logLevel: 'SILENT',
      appConfig: {
        model_list: [{ model: 'https://models.test/m', model_id: 'm', model_lib: 'https://models.test/m.wasm' }],
      },
    });

    // The runtime cannot start outside a browser, so the load stops right after
    // both artifacts are read from the cache.
    await expect(engine.reload('m')).rejects.toThrow();
    expect(keyed).toEqual([...bodies.keys()]);
    expect(matched).toEqual([...bodies.keys()]);
  });
});
