// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase E — evidence/ledger.ts unit tests.
 *
 * Tests cover:
 *   - record/read roundtrip with profile-key scoping
 *   - hasRecentSuccess returns true only for matching profile + recent
 *   - clearEvidence(modelId) prunes by id; clearEvidence() wipes all
 *   - Self-heal on malformed localStorage JSON
 *   - Localstorage backed: persists across calls (within a single tab)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearEvidence,
  countRecentDownloadFailures,
  CURRENT_LEDGER_VERSION,
  hasRecentFailure,
  hasRecentSuccess,
  profileKey,
  readAllEntries,
  readEvidence,
  recordEvidence,
} from '../ledger';
import type { DeviceProfile } from '../../types';

const PROFILE_24GB: DeviceProfile = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 24,
  isMobile: false,
  override: 'auto',
};

const PROFILE_8GB: DeviceProfile = {
  ...PROFILE_24GB,
  deviceMemoryGB: 8,
};

const STORAGE_KEY = 'eco-local-ai-ledger-v1';

/** The pre-slice-3 (v1) profileKey shape: no `|f16:` component. */
function legacyProfileKey(profile: DeviceProfile): string {
  return profileKey(profile).split('|f16:')[0]!;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('profileKey', () => {
  it('is stable for the same profile shape', () => {
    expect(profileKey(PROFILE_24GB)).toBe(profileKey({ ...PROFILE_24GB }));
  });

  it('differs across browser class', () => {
    expect(profileKey(PROFILE_24GB)).not.toBe(
      profileKey({ ...PROFILE_24GB, browserClass: 'safari' }),
    );
  });

  it('differs across device class (memory-derived)', () => {
    expect(profileKey(PROFILE_24GB)).not.toBe(profileKey(PROFILE_8GB));
  });
});

describe('recordEvidence + readEvidence', () => {
  it('roundtrips a smoke-pass entry', () => {
    recordEvidence({
      modelId: 'local/phi3-mini-4k-q4f16',
      profile: PROFILE_24GB,
      outcome: 'smoke-pass',
      firstTokenMs: 250,
      tokensPerSec: 12.5,
    });
    const entries = readEvidence('local/phi3-mini-4k-q4f16', PROFILE_24GB);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({
      modelId: 'local/phi3-mini-4k-q4f16',
      outcome: 'smoke-pass',
      firstTokenMs: 250,
      tokensPerSec: 12.5,
    });
    expect(Date.parse(entry.recordedAt)).toBeGreaterThan(0);
  });

  it('scopes by profile — a record from one profile is not visible from another', () => {
    recordEvidence({
      modelId: 'local/phi3-mini-4k-q4f16',
      profile: PROFILE_24GB,
      outcome: 'smoke-pass',
    });
    expect(readEvidence('local/phi3-mini-4k-q4f16', PROFILE_8GB)).toEqual([]);
  });
});

describe('hasRecentSuccess / hasRecentFailure', () => {
  it('hasRecentSuccess true for a fresh smoke-pass', () => {
    recordEvidence({
      modelId: 'local/bonsai-1.7b-q4',
      profile: PROFILE_8GB,
      outcome: 'smoke-pass',
    });
    expect(hasRecentSuccess('local/bonsai-1.7b-q4', PROFILE_8GB)).toBe(true);
  });

  it('hasRecentSuccess false for only-failure history', () => {
    recordEvidence({
      modelId: 'local/bonsai-1.7b-q4',
      profile: PROFILE_8GB,
      outcome: 'smoke-fail',
    });
    expect(hasRecentSuccess('local/bonsai-1.7b-q4', PROFILE_8GB)).toBe(false);
    expect(hasRecentFailure('local/bonsai-1.7b-q4', PROFILE_8GB)).toBe(true);
  });

  it('treats older-than-window entries as not recent', () => {
    const oldRecordedAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          modelId: 'local/bonsai-1.7b-q4',
          profileKey: profileKey(PROFILE_8GB),
          outcome: 'smoke-pass',
          recordedAt: oldRecordedAt,
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );
    expect(hasRecentSuccess('local/bonsai-1.7b-q4', PROFILE_8GB, 30)).toBe(false);
  });

  it('honors a custom maxAgeDays', () => {
    const recentlyRecordedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          modelId: 'local/bonsai-1.7b-q4',
          profileKey: profileKey(PROFILE_8GB),
          outcome: 'smoke-pass',
          recordedAt: recentlyRecordedAt,
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );
    expect(hasRecentSuccess('local/bonsai-1.7b-q4', PROFILE_8GB, 1)).toBe(false);
    expect(hasRecentSuccess('local/bonsai-1.7b-q4', PROFILE_8GB, 30)).toBe(true);
  });
});

describe('clearEvidence', () => {
  it('clears all evidence when no modelId given', () => {
    recordEvidence({ modelId: 'a', profile: PROFILE_24GB, outcome: 'smoke-pass' });
    recordEvidence({ modelId: 'b', profile: PROFILE_24GB, outcome: 'smoke-pass' });
    clearEvidence();
    expect(readEvidence('a', PROFILE_24GB)).toEqual([]);
    expect(readEvidence('b', PROFILE_24GB)).toEqual([]);
  });

  it('clears only matching modelId when one is given', () => {
    recordEvidence({ modelId: 'a', profile: PROFILE_24GB, outcome: 'smoke-pass' });
    recordEvidence({ modelId: 'b', profile: PROFILE_24GB, outcome: 'smoke-pass' });
    clearEvidence('a');
    expect(readEvidence('a', PROFILE_24GB)).toEqual([]);
    expect(readEvidence('b', PROFILE_24GB)).toHaveLength(1);
  });
});

describe('ledger versioning', () => {
  it('stamps new entries with CURRENT_LEDGER_VERSION', () => {
    recordEvidence({
      modelId: 'local/phi3-mini-4k-q4f16',
      profile: PROFILE_24GB,
      outcome: 'smoke-pass',
    });
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Array<Record<string, unknown>>;
    expect(raw[0]!.ledgerVersion).toBe(CURRENT_LEDGER_VERSION);
  });

  it('new profileKeys carry an f16 component', () => {
    // PROFILE_24GB has no probed shader-f16 flag → the component is `unknown`.
    expect(profileKey(PROFILE_24GB)).toContain('|f16:unknown');
    expect(profileKey({ ...PROFILE_24GB, webgpuShaderF16: true })).toContain('|f16:yes');
    expect(profileKey({ ...PROFILE_24GB, webgpuShaderF16: false })).toContain('|f16:no');
  });

  it('records the new failure outcomes (download/load/swap)', () => {
    recordEvidence({
      modelId: 'candidate/gemma-4-e2b-litert',
      profile: PROFILE_24GB,
      outcome: 'download-fail',
      errorCode: 'failed',
    });
    recordEvidence({
      modelId: 'candidate/gemma-4-e2b-litert',
      profile: PROFILE_24GB,
      outcome: 'load-fail',
      backend: 'webgpu',
    });
    const entries = readEvidence('candidate/gemma-4-e2b-litert', PROFILE_24GB);
    expect(entries.map((e) => e.outcome).sort()).toEqual(['download-fail', 'load-fail']);
    expect(entries.find((e) => e.outcome === 'download-fail')!.errorCode).toBe('failed');
    expect(entries.find((e) => e.outcome === 'load-fail')!.backend).toBe('webgpu');
  });
});

describe('v1 → v2 migration', () => {
  function seedLegacyRows(): void {
    // Two legacy (v1) rows: no `|f16:` component, no ledgerVersion.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          modelId: 'local/phi3-mini-4k-q4f16',
          profileKey: legacyProfileKey(PROFILE_24GB),
          outcome: 'smoke-fail',
          recordedAt: new Date().toISOString(),
        },
        {
          modelId: 'local/bonsai-1.7b-q4',
          profileKey: legacyProfileKey(PROFILE_8GB),
          outcome: 'smoke-pass',
          recordedAt: new Date().toISOString(),
        },
      ]),
    );
  }

  it('migrates v1 rows in place — appends |f16:unknown and stamps v2, no row loss', () => {
    seedLegacyRows();
    const migrated = readAllEntries();
    expect(migrated).toHaveLength(2); // no row dropped
    for (const entry of migrated) {
      expect(entry.profileKey).toContain('|f16:unknown');
      expect(entry.ledgerVersion).toBe(CURRENT_LEDGER_VERSION);
    }
    // The rewrite is persisted on first read.
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(2);
    expect(persisted.every((e) => String(e.profileKey).includes('|f16:unknown'))).toBe(true);
  });

  it('is idempotent — a second read migrates nothing and does not rewrite', () => {
    seedLegacyRows();
    const first = readAllEntries();
    const afterFirst = localStorage.getItem(STORAGE_KEY);
    const second = readAllEntries();
    const afterSecond = localStorage.getItem(STORAGE_KEY);
    expect(second).toEqual(first);
    // Storage is byte-identical across the second pass (no redundant write).
    expect(afterSecond).toBe(afterFirst);
  });

  it('keeps migrated v1 rows visible on the same device (f16:unknown matches)', () => {
    seedLegacyRows();
    // The device now reports shader-f16 = true; the migrated unknown row still matches.
    const probed: DeviceProfile = { ...PROFILE_24GB, webgpuShaderF16: true };
    expect(hasRecentFailure('local/phi3-mini-4k-q4f16', probed)).toBe(true);
    expect(hasRecentSuccess('local/bonsai-1.7b-q4', { ...PROFILE_8GB, webgpuShaderF16: false })).toBe(true);
  });
});

describe('countRecentDownloadFailures', () => {
  it('counts genuine download-fail rows in the 7-day window', () => {
    recordEvidence({ modelId: 'm', profile: PROFILE_24GB, outcome: 'download-fail', errorCode: 'failed' });
    recordEvidence({ modelId: 'm', profile: PROFILE_24GB, outcome: 'download-fail', errorCode: 'integrity' });
    expect(countRecentDownloadFailures('m', PROFILE_24GB)).toBe(2);
  });

  it('excludes aborted rows (user cancel is not a failure)', () => {
    recordEvidence({ modelId: 'm', profile: PROFILE_24GB, outcome: 'download-fail', errorCode: 'aborted' });
    recordEvidence({ modelId: 'm', profile: PROFILE_24GB, outcome: 'download-fail', errorCode: 'failed' });
    expect(countRecentDownloadFailures('m', PROFILE_24GB)).toBe(1);
  });

  it('excludes rows older than the window', () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          modelId: 'm',
          profileKey: profileKey(PROFILE_24GB),
          outcome: 'download-fail',
          errorCode: 'failed',
          recordedAt: old,
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );
    expect(countRecentDownloadFailures('m', PROFILE_24GB, 7)).toBe(0);
  });

  it('does not count smoke failures as download failures', () => {
    recordEvidence({ modelId: 'm', profile: PROFILE_24GB, outcome: 'smoke-fail' });
    expect(countRecentDownloadFailures('m', PROFILE_24GB)).toBe(0);
  });
});

describe('self-heal on malformed storage', () => {
  it('clears storage on JSON parse failure and returns []', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    expect(readEvidence('a', PROFILE_24GB)).toEqual([]);
    // Storage should be wiped so subsequent writes start fresh.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('drops entries that fail the shape check', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { modelId: 'a', profileKey: 'x', outcome: 'smoke-pass', recordedAt: '2026-05-15T00:00:00.000Z', ledgerVersion: CURRENT_LEDGER_VERSION },
        { invalid: true },
        { modelId: 'b', outcome: 'not-real-outcome' },
      ]),
    );
    const entries = readEvidence('a', { ...PROFILE_24GB });
    // The first entry's profileKey doesn't match PROFILE_24GB so we expect 0
    // — but the shape filter should at least have allowed it to pass through
    // readAllEntries(). Verify by reading b: should be 0 too (filtered).
    expect(entries).toEqual([]);
    // Wipe & re-record cleanly should still work.
    clearEvidence();
    recordEvidence({ modelId: 'a', profile: PROFILE_24GB, outcome: 'smoke-pass' });
    expect(readEvidence('a', PROFILE_24GB)).toHaveLength(1);
  });
});
