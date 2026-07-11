// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase F — predicted-fit unit tests.
 *
 * Covers:
 *   - predictMetrics produces conservative-but-non-zero metrics for every
 *     (model × profile) pair.
 *   - getMetrics returns seed values when seed evidence covers a pair, and
 *     predicted values otherwise.
 *   - The universal-coverage guarantee — every non-below-floor profile gets
 *     SOMETHING from the recommender. (Originally exercised via the dead
 *     getPredictedFit helper; now exercises the live `recommend()` entry
 *     point that recommend.ts owns. Same property, real call path.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCatalog, getModel } from '../../catalog/catalog';
import {
  getMetrics,
  modelMatchesSlot,
  predictMetrics,
} from '../predicted-fit';
import { recommend, NoAssignableModelError } from '../recommend';
import type { DeviceProfile } from '../../types';

const PROFILE_FIREFOX_16GB: DeviceProfile = {
  browserClass: 'firefox',
  webgpuSupport: 'wasm-only',
  deviceMemoryGB: 16,
  isMobile: false,
  override: 'auto',
};

const PROFILE_MOBILE: DeviceProfile = {
  browserClass: 'safari',
  webgpuSupport: 'wasm-only',
  deviceMemoryGB: 4,
  isMobile: true,
  override: 'auto',
};

const PROFILE_CHROMIUM_24GB: DeviceProfile = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 24,
  isMobile: false,
  override: 'auto',
};

describe('predictMetrics', () => {
  it('returns finite positive numbers for every catalog model on Firefox WASM 16 GB', () => {
    for (const model of getCatalog()) {
      const metrics = predictMetrics(model, PROFILE_FIREFOX_16GB);
      expect(metrics.firstTokenMs).toBeGreaterThan(0);
      expect(metrics.firstTokenMs).toBeLessThan(20_000);
      expect(metrics.tokensPerSec).toBeGreaterThan(0);
      expect(metrics.smokePassRate).toBeGreaterThanOrEqual(0);
      expect(metrics.smokePassRate).toBeLessThanOrEqual(1);
    }
  });

  it('predicts WebGPU significantly faster than WASM for the same model', () => {
    const webgpuMetrics = predictMetrics(getModel('local/qwen3-0.6b')!, PROFILE_CHROMIUM_24GB);
    const wasmMetrics = predictMetrics(getModel('local/qwen3-0.6b')!, PROFILE_FIREFOX_16GB);
    expect(webgpuMetrics.firstTokenMs).toBeLessThan(wasmMetrics.firstTokenMs);
    expect(webgpuMetrics.tokensPerSec).toBeGreaterThan(wasmMetrics.tokensPerSec);
  });

  it('predicts higher smokePassRate for proven evidenceTier than predicted', () => {
    const proven = predictMetrics(getModel('local/phi3-mini-4k-q4f16')!, PROFILE_CHROMIUM_24GB);
    const predicted = predictMetrics(getModel('candidate/lfm2.5-350m-onnx')!, PROFILE_CHROMIUM_24GB);
    expect(proven.smokePassRate).toBeGreaterThan(predicted.smokePassRate);
  });

  it('applies a mobile penalty to smokePassRate', () => {
    const desktop = predictMetrics(getModel('candidate/lfm2.5-350m-onnx')!, PROFILE_FIREFOX_16GB);
    const mobile = predictMetrics(getModel('candidate/lfm2.5-350m-onnx')!, PROFILE_MOBILE);
    expect(mobile.smokePassRate).toBeLessThan(desktop.smokePassRate);
  });
});

describe('getMetrics — seed first, predicted fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns seed values for a (model × profile) with seed proof', () => {
    // phi3's seed row is dated 2026-05-13; pin the clock to the snapshot's
    // generation date so the row stays inside its 45-day freshness TTL. Without
    // this, the assertion silently rots once the row ages out of the window and
    // getMetrics correctly falls back to predicted values — a wall-clock
    // dependency masquerading as a logic test.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const seedMetrics = getMetrics(getModel('local/phi3-mini-4k-q4f16')!, PROFILE_CHROMIUM_24GB);
    // Seed evidence for phi3 has firstTokenMs around 228 ms; predicted would
    // be in the 1000+ ms range.
    expect(seedMetrics.firstTokenMs).toBeLessThan(500);
  });

  it('returns predicted values for a (model × profile) without seed proof', () => {
    const predictedMetrics = getMetrics(getModel('candidate/lfm2.5-350m-onnx')!, PROFILE_FIREFOX_16GB);
    expect(predictedMetrics.firstTokenMs).toBeGreaterThan(500); // predicted ranges are higher
    expect(predictedMetrics.tokensPerSec).toBeGreaterThan(0);
  });
});

describe('modelMatchesSlot', () => {
  it('eco-fast prefers snappy/balanced intents', () => {
    expect(modelMatchesSlot(getModel('local/qwen3-0.6b')!, 'eco-fast')).toBe(true);
    expect(modelMatchesSlot(getModel('candidate/lfm2.5-350m-onnx')!, 'eco-fast')).toBe(true);
    expect(modelMatchesSlot(getModel('candidate/lfm2.5-1.2b-instruct-onnx')!, 'eco-fast')).toBe(true);
  });

  it('eco-smart prefers balanced/quality intents', () => {
    expect(modelMatchesSlot(getModel('local/phi3-mini-4k-q4f16')!, 'eco-smart')).toBe(true);
    expect(modelMatchesSlot(getModel('candidate/qwen3.5-2b-onnx')!, 'eco-smart')).toBe(true);
    expect(modelMatchesSlot(getModel('local/qwen3-0.6b')!, 'eco-smart')).toBe(true);
    expect(modelMatchesSlot(getModel('candidate/gemma-4-e2b-litert')!, 'eco-smart')).toBe(true);
  });

  it('lfm2.5 (snappy-only) does not match eco-smart slot', () => {
    expect(modelMatchesSlot(getModel('candidate/lfm2.5-350m-onnx')!, 'eco-smart')).toBe(false);
  });
});

describe('recommend() — universal coverage for non-below-floor profiles', () => {
  it('returns a model for Firefox WASM 16 GB eco-fast', () => {
    expect(recommend('eco-fast', PROFILE_FIREFOX_16GB)).not.toBeNull();
  });

  it('returns a model for Firefox WASM 16 GB eco-smart', () => {
    expect(recommend('eco-smart', PROFILE_FIREFOX_16GB)).not.toBeNull();
  });

  it('returns a model for mobile Safari WASM 4 GB eco-fast', () => {
    expect(recommend('eco-fast', PROFILE_MOBILE)).not.toBeNull();
  });

  it('throws NoAssignableModelError for a below-floor profile', () => {
    const belowFloor: DeviceProfile = {
      browserClass: 'unknown',
      webgpuSupport: 'none',
      deviceMemoryGB: 2,
      isMobile: false,
      override: 'auto',
    };
    expect(() => recommend('eco-fast', belowFloor)).toThrow(NoAssignableModelError);
    expect(() => recommend('eco-smart', belowFloor)).toThrow(NoAssignableModelError);
  });
});
