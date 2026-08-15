// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Wave 3 scaffolding — `resolveContextTokens` seam unit tests.
 *
 * The seam MUST be behavior-neutral today: on every device it returns the
 * model's fixed catalog `capabilities.contextTokens`, byte-for-byte what the
 * runtime adapters already use. These tests lock that contract so Wave 3b's
 * per-VRAM bands land as a deliberate, red-test-first change rather than
 * silently drifting the window.
 */

import { describe, expect, it } from 'vitest';
import { getCatalog, getModel } from '../../catalog/catalog';
import { resolveContextTokens } from '../context-window';
import type { DeviceProfile, ModelConfig } from '../../types';

function model(id: string): ModelConfig {
  const m = getModel(id);
  if (!m) throw new Error(`expected catalog model ${id}`);
  return m;
}

const PROFILE_4GB: DeviceProfile = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 4,
  isMobile: false,
  override: 'auto',
  webgpuShaderF16: true,
  webgpuMaxBufferBytes: 750_000_000,
};

const PROFILE_24GB: DeviceProfile = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 24,
  isMobile: false,
  override: 'auto',
  webgpuShaderF16: true,
  webgpuMaxBufferBytes: 4_000_000_000,
};

const PROFILE_WASM_ONLY: DeviceProfile = {
  browserClass: 'firefox',
  webgpuSupport: 'wasm-only',
  deviceMemoryGB: 8,
  isMobile: false,
  override: 'auto',
};

describe('resolveContextTokens — behavior-neutral scaffolding default', () => {
  it('returns the model catalog window on a 4GB WebGPU device', () => {
    const m = model('candidate/lfm2.5-1.2b-instruct-onnx');
    expect(resolveContextTokens(m, PROFILE_4GB)).toBe(m.capabilities.contextTokens);
  });

  it('returns the SAME window on a high-VRAM device (no per-VRAM band yet)', () => {
    const m = model('candidate/lfm2.5-1.2b-instruct-onnx');
    expect(resolveContextTokens(m, PROFILE_24GB)).toBe(resolveContextTokens(m, PROFILE_4GB));
  });

  it('ignores webgpuMaxBufferBytes today (the seam Wave 3b will read)', () => {
    const m = model('candidate/lfm2-2.6b-onnx');
    const bigBuffer: DeviceProfile = { ...PROFILE_4GB, webgpuMaxBufferBytes: 8_000_000_000 };
    const tinyBuffer: DeviceProfile = { ...PROFILE_4GB, webgpuMaxBufferBytes: 128_000_000 };
    const unprobed: DeviceProfile = { ...PROFILE_4GB, webgpuMaxBufferBytes: undefined };
    expect(resolveContextTokens(m, bigBuffer)).toBe(m.capabilities.contextTokens);
    expect(resolveContextTokens(m, tinyBuffer)).toBe(m.capabilities.contextTokens);
    expect(resolveContextTokens(m, unprobed)).toBe(m.capabilities.contextTokens);
  });

  it('returns the catalog window on a WASM-only device too', () => {
    const m = model('candidate/smollm2-360m-instruct-onnx');
    expect(resolveContextTokens(m, PROFILE_WASM_ONLY)).toBe(m.capabilities.contextTokens);
  });

  it('equals the fixed catalog window for every catalog model on every profile band', () => {
    for (const m of getCatalog()) {
      for (const profile of [PROFILE_4GB, PROFILE_24GB, PROFILE_WASM_ONLY]) {
        expect(resolveContextTokens(m, profile)).toBe(m.capabilities.contextTokens);
      }
    }
  });
});
