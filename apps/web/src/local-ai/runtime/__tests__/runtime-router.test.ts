// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { canRunWebLLM, selectRuntime } from '../runtime-router';
import type { DeviceProfile, ModelConfig } from '../../types';

const PROFILES: Record<string, DeviceProfile> = {
  chromiumWebGPU: { browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 16, isMobile: false, override: 'auto' },
  chromiumWasm: { browserClass: 'chromium', webgpuSupport: 'wasm-only', deviceMemoryGB: 8, isMobile: false, override: 'auto' },
  safari: { browserClass: 'safari', webgpuSupport: 'wasm-only', deviceMemoryGB: 16, isMobile: false, override: 'auto' },
  firefox: { browserClass: 'firefox', webgpuSupport: 'wasm-only', deviceMemoryGB: 16, isMobile: false, override: 'auto' },
  mobile: { browserClass: 'safari', webgpuSupport: 'wasm-only', deviceMemoryGB: 4, isMobile: true, override: 'auto' },
};

const TJS_MODEL: ModelConfig = {
  id: 'local/phi3-mini-4k-q4f16',
  friendlyName: 'Phi-3 Mini',
  vendor: 'Microsoft',
  sizeGB: 2.14,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
  bestFor: 't', knownLimitation: 'k', evidenceTier: 'proven',
};

const WEBLLM_MODEL: ModelConfig = {
  ...TJS_MODEL,
  id: 'local/smollm2-1.7b-webllm-q4f16',
  friendlyName: 'SmolLM2',
  runtime: 'webllm',
  format: 'mlc-q4f16',
};

describe('selectRuntime', () => {
  it('honors catalog runtime when device supports it (TJS)', () => {
    const r = selectRuntime(TJS_MODEL, PROFILES.chromiumWebGPU!);
    expect(r.runtime).toBe('transformers');
    expect(r.reason).toBe('catalog-runtime');
  });

  it('honors catalog runtime when device supports it (WebLLM)', () => {
    const r = selectRuntime(WEBLLM_MODEL, PROFILES.chromiumWebGPU!);
    expect(r.runtime).toBe('webllm');
    expect(r.reason).toBe('catalog-runtime');
  });

  it('falls back from WebLLM to TJS on Safari', () => {
    const r = selectRuntime(WEBLLM_MODEL, PROFILES.safari!);
    expect(r.runtime).toBe('transformers');
    expect(r.reason).toBe('webllm-fallback');
  });

  it('falls back from WebLLM to TJS on Firefox', () => {
    const r = selectRuntime(WEBLLM_MODEL, PROFILES.firefox!);
    expect(r.runtime).toBe('transformers');
    expect(r.reason).toBe('webllm-fallback');
  });

  it('falls back from WebLLM to TJS on Chromium WASM-only', () => {
    const r = selectRuntime(WEBLLM_MODEL, PROFILES.chromiumWasm!);
    expect(r.runtime).toBe('transformers');
    expect(r.reason).toBe('webllm-fallback');
  });

  it('falls back from WebLLM to TJS on mobile', () => {
    const r = selectRuntime(WEBLLM_MODEL, PROFILES.mobile!);
    expect(r.runtime).toBe('transformers');
  });

  it('TJS always selects transformers regardless of profile', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(selectRuntime(TJS_MODEL, profile).runtime).toBe('transformers');
    }
  });
});

describe('canRunWebLLM', () => {
  it('true on chromium + webgpu + desktop', () => {
    expect(canRunWebLLM(PROFILES.chromiumWebGPU!)).toBe(true);
  });

  it('false on chromium wasm-only', () => {
    expect(canRunWebLLM(PROFILES.chromiumWasm!)).toBe(false);
  });

  it('false on Safari (even with webgpu)', () => {
    expect(canRunWebLLM({
      ...PROFILES.safari!,
      webgpuSupport: 'webgpu',
    })).toBe(false);
  });

  it('false on mobile', () => {
    expect(canRunWebLLM({
      ...PROFILES.chromiumWebGPU!,
      isMobile: true,
    })).toBe(false);
  });
});
