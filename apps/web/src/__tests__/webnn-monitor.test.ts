// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('webnn-monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up navigator.ml
    Object.defineProperty(navigator, 'ml', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  describe('getWebNNStatus()', () => {
    it('returns available=true when navigator.ml exists', async () => {
      const mockContext = { deviceType: 'npu' };
      Object.defineProperty(navigator, 'ml', {
        value: { createContext: vi.fn().mockResolvedValue(mockContext) },
        configurable: true,
        writable: true,
      });

      const { getWebNNStatus } = await import('../lib/webnn-monitor');
      const status = await getWebNNStatus();

      expect(status.available).toBe(true);
      expect(status.deviceType).toBe('npu');
    });

    it('returns available=false when navigator.ml is undefined', async () => {
      Object.defineProperty(navigator, 'ml', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      const { getWebNNStatus } = await import('../lib/webnn-monitor');
      const status = await getWebNNStatus();

      expect(status.available).toBe(false);
      expect(status.deviceType).toBeNull();
    });

    it('returns device type "gpu" when NPU is not available', async () => {
      const mockContext = { deviceType: 'gpu' };
      Object.defineProperty(navigator, 'ml', {
        value: { createContext: vi.fn().mockResolvedValue(mockContext) },
        configurable: true,
        writable: true,
      });

      const { getWebNNStatus } = await import('../lib/webnn-monitor');
      const status = await getWebNNStatus();

      expect(status.available).toBe(true);
      expect(status.deviceType).toBe('gpu');
    });

    it('returns device type "cpu" as fallback', async () => {
      const mockContext = { deviceType: 'cpu' };
      Object.defineProperty(navigator, 'ml', {
        value: { createContext: vi.fn().mockResolvedValue(mockContext) },
        configurable: true,
        writable: true,
      });

      const { getWebNNStatus } = await import('../lib/webnn-monitor');
      const status = await getWebNNStatus();

      expect(status.available).toBe(true);
      expect(status.deviceType).toBe('cpu');
    });

    it('returns available=false when createContext fails', async () => {
      Object.defineProperty(navigator, 'ml', {
        value: { createContext: vi.fn().mockRejectedValue(new Error('Not supported')) },
        configurable: true,
        writable: true,
      });

      const { getWebNNStatus } = await import('../lib/webnn-monitor');
      const status = await getWebNNStatus();

      expect(status.available).toBe(false);
      expect(status.deviceType).toBeNull();
    });
  });

  describe('checkWebNNOnce()', () => {
    it('caches the result after the first call', async () => {
      const createContext = vi.fn().mockResolvedValue({ deviceType: 'npu' });
      Object.defineProperty(navigator, 'ml', {
        value: { createContext },
        configurable: true,
        writable: true,
      });

      const { checkWebNNOnce } = await import('../lib/webnn-monitor');

      const first = await checkWebNNOnce();
      const second = await checkWebNNOnce();

      expect(first).toEqual(second);
      expect(first.available).toBe(true);
      // createContext should only be called once (cached)
      expect(createContext).toHaveBeenCalledTimes(1);
    });
  });
});
