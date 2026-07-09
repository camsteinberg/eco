// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRwkvCacheKey, getRwkvCacheName, isRwkvCached, loadRwkvWeights } from '../rwkv-loader';

describe('getRwkvCacheKey', () => {
  it('generates correct URL for model ID', () => {
    expect(getRwkvCacheKey('local/rwkv7-1.5b')).toBe(
      'https://eco-model.cache/eco-model-local-rwkv7-1.5b/weights.st',
    );
  });

  it('replaces slashes with dashes', () => {
    expect(getRwkvCacheKey('org/model/variant')).toBe(
      'https://eco-model.cache/eco-model-org-model-variant/weights.st',
    );
  });
});

describe('getRwkvCacheName', () => {
  it('generates correct cache name', () => {
    expect(getRwkvCacheName('local/rwkv7-1.5b')).toBe('eco-model-local-rwkv7-1.5b');
  });

  it('replaces slashes with dashes', () => {
    expect(getRwkvCacheName('local/rwkv7-2.9b')).toBe('eco-model-local-rwkv7-2.9b');
  });
});

describe('isRwkvCached', () => {
  let mockCaches: {
    open: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockCaches = {
      open: vi.fn(),
    };
    vi.stubGlobal('caches', mockCaches);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    expect(await isRwkvCached('local/rwkv7-1.5b')).toBe(false);
  });

  it('returns true when cache has matching response', async () => {
    const mockCache = {
      match: vi.fn().mockResolvedValue(new Response('data')),
    };
    mockCaches.open.mockResolvedValue(mockCache);

    expect(await isRwkvCached('local/rwkv7-1.5b')).toBe(true);
    expect(mockCache.match).toHaveBeenCalledWith(
      'https://eco-model.cache/eco-model-local-rwkv7-1.5b/weights.st',
    );
  });

  it('returns false when cache has no match', async () => {
    const mockCache = {
      match: vi.fn().mockResolvedValue(undefined),
    };
    mockCaches.open.mockResolvedValue(mockCache);

    expect(await isRwkvCached('local/rwkv7-1.5b')).toBe(false);
  });
});

describe('loadRwkvWeights', () => {
  let mockCaches: {
    open: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockCaches = {
      open: vi.fn(),
    };
    vi.stubGlobal('caches', mockCaches);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when not cached', async () => {
    const mockCache = {
      match: vi.fn().mockResolvedValue(undefined),
    };
    mockCaches.open.mockResolvedValue(mockCache);

    await expect(loadRwkvWeights('local/rwkv7-1.5b')).rejects.toThrow(
      'not found in cache',
    );
  });

  it('throws when cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    await expect(loadRwkvWeights('local/rwkv7-1.5b')).rejects.toThrow(
      'Cache API unavailable',
    );
  });
});
