// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../types';
import {
  _resetLifecycleForTesting,
  loadModel,
  setAdapterFactory,
  unloadActive,
} from '../lifecycle';
import type { RuntimeAdapter, TokenEvent } from '../types';

// ---------------------------------------------------------------------------
// Mocks: jsdom provides neither BroadcastChannel nor navigator.locks. These
// mirror the ones in inference-coordinator.test.ts — a shared registry so
// several coordinators (i.e. "tabs") contend for the same lock name.
// ---------------------------------------------------------------------------

type ChannelHandler = (event: { data: unknown }) => void;

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ChannelHandler | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    for (const inst of MockBroadcastChannel.instances) {
      if (inst !== this && inst.name === this.name && !inst.closed && inst.onmessage) {
        inst.onmessage({ data });
      }
    }
  }

  close(): void {
    this.closed = true;
    const idx = MockBroadcastChannel.instances.indexOf(this);
    if (idx >= 0) MockBroadcastChannel.instances.splice(idx, 1);
  }
}

type LockCallback = (lock: { name: string } | null) => Promise<unknown>;

class MockWebLocks {
  private held = new Set<string>();
  private queue: { name: string; callback: LockCallback; resolve: (v: unknown) => void }[] = [];

  async request(
    name: string,
    optionsOrCallback: Record<string, unknown> | LockCallback,
    maybeCallback?: LockCallback,
  ): Promise<unknown> {
    let options: { ifAvailable?: boolean } = {};
    let callback: LockCallback;
    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
    } else {
      options = optionsOrCallback as { ifAvailable?: boolean };
      callback = maybeCallback!;
    }

    if (options.ifAvailable) {
      if (this.held.has(name)) return callback(null);
      return this.acquire(name, callback);
    }
    if (this.held.has(name)) {
      return new Promise((resolve) => this.queue.push({ name, callback, resolve }));
    }
    return this.acquire(name, callback);
  }

  private async acquire(name: string, callback: LockCallback): Promise<unknown> {
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
      const idx = this.queue.findIndex((q) => q.name === name);
      if (idx >= 0) {
        const next = this.queue.splice(idx, 1)[0]!;
        void this.acquire(name, next.callback).then(next.resolve);
      }
    }
  }
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

let mockLocks: MockWebLocks;

async function loadModule() {
  return import('../gpu-ownership');
}

beforeEach(() => {
  MockBroadcastChannel.instances = [];
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  mockLocks = new MockWebLocks();
  vi.stubGlobal('navigator', { ...globalThis.navigator, locks: mockLocks });
});

afterEach(async () => {
  const mod = await loadModule();
  mod.__resetGpuOwnershipForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('gpu-ownership', () => {
  it('grants ownership when the GPU lock is free', async () => {
    const { acquireGpuOwnership, isGpuOwner } = await loadModule();

    const role = await acquireGpuOwnership();

    expect(role).toBe('owner');
    expect(isGpuOwner()).toBe(true);
  });

  it('blocks when another tab holds the GPU lock, then promotes on release', async () => {
    const { acquireGpuOwnership, isGpuOwner, subscribeGpuAvailable } = await loadModule();

    // Simulate another tab holding "eco-inference-leader" indefinitely.
    let releaseOtherTab: (() => void) | null = null;
    void mockLocks.request(
      'eco-inference-leader',
      async () => new Promise<void>((resolve) => {
        releaseOtherTab = resolve;
      }),
    );
    await tick();

    const role = await acquireGpuOwnership();
    expect(role).toBe('blocked');
    expect(isGpuOwner()).toBe(false);

    const available = vi.fn();
    subscribeGpuAvailable(available);

    // The other tab closes / unloads → its lock releases → we are promoted.
    releaseOtherTab!();
    await tick(30);

    expect(available).toHaveBeenCalledTimes(1);
    expect(isGpuOwner()).toBe(true);
  });

  it('grants ownership immediately when the Web Locks API is unavailable', async () => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks: undefined });
    const { acquireGpuOwnership, isGpuOwner } = await loadModule();

    const role = await acquireGpuOwnership();

    expect(role).toBe('owner');
    expect(isGpuOwner()).toBe(true);
  });

  it('is idempotent for an already-owning tab (model switch never blocks)', async () => {
    const { acquireGpuOwnership } = await loadModule();

    expect(await acquireGpuOwnership()).toBe('owner');
    // A second acquire (e.g. switching models) must not re-elect or block.
    expect(await acquireGpuOwnership()).toBe('owner');
  });

  // ── The crash-prevention contract at the real loadModel boundary ────────

  const MODEL: ModelConfig = {
    id: 'local/qwen3-0.6b',
    friendlyName: 'Qwen3',
    vendor: 'Alibaba',
    sizeGB: 0.57,
    runtime: 'transformers',
    format: 'onnx-q4f16',
    capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
    bestFor: 't',
    knownLimitation: 'k',
    evidenceTier: 'proven',
  };

  class FakeAdapter implements RuntimeAdapter {
    readonly runtime = 'transformers' as const;
    isLoaded = false;
    backend: 'webgpu' | 'wasm' | null = null;
    activeModel: ModelConfig | null = null;
    async load(model: ModelConfig): Promise<void> {
      this.isLoaded = true;
      this.backend = 'webgpu';
      this.activeModel = model;
    }
    async *generate(): AsyncIterable<TokenEvent> {
      yield { kind: 'done' };
    }
    async unload(): Promise<void> {
      this.isLoaded = false;
      this.backend = null;
      this.activeModel = null;
    }
  }

  it('loadModel refuses with gpu-busy-other-tab when another tab owns the GPU', async () => {
    _resetLifecycleForTesting();
    setAdapterFactory(() => new FakeAdapter());

    // Another tab holds the GPU lock.
    void mockLocks.request(
      'eco-inference-leader',
      async () => new Promise<void>(() => {}),
    );
    await tick();

    await expect(loadModel(MODEL)).rejects.toMatchObject({ code: 'gpu-busy-other-tab' });

    setAdapterFactory(null);
  });

  it('loadModel loads when the GPU is free and unloadActive frees it for another tab', async () => {
    _resetLifecycleForTesting();
    setAdapterFactory(() => new FakeAdapter());

    const adapter = await loadModel(MODEL);
    expect(adapter.isLoaded).toBe(true);

    // While this tab owns the GPU, a would-be second tab must not be able to grab it.
    let secondTabGotLock = false;
    void mockLocks.request(
      'eco-inference-leader',
      { ifAvailable: true },
      async (lock) => {
        secondTabGotLock = lock !== null;
      },
    );
    await tick();
    expect(secondTabGotLock).toBe(false);

    // Unloading frees the GPU so the next acquire (another tab) succeeds.
    await unloadActive();
    await tick();
    let secondTabGotLockAfter = false;
    void mockLocks.request(
      'eco-inference-leader',
      { ifAvailable: true },
      async (lock) => {
        secondTabGotLockAfter = lock !== null;
        return new Promise<void>(() => {});
      },
    );
    await tick();
    expect(secondTabGotLockAfter).toBe(true);

    setAdapterFactory(null);
  });

  it('releases ownership so a later acquire re-elects', async () => {
    const { acquireGpuOwnership, releaseGpuOwnership, isGpuOwner } = await loadModule();

    expect(await acquireGpuOwnership()).toBe('owner');
    releaseGpuOwnership();
    expect(isGpuOwner()).toBe(false);

    // The Web Lock frees asynchronously after cleanup resolves the held
    // promise; in real flows a re-acquire is a later user action, never the
    // same microtask. Let the release settle, then re-acquire succeeds.
    await tick();
    expect(await acquireGpuOwnership()).toBe('owner');
  });
});
