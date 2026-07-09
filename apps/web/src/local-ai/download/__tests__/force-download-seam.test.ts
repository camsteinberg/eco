// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
// @vitest-environment node

/**
 * eco-force-download validation seam — unit coverage.
 *
 * The seam lets a browser validator force a download failure via
 * `eco-force-download=<mode>`. download.ts reads it through
 * `getValidationDownloadFailure()` and injects a real, typed error at the top of
 * the fetch phase. These tests mock that single accessor and assert, per mode,
 * that:
 *   - the correct real error class propagates, and
 *   - the injection fires BEFORE any network work (the fetcher is never called),
 * plus that `'none'` (which is also what a disabled harness yields) leaves the
 * normal download path completely intact.
 *
 * Runs under `node` (not jsdom) for faithful fetch/Response/Blob semantics on
 * the `'none'` happy path, mirroring download.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidationDownloadFailureMode } from '../../../lib/validation-harness';
import {
  type DownloadPlan,
  DownloadFailedError,
  InsufficientStorageError,
  downloadByPlan,
  downloadModel,
  setDownloadPlanResolver,
} from '../download';
import type { Storage, StorageKey } from '../storage';
import type { ModelConfig } from '../../types';

// The seam's single read point. Hoisted so the module mock can bind it before
// download.ts is imported; each test drives it via mockReturnValue.
const { forcedMode } = vi.hoisted(() => ({
  forcedMode: vi.fn((): ValidationDownloadFailureMode => 'none'),
}));

vi.mock('../../../lib/validation-harness', () => ({
  getValidationDownloadFailure: () => forcedMode(),
}));

// downloadModel records download-fail rows through these direct imports; spy on
// them (node env has no localStorage) to observe the classification.
vi.mock('../../evidence/ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../evidence/ledger')>()),
  recordEvidence: vi.fn(),
}));
vi.mock('../../device/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../device/profile')>()),
  getDeviceProfile: vi.fn(() => ({
    browserClass: 'chromium' as const,
    webgpuSupport: 'webgpu' as const,
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto' as const,
  })),
}));

import { recordEvidence } from '../../evidence/ledger';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** Storage that reports every file uncached, so downloadByPlan reaches the fetch phase. */
function uncachedStorage(): Storage {
  return {
    backend: 'cache-api',
    verify: async (_key: StorageKey, _size: number) => false,
    put: async () => undefined,
    get: async () => null,
    has: async () => false,
    remove: async () => undefined,
    listForModel: async () => [],
    clearModel: async () => undefined,
  };
}

const PLAN: DownloadPlan = {
  modelId: 'candidate/lfm2.5-350m-onnx',
  files: [{ url: 'https://models.test/weights.onnx', sizeBytes: 1024 }],
};

const MODEL: ModelConfig = { id: PLAN.modelId } as ModelConfig;

// A confident "no headroom info" probe so the preflight fails open and the
// injection is what decides the outcome.
const noEstimate = async () => null;

const FAILURE_MODES: ValidationDownloadFailureMode[] = [
  'storage',
  'quota',
  'cache',
  'opfs',
  'hosting',
];

afterEach(() => {
  vi.clearAllMocks();
  forcedMode.mockReturnValue('none');
  setDownloadPlanResolver(null);
});

describe('eco-force-download seam injection', () => {
  it('is inert when the seam is none — the normal download path runs', async () => {
    forcedMode.mockReturnValue('none');
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const result = await downloadByPlan(PLAN, {
      storage: uncachedStorage(),
      fetcher: fetcher as unknown as typeof fetch,
      estimateStorage: noEstimate,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.filesFetched).toBe(1);
  });

  it('injects before any network work — the fetcher is never called', async () => {
    forcedMode.mockReturnValue('storage');
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));

    await expect(
      downloadByPlan(PLAN, {
        storage: uncachedStorage(),
        fetcher: fetcher as unknown as typeof fetch,
        estimateStorage: noEstimate,
      }),
    ).rejects.toBeInstanceOf(InsufficientStorageError);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps storage → InsufficientStorageError with a free-space message', async () => {
    forcedMode.mockReturnValue('storage');
    let thrown: unknown;
    await downloadByPlan(PLAN, { storage: uncachedStorage(), estimateStorage: noEstimate }).catch(
      (err) => {
        thrown = err;
      },
    );
    expect(thrown).toBeInstanceOf(InsufficientStorageError);
    expect((thrown as InsufficientStorageError).availableBytes).toBeGreaterThan(0);
    expect((thrown as Error).message).toMatch(/free space/i);
  });

  it('maps quota → InsufficientStorageError with no available figure', async () => {
    forcedMode.mockReturnValue('quota');
    let thrown: unknown;
    await downloadByPlan(PLAN, { storage: uncachedStorage(), estimateStorage: noEstimate }).catch(
      (err) => {
        thrown = err;
      },
    );
    expect(thrown).toBeInstanceOf(InsufficientStorageError);
    expect((thrown as InsufficientStorageError).availableBytes).toBeUndefined();
    expect((thrown as Error).message).toMatch(/ran out of free space/i);
  });

  it('maps hosting → HTTP-shaped DownloadFailedError', async () => {
    forcedMode.mockReturnValue('hosting');
    let thrown: unknown;
    await downloadByPlan(PLAN, { storage: uncachedStorage(), estimateStorage: noEstimate }).catch(
      (err) => {
        thrown = err;
      },
    );
    expect(thrown).toBeInstanceOf(DownloadFailedError);
    expect((thrown as DownloadFailedError).status).toBe(500);
  });

  it('maps cache → a plain backend write error (no storage-shortage wording)', async () => {
    forcedMode.mockReturnValue('cache');
    let thrown: unknown;
    await downloadByPlan(PLAN, { storage: uncachedStorage(), estimateStorage: noEstimate }).catch(
      (err) => {
        thrown = err;
      },
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(InsufficientStorageError);
    expect((thrown as Error).message).toMatch(/browser cache/i);
    expect((thrown as Error).message).not.toMatch(/free space|storage|disk space/i);
  });

  it('maps opfs → a plain backend write error (no storage-shortage wording)', async () => {
    forcedMode.mockReturnValue('opfs');
    let thrown: unknown;
    await downloadByPlan(PLAN, { storage: uncachedStorage(), estimateStorage: noEstimate }).catch(
      (err) => {
        thrown = err;
      },
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(InsufficientStorageError);
    expect((thrown as Error).message).toMatch(/file system/i);
    expect((thrown as Error).message).not.toMatch(/free space|storage|disk space/i);
  });

  it('every forced mode throws before the network', async () => {
    for (const mode of FAILURE_MODES) {
      forcedMode.mockReturnValue(mode);
      const fetcher = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
      await downloadByPlan(PLAN, {
        storage: uncachedStorage(),
        fetcher: fetcher as unknown as typeof fetch,
        estimateStorage: noEstimate,
      }).catch(() => undefined);
      expect(fetcher, `mode=${mode}`).not.toHaveBeenCalled();
    }
  });
});

describe('eco-force-download seam — failure recording through downloadModel', () => {
  beforeEach(() => {
    setDownloadPlanResolver(async () => PLAN);
  });

  it('records a storage forced-failure as insufficient-storage', async () => {
    forcedMode.mockReturnValue('storage');
    await downloadModel(MODEL, { storage: uncachedStorage(), estimateStorage: noEstimate }).catch(
      () => undefined,
    );
    expect(recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'download-fail', errorCode: 'insufficient-storage' }),
    );
  });

  it('records a hosting forced-failure as a generic failed download', async () => {
    forcedMode.mockReturnValue('hosting');
    await downloadModel(MODEL, { storage: uncachedStorage(), estimateStorage: noEstimate }).catch(
      () => undefined,
    );
    expect(recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'download-fail', errorCode: 'failed' }),
    );
  });
});
