// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest';

/**
 * Unit tests for Eco cache cleanup allowlists (INFRA-02 / VAL-QA-007).
 *
 * The SW activate handler filters cache keys so that model weight caches
 * (prefixed with 'transformers-cache' or 'eco-model-') survive SW upgrades.
 * This test exercises the filter predicate in isolation.
 */

const CACHE_NAME = 'eco-v5';

function shouldDeleteCacheOnSwActivate(key: string): boolean {
  return key !== CACHE_NAME && !key.startsWith('transformers-cache') && !key.startsWith('eco-model-');
}

function shouldDeleteCacheOnClientReset(key: string): boolean {
  return /^eco-v\d+$/.test(key) || /^eco-cache(?:-|$)/.test(key) || /^eco-app-cache(?:-|$)/.test(key);
}

describe('SW cache cleanup preserves model weight caches (INFRA-02)', () => {
  it('preserves the current service-worker cache on activate', () => {
    expect(shouldDeleteCacheOnSwActivate(CACHE_NAME)).toBe(false);
  });

  it('preserves model-weight caches on service-worker activate', () => {
    expect(shouldDeleteCacheOnSwActivate('transformers-cache')).toBe(false);
    expect(shouldDeleteCacheOnSwActivate('transformers-cache-v2')).toBe(false);
    expect(shouldDeleteCacheOnSwActivate('transformers-cache-SmolLM3-3B-Instruct')).toBe(false);
    expect(shouldDeleteCacheOnSwActivate('eco-model-smollm3-3b')).toBe(false);
    expect(shouldDeleteCacheOnSwActivate('eco-model-qwen3-0.6b')).toBe(false);
  });

  it('deletes old versioned app caches on activate', () => {
    expect(shouldDeleteCacheOnSwActivate('eco-v0')).toBe(true);
    expect(shouldDeleteCacheOnSwActivate('eco-v2')).toBe(true);
    expect(shouldDeleteCacheOnSwActivate('old-cache')).toBe(true);
  });

  it('clears only Eco app caches during sign-out or account-reset client cleanup', () => {
    expect(shouldDeleteCacheOnClientReset('eco-v5')).toBe(true);
    expect(shouldDeleteCacheOnClientReset('eco-cache-v1')).toBe(true);
    expect(shouldDeleteCacheOnClientReset('eco-app-cache-static')).toBe(true);

    expect(shouldDeleteCacheOnClientReset('eco-model-smollm3-3b')).toBe(false);
    expect(shouldDeleteCacheOnClientReset('transformers-cache')).toBe(false);
    expect(shouldDeleteCacheOnClientReset('workbox-precache')).toBe(false);
    expect(shouldDeleteCacheOnClientReset('third-party-cache')).toBe(false);
  });

  it('deletes unrelated caches only from service-worker activation, not client reset', () => {
    expect(shouldDeleteCacheOnSwActivate('workbox-precache')).toBe(true);
    expect(shouldDeleteCacheOnSwActivate('some-other-cache')).toBe(true);
    expect(shouldDeleteCacheOnClientReset('some-other-cache')).toBe(false);
  });
});
