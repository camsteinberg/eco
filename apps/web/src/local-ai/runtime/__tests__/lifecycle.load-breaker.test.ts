// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * `loadModel` × the load breaker.
 *
 * A tab the OS kills mid-load runs no catch/finally, so the only crash record
 * that survives is one written BEFORE the load: the mark. These tests drive the
 * real lifecycle against the real breaker (jsdom has no Web Locks, so a mark
 * from another tab reads as dead) and read localStorage the way a person
 * inspecting the browser would.
 *
 * Contract pinned here:
 *   - the mark is in storage before `adapter.load` runs, and stays until the
 *     first token of the first generation after that load;
 *   - a model whose last load killed its tab is refused, not loaded, until the
 *     person answers;
 *   - a forced-timeout load keeps its mark until the orphaned load settles;
 *   - only a real token clears the kill record — an aborted or failed first
 *     generation clears the mark and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../types';
import {
  _resetLifecycleForTesting,
  generate,
  loadModel,
  setAdapterFactory,
  unloadActive,
} from '../lifecycle';
import { AdapterError, type ChatMessage, type GenerateOptions, type RuntimeAdapter, type TokenEvent } from '../types';

const MARK_KEY = 'eco-local-ai-load-mark-v1';
const KILLS_KEY = 'eco-local-ai-load-kills-v1';

const MODEL_A: ModelConfig = {
  id: 'local/qwen3-0.6b',
  friendlyName: 'Qwen3',
  vendor: 'Alibaba',
  sizeGB: 0.57,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
  bestFor: 't', knownLimitation: 'k', evidenceTier: 'proven',
};

const MODEL_B: ModelConfig = { ...MODEL_A, id: 'candidate/lfm2.5-1.2b-instruct-onnx', friendlyName: 'LFM2.5 1.2B' };

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

type Mark = { tabId: string; loadId: string; modelId: string; startedAt: number };

function readMarks(): Mark[] {
  const raw = localStorage.getItem(MARK_KEY);
  return raw ? Object.values(JSON.parse(raw) as Record<string, Mark>) : [];
}

function readKills(): Record<string, { kills: number; decision: string; reason: string }> {
  const raw = localStorage.getItem(KILLS_KEY);
  return raw ? (JSON.parse(raw) as Record<string, { kills: number; decision: string; reason: string }>) : {};
}

function seedDeadMark(modelId: string): void {
  const dead: Mark = { tabId: 'dead-tab', loadId: 'dead-load', modelId, startedAt: 1 };
  localStorage.setItem(MARK_KEY, JSON.stringify({ [dead.loadId]: dead }));
}

function seedKillRecord(modelId: string, decision: 'retry' | 'ask'): void {
  localStorage.setItem(KILLS_KEY, JSON.stringify({
    [modelId]: {
      modelId, kills: 1, lastLoadId: 'old-load', lastKilledAt: 1, reason: 'no-lock', decision,
    },
  }));
}

class FakeAdapter implements RuntimeAdapter {
  readonly runtime = 'transformers' as const;
  isLoaded = false;
  backend: 'webgpu' | 'wasm' | null = null;
  activeModel: ModelConfig | null = null;
  loadCalls = 0;
  /** Runs inside load() — lets a test read storage at that instant. */
  onLoad: (() => void) | null = null;
  /** When set, load() waits on this instead of resolving at once. */
  loadGate: Promise<void> | null = null;
  failOnLoad: AdapterError | null = null;
  events: TokenEvent[] = [{ kind: 'token', text: 'OK' }, { kind: 'done' }];

  async load(model: ModelConfig): Promise<void> {
    this.loadCalls++;
    this.onLoad?.();
    if (this.loadGate) await this.loadGate;
    if (this.failOnLoad) throw this.failOnLoad;
    this.isLoaded = true;
    this.activeModel = model;
  }

  async unload(): Promise<void> {
    this.isLoaded = false;
    this.activeModel = null;
  }

  async *generate(_messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<TokenEvent> {
    for (const event of this.events) {
      if (options?.signal?.aborted) return;
      yield event;
    }
  }
}

async function drain(source: AsyncIterable<TokenEvent>): Promise<void> {
  for await (const _event of source) {
    // consume
  }
}

let adapter: FakeAdapter;

beforeEach(() => {
  _resetLifecycleForTesting();
  localStorage.clear();
  adapter = new FakeAdapter();
  setAdapterFactory(() => adapter);
});

afterEach(async () => {
  await unloadActive();
  _resetLifecycleForTesting();
  localStorage.clear();
});

describe('loadModel writes a load mark', () => {
  it('is in storage before adapter.load runs and stays until the first token', async () => {
    let seenDuringLoad: Mark[] = [];
    adapter.onLoad = () => {
      seenDuringLoad = readMarks();
    };

    await loadModel(MODEL_A);
    expect(seenDuringLoad).toEqual([expect.objectContaining({ modelId: MODEL_A.id })]);
    // Loaded but nothing generated yet: memory can still peak on the first run.
    expect(readMarks()).toHaveLength(1);

    const iterator = generate(MESSAGES)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ kind: 'token', text: 'OK' });
    expect(readMarks()).toEqual([]);
    await iterator.return?.(undefined);
  });

  it('a rejected load clears its mark and records no kill', async () => {
    adapter.failOnLoad = new AdapterError('nope', 'init-failed', false);
    await expect(loadModel(MODEL_A)).rejects.toMatchObject({ code: 'init-failed' });
    await Promise.resolve();
    expect(readMarks()).toEqual([]);
    expect(readKills()).toEqual({});
  });

  it('unloading before any generation clears the mark', async () => {
    await loadModel(MODEL_A);
    await unloadActive();
    expect(readMarks()).toEqual([]);
  });

  it('a forced-timeout load keeps its mark until the orphaned load settles', async () => {
    let finishLoad!: () => void;
    adapter.loadGate = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    const controller = new AbortController();
    const pending = loadModel(MODEL_A, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });

    // We stopped waiting; the load did not stop. It can still kill the tab.
    expect(readMarks()).toEqual([expect.objectContaining({ modelId: MODEL_A.id })]);

    finishLoad();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readMarks()).toEqual([]);
  });
});

describe('loadModel refuses a model whose load killed a tab', () => {
  it('refuses the killed model without loading it, and records what it saw', async () => {
    seedDeadMark(MODEL_A.id);

    await expect(loadModel(MODEL_A)).rejects.toMatchObject({ code: 'load-interrupted' });
    expect(adapter.loadCalls).toBe(0);
    expect(readKills()[MODEL_A.id]).toMatchObject({ kills: 1, decision: 'ask', reason: 'locks-unavailable' });
    expect(readMarks()).toEqual([]);
  });

  it('still loads a different model', async () => {
    seedDeadMark(MODEL_A.id);
    await expect(loadModel(MODEL_B)).resolves.toBe(adapter);
  });

  it('loads the killed model once the person chose to try again', async () => {
    seedKillRecord(MODEL_A.id, 'retry');
    await expect(loadModel(MODEL_A)).resolves.toBe(adapter);
  });
});

describe('only a real token clears the kill record', () => {
  it('the first token after the load clears it', async () => {
    seedKillRecord(MODEL_A.id, 'retry');
    await loadModel(MODEL_A);
    await drain(generate(MESSAGES));
    expect(readKills()).toEqual({});
  });

  it('a generation that errors before its first token clears the mark but keeps the record', async () => {
    seedKillRecord(MODEL_A.id, 'retry');
    adapter.events = [{ kind: 'error', code: 'generation-failed', reason: 'boom' }];
    await loadModel(MODEL_A);
    await drain(generate(MESSAGES));
    expect(readMarks()).toEqual([]);
    expect(readKills()[MODEL_A.id]).toMatchObject({ kills: 1 });
  });

  it('a generation aborted before its first token clears the mark but keeps the record', async () => {
    seedKillRecord(MODEL_A.id, 'retry');
    await loadModel(MODEL_A);
    const controller = new AbortController();
    controller.abort();
    await drain(generate(MESSAGES, { signal: controller.signal }));
    expect(readMarks()).toEqual([]);
    expect(readKills()[MODEL_A.id]).toMatchObject({ kills: 1 });
  });
});
