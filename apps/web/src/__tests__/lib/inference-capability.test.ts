// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getInferenceCapability } from '../../lib/inference-capability';

describe('getInferenceCapability', () => {
  const originalNavigator = globalThis.navigator;
  const originalWebAssembly = globalThis.WebAssembly;

  beforeEach(() => {
    // Reset navigator.gpu before each test
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Restore original navigator and WebAssembly
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'WebAssembly', {
      value: originalWebAssembly,
      writable: true,
      configurable: true,
    });
    window.history.replaceState({}, '', '/');
  });

  it('respects an explicit validation override in the URL query string', async () => {
    window.history.replaceState({}, '', '/?eco-force-capability=unsupported');

    const result = await getInferenceCapability();
    expect(result).toBe('unsupported');
  });

  it('treats the webgpu validation override as authoritative even without a real adapter', async () => {
    window.history.replaceState({}, '', '/?eco-force-capability=webgpu');

    const nav = { ...globalThis.navigator };
    delete (nav as Record<string, unknown>).gpu;
    Object.defineProperty(globalThis, 'navigator', {
      value: nav,
      writable: true,
      configurable: true,
    });

    const result = await getInferenceCapability();
    expect(result).toBe('webgpu');
  });

  it('returns "webgpu" when requestAdapter() resolves to non-null', async () => {
    const mockAdapter = { features: new Set(), limits: {} };
    Object.defineProperty(globalThis.navigator, 'gpu', {
      value: {
        requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
      },
      writable: true,
      configurable: true,
    });

    const result = await getInferenceCapability();
    expect(result).toBe('webgpu');
  });

  it('returns "wasm" when navigator.gpu is undefined', async () => {
    // Ensure navigator.gpu does not exist
    const nav = { ...globalThis.navigator };
    delete (nav as Record<string, unknown>).gpu;
    Object.defineProperty(globalThis, 'navigator', {
      value: nav,
      writable: true,
      configurable: true,
    });

    const result = await getInferenceCapability();
    expect(result).toBe('wasm');
  });

  it('returns "unsupported" when both navigator.gpu and WebAssembly are undefined', async () => {
    // Remove navigator.gpu
    const nav = { ...globalThis.navigator };
    delete (nav as Record<string, unknown>).gpu;
    Object.defineProperty(globalThis, 'navigator', {
      value: nav,
      writable: true,
      configurable: true,
    });

    // Remove WebAssembly
    Object.defineProperty(globalThis, 'WebAssembly', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const result = await getInferenceCapability();
    expect(result).toBe('unsupported');
  });

  it('returns "wasm" on requestAdapter() error (fallback)', async () => {
    Object.defineProperty(globalThis.navigator, 'gpu', {
      value: {
        requestAdapter: vi.fn().mockRejectedValue(new Error('GPU error')),
      },
      writable: true,
      configurable: true,
    });

    const result = await getInferenceCapability();
    expect(result).toBe('wasm');
  });

  it('returns "wasm" when requestAdapter() resolves to null', async () => {
    Object.defineProperty(globalThis.navigator, 'gpu', {
      value: {
        requestAdapter: vi.fn().mockResolvedValue(null),
      },
      writable: true,
      configurable: true,
    });

    const result = await getInferenceCapability();
    expect(result).toBe('wasm');
  });
});
