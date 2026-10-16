// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * GPU recovery: when, and how, the page gets its model back after the browser
 * took the WebGPU device away in the background. Real lifecycle with a fake
 * adapter whose device the test loses; jsdom visibility driven by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../types';
import { _resetLifecycleForTesting, loadModel, setAdapterFactory } from '../../runtime/lifecycle';
import { __resetGpuOwnershipForTests } from '../../runtime/gpu-ownership';
import type { LoadOptions, RuntimeAdapter, TokenEvent } from '../../runtime/types';
import {
  clearGpuReloadGuard,
  clearGpuRetryMarker,
  installGpuRecovery,
  readGpuRetryMarker,
  reloadPageForGpu,
} from '../gpu-recovery';

const MODEL: ModelConfig = {
  id: 'candidate/qwen2.5-0.5b-mlc',
  friendlyName: 'Qwen2.5 0.5B',
  vendor: 'Alibaba',
  sizeGB: 0.4,
  runtime: 'webllm',
  format: 'mlc-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
  bestFor: 't', knownLimitation: 'k', evidenceTier: 'proven',
};

class LosableAdapter implements RuntimeAdapter {
  readonly runtime = 'webllm' as const;
  isLoaded = false;
  backend: 'webgpu' | null = null;
  activeModel: ModelConfig | null = null;
  deviceLost = false;
  private onDeviceLost: (() => void) | undefined;

  async load(model: ModelConfig, options?: LoadOptions): Promise<void> {
    this.isLoaded = true;
    this.backend = 'webgpu';
    this.activeModel = model;
    this.onDeviceLost = options?.onDeviceLost;
  }

  async *generate(): AsyncIterable<TokenEvent> {
    yield { kind: 'done' };
  }

  async unload(): Promise<void> {
    this.isLoaded = false;
  }

  lose(): void {
    this.deviceLost = true;
    this.onDeviceLost?.();
  }
}

let visibility: DocumentVisibilityState = 'visible';
let adapter: LosableAdapter;
let uninstall: (() => void) | null = null;

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function install(overrides: { adapterAvailable?: boolean; busy?: boolean } = {}) {
  const warm = vi.fn(async () => true);
  const reload = vi.fn();
  const probeAdapter = vi.fn(async () => overrides.adapterAvailable ?? true);
  uninstall = installGpuRecovery({
    warm,
    isBusy: () => overrides.busy ?? false,
    probeAdapter,
    reload,
  });
  return { warm, reload, probeAdapter };
}

beforeEach(async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  visibility = 'visible';
  window.sessionStorage.clear();
  window.localStorage.clear();
  _resetLifecycleForTesting();
  __resetGpuOwnershipForTests();
  adapter = new LosableAdapter();
  setAdapterFactory(() => adapter);
  await loadModel(MODEL);
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  _resetLifecycleForTesting();
  __resetGpuOwnershipForTests();
  window.sessionStorage.clear();
});

describe('installGpuRecovery', () => {
  it('waits while the page is hidden, then reloads the model quietly when it is visible again', async () => {
    const { warm, reload, probeAdapter } = install();
    setVisibility('hidden');
    adapter.lose();
    await settle();
    expect(probeAdapter).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();

    setVisibility('visible');
    await settle();

    expect(warm).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('recovers at once when the device is lost while the page is visible', async () => {
    const { warm } = install();
    adapter.lose();
    await settle();
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('reloads the page once when it can no longer get an adapter, and not again in a loop', async () => {
    const { warm, reload } = install({ adapterAvailable: false });
    setVisibility('hidden');
    adapter.lose();
    setVisibility('visible');
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(warm).not.toHaveBeenCalled();

    // The same tab, still without an adapter: the guard refuses a second reload.
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never probes or reloads a page whose device was not lost', async () => {
    const { warm, reload, probeAdapter } = install({ adapterAvailable: false });
    setVisibility('hidden');
    setVisibility('visible');
    window.dispatchEvent(new Event('pageshow'));
    await settle();
    expect(probeAdapter).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves recovery to the send path while a reply is in progress', async () => {
    const { warm, reload, probeAdapter } = install({ adapterAvailable: false, busy: true });
    adapter.lose();
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(probeAdapter).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('reloadPageForGpu', () => {
  it('records the turn to answer and refuses a second reload until a model has answered', () => {
    const reload = vi.fn();
    const retry = { conversationId: 'c1', assistantId: 'a1' };

    expect(reloadPageForGpu({ retry, reload, now: 1_000 })).toBe(true);
    expect(readGpuRetryMarker()).toEqual(retry);
    expect(reloadPageForGpu({ reload, now: 2_000 })).toBe(false);

    clearGpuReloadGuard();
    expect(reloadPageForGpu({ reload, now: 3_000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);

    clearGpuRetryMarker();
    expect(readGpuRetryMarker()).toBeNull();
  });

  it('allows another reload once the guard has expired', () => {
    const reload = vi.fn();
    expect(reloadPageForGpu({ reload, now: 0 })).toBe(true);
    expect(reloadPageForGpu({ reload, now: 10 * 60 * 1000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
