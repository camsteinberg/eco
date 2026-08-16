// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from 'vitest';

import { runLocalRuntimeSelfHeal } from '../local-runtime-self-heal';

const IN_PROGRESS_PREFIX = 'eco-model-download-in-progress:';
const HEAVY_WORK_LEASE_KEY = 'eco-local-heavy-work-owner-v1';

describe('runLocalRuntimeSelfHeal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('removes an in-progress download marker older than 5 minutes', () => {
    const now = 10_000_000;
    const sevenMinutesAgo = now - 7 * 60 * 1000;
    const key = `${IN_PROGRESS_PREFIX}local/qwen3-0.6b`;
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: 1,
        modelId: 'local/qwen3-0.6b',
        artifactSignature: 'sig',
        startedAt: sevenMinutesAgo,
      }),
    );

    runLocalRuntimeSelfHeal(now);

    expect(localStorage.getItem(key)).toBeNull();
  });

  it('keeps a fresh in-progress marker untouched', () => {
    const now = 10_000_000;
    const oneMinuteAgo = now - 60 * 1000;
    const key = `${IN_PROGRESS_PREFIX}local/qwen3-0.6b`;
    const value = JSON.stringify({
      schemaVersion: 1,
      modelId: 'local/qwen3-0.6b',
      artifactSignature: 'sig',
      startedAt: oneMinuteAgo,
    });
    localStorage.setItem(key, value);

    runLocalRuntimeSelfHeal(now);

    expect(localStorage.getItem(key)).toBe(value);
  });

  it('treats a corrupted in-progress marker as stale and removes it', () => {
    const now = 10_000_000;
    const key = `${IN_PROGRESS_PREFIX}local/qwen3-0.6b`;
    localStorage.setItem(key, '{ not json }');

    runLocalRuntimeSelfHeal(now);

    expect(localStorage.getItem(key)).toBeNull();
  });

  it('treats a marker missing startedAt as stale', () => {
    const now = 10_000_000;
    const key = `${IN_PROGRESS_PREFIX}local/qwen3-0.6b`;
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, modelId: 'x' }));

    runLocalRuntimeSelfHeal(now);

    expect(localStorage.getItem(key)).toBeNull();
  });

  it('only touches keys with the in-progress prefix', () => {
    const now = 10_000_000;
    localStorage.setItem('eco-onboarding', 'true');
    localStorage.setItem('eco-model-downloaded-local/qwen3', '{"ok": true}');
    localStorage.setItem(
      `${IN_PROGRESS_PREFIX}local/qwen3-0.6b`,
      JSON.stringify({ startedAt: now - 10 * 60 * 1000 }),
    );

    runLocalRuntimeSelfHeal(now);

    expect(localStorage.getItem('eco-onboarding')).toBe('true');
    expect(localStorage.getItem('eco-model-downloaded-local/qwen3')).toBe('{"ok": true}');
    expect(localStorage.getItem(`${IN_PROGRESS_PREFIX}local/qwen3-0.6b`)).toBeNull();
  });

  it('is idempotent — running twice leaves the same state', () => {
    const now = 10_000_000;
    localStorage.setItem(
      `${IN_PROGRESS_PREFIX}local/stale`,
      JSON.stringify({ startedAt: now - 10 * 60 * 1000 }),
    );
    localStorage.setItem(
      `${IN_PROGRESS_PREFIX}local/fresh`,
      JSON.stringify({ startedAt: now - 60 * 1000 }),
    );

    runLocalRuntimeSelfHeal(now);
    runLocalRuntimeSelfHeal(now);

    expect(localStorage.getItem(`${IN_PROGRESS_PREFIX}local/stale`)).toBeNull();
    expect(localStorage.getItem(`${IN_PROGRESS_PREFIX}local/fresh`)).not.toBeNull();
  });

  it('clears an expired heavy-work lease as a side effect of reading it', () => {
    const expiredLease = {
      ownerId: 'download:abc',
      kind: 'download' as const,
      startedAt: 1,
      expiresAt: 2,
    };
    localStorage.setItem(HEAVY_WORK_LEASE_KEY, JSON.stringify(expiredLease));

    runLocalRuntimeSelfHeal(10_000_000);

    expect(localStorage.getItem(HEAVY_WORK_LEASE_KEY)).toBeNull();
  });

  it('keeps an unexpired heavy-work lease intact', () => {
    const futureLease = {
      ownerId: 'download:abc',
      kind: 'download' as const,
      startedAt: 1,
      expiresAt: Date.now() + 90_000,
    };
    localStorage.setItem(HEAVY_WORK_LEASE_KEY, JSON.stringify(futureLease));

    runLocalRuntimeSelfHeal(Date.now());

    expect(localStorage.getItem(HEAVY_WORK_LEASE_KEY)).not.toBeNull();
  });

  it('does not throw when localStorage holds completely unrelated data', () => {
    localStorage.setItem('something-else', 'whatever');
    localStorage.setItem('eco-theme', 'dark');

    expect(() => runLocalRuntimeSelfHeal(10_000_000)).not.toThrow();
    expect(localStorage.getItem('something-else')).toBe('whatever');
    expect(localStorage.getItem('eco-theme')).toBe('dark');
  });
});
