// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { selectRuntime } from '../runtime-router';
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

const LITERT_MODEL: ModelConfig = {
  ...TJS_MODEL,
  id: 'candidate/gemma-4-e2b-litert',
  friendlyName: 'Gemma 4',
  runtime: 'litert',
  format: 'litertlm',
};

const WEBLLM_MODEL: ModelConfig = {
  ...TJS_MODEL,
  id: 'candidate/qwen2.5-1.5b-webllm',
  friendlyName: 'Qwen2.5 1.5B',
  runtime: 'webllm',
  format: 'mlc-q4f16',
};

describe('selectRuntime', () => {
  it('honors the transformers catalog runtime regardless of profile', () => {
    for (const profile of Object.values(PROFILES)) {
      const r = selectRuntime(TJS_MODEL, profile);
      expect(r.runtime).toBe('transformers');
      expect(r.reason).toBe('catalog-runtime');
    }
  });

  it('honors the litert catalog runtime regardless of profile', () => {
    for (const profile of Object.values(PROFILES)) {
      const r = selectRuntime(LITERT_MODEL, profile);
      expect(r.runtime).toBe('litert');
      expect(r.reason).toBe('catalog-runtime');
    }
  });

  it('honors the webllm catalog runtime regardless of profile', () => {
    for (const profile of Object.values(PROFILES)) {
      const r = selectRuntime(WEBLLM_MODEL, profile);
      expect(r.runtime).toBe('webllm');
      expect(r.reason).toBe('catalog-runtime');
    }
  });
});
