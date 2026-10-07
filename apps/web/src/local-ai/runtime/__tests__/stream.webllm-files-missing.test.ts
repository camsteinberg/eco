// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A 'ready' `webllm` slot whose files are gone from WebLLM's cache.
 *
 * The engine cannot fetch them back: the keys the bridge stages point at a
 * same-origin route that is never served (`webllmModelBaseUrl`), so web-llm's
 * add-on-miss rejects with the browser's Cache.add error, or throws its own
 * `"Cannot fetch " + url` (lib/index.js, `ArtifactCache.fetchWithCache`).
 * Every send fails the same way until something re-stages the files. Boot
 * reconcile does that on the next landing; within the session, a load failure
 * that the presence probe proves is missing files must move the slot off
 * 'ready', so the readiness surface drives the setup pipeline (which re-stages
 * them) instead of showing a ready model that never answers.
 *
 * Real path: stream() → runtime lifecycle → WebLLMAdapter → a fake engine;
 * real slots over jsdom localStorage; the real presence probe over an
 * in-memory Cache API. Only bootstrap is stubbed (it would wire real workers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../bootstrap', () => ({ bootstrapLocalAi: vi.fn(async () => undefined) }));

import { stream } from '../stream';
import { _resetLifecycleForTesting, setAdapterFactory } from '../lifecycle';
import { __resetGpuOwnershipForTests } from '../gpu-ownership';
import { WebLLMAdapter, type WebLLMEngine } from '../webllm-adapter';
import { stripMlcOrgPrefix, webllmCacheTargetFor, webllmModelBaseUrl } from '../webllm-config';
import { LocalInferenceStreamError } from '../errors';
import { getModel } from '../../catalog/catalog';
import { getSlot, setSlot, setSlotStatus } from '../../lifecycle/slots';
import type { CacheStorageLike } from '../../download/storage';

// The shipping iPhone model — a real catalog entry, so the slot store resolves it.
const MODEL = getModel('candidate/qwen2.5-0.5b-mlc')!;
const FILES = MODEL.artifact!.files;
const BASE = webllmModelBaseUrl(stripMlcOrgPrefix(MODEL.artifact!.hfId), window.location.origin);
const SHARD_URL = webllmCacheTargetFor('params_shard_3.bin', BASE).key;

/** Key-only Cache API: presence is all this path asks. */
function makeCaches(present: ReadonlySet<string>): CacheStorageLike {
  return {
    open: async () => ({
      keys: async (req?: RequestInfo | URL) => {
        const url = req === undefined ? null : new Request(req).url;
        return url !== null && present.has(url) ? [new Request(url)] : [];
      },
      match: async () => undefined,
      put: async () => undefined,
      delete: async () => false,
    }),
    has: async () => true,
    keys: async () => ['webllm/model', 'webllm/config'],
    delete: async () => false,
  } as unknown as CacheStorageLike;
}

function allFileKeys(): Set<string> {
  return new Set(FILES.map((file) => webllmCacheTargetFor(file, BASE).key));
}

function engineThatFailsReload(error: unknown): WebLLMEngine {
  return {
    reload: async () => {
      throw error;
    },
    chat: { completions: { create: async () => { throw new Error('unreachable'); } } },
    interruptGenerate: () => undefined,
    resetChat: async () => undefined,
    unload: async () => undefined,
  };
}

async function sendOnce(): Promise<unknown> {
  try {
    for await (const event of stream([{ role: 'user', content: 'hello' }], MODEL.id)) {
      void event;
    }
    return null;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  window.localStorage.clear();
  _resetLifecycleForTesting();
  __resetGpuOwnershipForTests();
  setSlot('eco-fast', MODEL);
  setSlotStatus('eco-fast', 'ready');
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetLifecycleForTesting();
  __resetGpuOwnershipForTests();
  window.localStorage.clear();
});

describe('stream — a webllm load that fails on missing files', () => {
  // What the engine throws: its own text when add() resolved but the entry
  // still is not there, or the browser's TypeError from Cache.add on the
  // unserved route (wording varies by browser).
  it.each([
    ['web-llm "Cannot fetch"', new Error(`Cannot fetch ${SHARD_URL}`)],
    ['a browser fetch TypeError', new TypeError('Load failed')],
  ])('moves the slot off ready when a weight file is gone (%s)', async (_label, engineError) => {
    const present = allFileKeys();
    present.delete(SHARD_URL);
    vi.stubGlobal('caches', makeCaches(present));
    setAdapterFactory(() => new WebLLMAdapter({ engineFactory: async () => engineThatFailsReload(engineError) }));

    const err = await sendOnce();

    expect(err).toBeInstanceOf(LocalInferenceStreamError);
    expect(getSlot('eco-fast').status).toBe('preparing');
  });

  it('leaves the slot ready when every file is present (the failure is not missing files)', async () => {
    vi.stubGlobal('caches', makeCaches(allFileKeys()));
    setAdapterFactory(() => new WebLLMAdapter({ engineFactory: async () => engineThatFailsReload(new Error('shader compile failed')) }));

    expect(await sendOnce()).toBeInstanceOf(LocalInferenceStreamError);
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('leaves the slot ready when presence cannot be checked', async () => {
    vi.stubGlobal('caches', {
      open: async () => {
        throw new Error('cache storage unavailable');
      },
    });
    setAdapterFactory(() => new WebLLMAdapter({ engineFactory: async () => engineThatFailsReload(new TypeError('Load failed')) }));

    expect(await sendOnce()).toBeInstanceOf(LocalInferenceStreamError);
    expect(getSlot('eco-fast').status).toBe('ready');
  });
});
