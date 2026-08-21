// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * useModelUpgrade — session orchestration of the in-place model pull.
 *
 * The state machine itself is covered by lifecycle/__tests__/upgrade.test.ts;
 * these tests lock the HOOK's contract at the module boundary: that a tile's
 * request starts the download and nothing else does, that a staged model waits
 * for the user instead of swapping itself in at boot, that a swap routes chat
 * to the slot it bound, that streaming blocks a manual swap, and that the boot
 * flow runs exactly once across instances and remounts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ModelConfig } from '../../../local-ai/types';
import type { UpgradeRecord } from '../../../local-ai/lifecycle/upgrade';

const mockReconcile = vi.fn();
const mockReadRecord = vi.fn();
const mockApplyEvent = vi.fn();
const mockRunDownload = vi.fn();
const mockPerformSwap = vi.fn();
const mockGetModel = vi.fn();
const mockSetSelectedModel = vi.fn();

let isStreaming = false;

vi.mock('../../../local-ai/lifecycle/upgrade', () => ({
  UPGRADE_STORAGE_KEY: 'eco-local-ai-upgrade-v1',
  reconcileUpgradeOnBoot: (...args: unknown[]) => mockReconcile(...args),
  readUpgradeRecord: (...args: unknown[]) => mockReadRecord(...args),
  applyUpgradeEvent: (...args: unknown[]) => mockApplyEvent(...args),
  runUpgradeDownload: (...args: unknown[]) => mockRunDownload(...args),
  performUpgradeSwap: (...args: unknown[]) => mockPerformSwap(...args),
}));

vi.mock('../../../local-ai/catalog/catalog', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
}));

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({ isStreaming, setSelectedModel: mockSetSelectedModel }),
  },
}));

import {
  useModelUpgrade,
  useModelUpgradeUi,
  requestModelPull,
  swapPulledModelNow,
  _resetModelUpgradeForTesting,
} from '../useModelUpgrade';

const TARGET = { id: 'target', friendlyName: 'Qwen (test)', sizeGB: 1.4 } as unknown as ModelConfig;

function upgradeRecord(over: Partial<UpgradeRecord> = {}): UpgradeRecord {
  return {
    version: 1,
    phase: 'accepted',
    targetModelId: 'target',
    targetSlot: 'eco-smart',
    baseModelId: null,
    deferral: null,
    swapAttempts: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Mount the driver AND read the shared UI, which is how the app is wired. */
function renderDriver() {
  return renderHook(() => {
    useModelUpgrade({ enabled: true });
    return useModelUpgradeUi();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetModelUpgradeForTesting();
  isStreaming = false;
  mockReconcile.mockReturnValue(null);
  mockReadRecord.mockReturnValue(null);
  mockGetModel.mockImplementation((id: string) => (id === 'target' ? TARGET : null));
  mockApplyEvent.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useModelUpgrade — boot flow', () => {
  it('does nothing while disabled', async () => {
    renderHook(() => useModelUpgrade({ enabled: false }));
    await settle();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('offers nothing on its own — an idle record starts no download', async () => {
    const { result } = renderDriver();
    await settle();

    expect(result.current).toEqual({ kind: 'hidden' });
    expect(mockApplyEvent).not.toHaveBeenCalled();
    expect(mockRunDownload).not.toHaveBeenCalled();
  });

  it('runs the boot flow exactly once across instances and remounts', async () => {
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'downloading' }));
    mockRunDownload.mockResolvedValue({ kind: 'staged' });

    const first = renderDriver();
    const second = renderDriver();
    await settle();
    first.rerender();
    second.rerender();
    await settle();

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockRunDownload).toHaveBeenCalledTimes(1);
    // Both instances render the shared module state.
    expect(first.result.current.kind).toBe('ready');
    expect(second.result.current.kind).toBe('ready');
  });

  it('resumes a download the last session started (no re-ask)', async () => {
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'downloading' }));
    mockRunDownload.mockResolvedValue({ kind: 'staged' });

    const { result } = renderDriver();
    await settle();

    expect(mockRunDownload).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(result.current).toEqual({ kind: 'ready', target: TARGET, slot: 'eco-smart' }),
    );
  });

  it('a staged model from a prior session WAITS for the user — it never swaps at boot', async () => {
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'staged' }));

    const { result } = renderDriver();
    await settle();

    expect(result.current).toEqual({ kind: 'ready', target: TARGET, slot: 'eco-smart' });
    // The whole point: no swap ran, and chat was not re-routed behind their back.
    expect(mockPerformSwap).not.toHaveBeenCalled();
    expect(mockSetSelectedModel).not.toHaveBeenCalled();
  });
});

describe('useModelUpgrade — requesting a pull from a tile', () => {
  it('records the request against the slot it names and starts the download', async () => {
    mockApplyEvent.mockReturnValue(upgradeRecord({ phase: 'accepted', targetSlot: 'eco-fast' }));
    mockRunDownload.mockResolvedValue({ kind: 'staged' });

    const { result } = renderDriver();
    await settle();
    await act(async () => {
      requestModelPull('eco-fast', 'target');
    });
    await settle();

    expect(mockApplyEvent).toHaveBeenCalledWith({
      type: 'request',
      targetModelId: 'target',
      targetSlot: 'eco-fast',
    });
    expect(mockRunDownload).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ kind: 'ready', target: TARGET, slot: 'eco-fast' });
  });

  it('starts nothing when the machine refuses (a different cycle is mid-flight)', async () => {
    // The transition table returns the untouched in-flight record.
    mockApplyEvent.mockReturnValue(upgradeRecord({ phase: 'downloading', targetModelId: 'other' }));

    renderDriver();
    await settle();
    await act(async () => {
      requestModelPull('eco-smart', 'target');
    });
    await settle();

    expect(mockRunDownload).not.toHaveBeenCalled();
  });

  it('reflects download progress on the way to ready', async () => {
    mockApplyEvent.mockReturnValue(upgradeRecord({ phase: 'accepted' }));
    const seen: string[] = [];
    mockRunDownload.mockImplementation(
      async (opts: { onProgressEvent?: (e: unknown) => void }) => {
        opts.onProgressEvent?.({ kind: 'progress', phase: 'downloading', percent: 0.4 });
        return { kind: 'staged' };
      },
    );

    const { result } = renderHook(() => {
      useModelUpgrade({ enabled: true });
      const ui = useModelUpgradeUi();
      seen.push(ui.kind === 'downloading' ? `downloading:${String(ui.percent)}` : ui.kind);
      return ui;
    });
    await settle();
    await act(async () => {
      requestModelPull('eco-smart', 'target');
    });
    await settle();

    expect(seen).toContain('downloading:0.4');
    expect(result.current.kind).toBe('ready');
  });

  it('a deferred download surfaces the honest note on the tile', async () => {
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'accepted' }));
    // The whole deferral reaches the tile, figures included — the tile renders
    // the numbers itself rather than only the sentence.
    const deferral = {
      code: 'insufficient-storage' as const,
      message:
        'Eco needs about 1.7 GB of free space for this model, but only about 0.4 GB is available on this device.',
      requiredBytes: 1_700_000_000,
      availableBytes: 400_000_000,
    };
    mockRunDownload.mockResolvedValue({ kind: 'deferred', deferral });

    const { result } = renderDriver();
    await settle();

    await waitFor(() =>
      expect(result.current).toEqual({
        kind: 'deferred',
        target: TARGET,
        slot: 'eco-smart',
        deferral,
      }),
    );
  });

  it('an evicted staged cache re-downloads instead of a doomed load', async () => {
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
    mockPerformSwap.mockResolvedValue({ kind: 'reverted-to-download' });
    mockRunDownload.mockResolvedValue({ kind: 'staged' });

    const { result } = renderDriver();
    await settle();
    await act(async () => {
      swapPulledModelNow();
    });
    await settle();

    await waitFor(() => expect(mockRunDownload).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current).toEqual({ kind: 'ready', target: TARGET, slot: 'eco-smart' }),
    );
  });
});

describe('useModelUpgrade — the user-driven swap', () => {
  it('swaps a staged model and routes chat to the slot it bound', async () => {
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged', targetSlot: 'eco-fast' }));
    mockPerformSwap.mockResolvedValue({ kind: 'swapped', model: TARGET });

    const { result } = renderDriver();
    await settle();
    await act(async () => {
      swapPulledModelNow();
    });
    await settle();

    expect(mockPerformSwap).toHaveBeenCalledTimes(1);
    // The SLOT name, never the model id, and explicit: they picked this twice.
    expect(mockSetSelectedModel).toHaveBeenCalledWith('eco-fast', { persist: true, explicit: true });
    // The tile reads its state off the slot from here on.
    expect(result.current).toEqual({ kind: 'hidden' });
  });

  it('shows the swap progressing on the tile', async () => {
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
    const seen: string[] = [];
    mockPerformSwap.mockImplementation(
      async (opts: { onProgress?: (e: unknown) => void }) => {
        opts.onProgress?.({ kind: 'phase', phase: 'loading' });
        opts.onProgress?.({ kind: 'load', fraction: 0.5 });
        return { kind: 'swapped', model: TARGET };
      },
    );

    renderHook(() => {
      useModelUpgrade({ enabled: true });
      const ui = useModelUpgradeUi();
      seen.push(ui.kind === 'swapping' ? `swapping:${String(ui.percent)}` : ui.kind);
      return ui;
    });
    await settle();
    await act(async () => {
      swapPulledModelNow();
    });
    await settle();

    expect(seen).toContain('swapping:0.5');
  });

  it('auto-retries once after a transient busy, then swaps', async () => {
    vi.useFakeTimers();
    try {
      mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
      mockPerformSwap
        .mockResolvedValueOnce({ kind: 'busy', message: 'A readiness check is already running.' })
        .mockResolvedValueOnce({ kind: 'swapped', model: TARGET });

      const { result } = renderDriver();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        swapPulledModelNow();
      });
      // First swap resolved busy — waiting on the silent retry timer.
      expect(mockPerformSwap).toHaveBeenCalledTimes(1);
      expect(result.current.kind).toBe('swapping');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(mockPerformSwap).toHaveBeenCalledTimes(2);
      expect(result.current).toEqual({ kind: 'hidden' });
      expect(mockSetSelectedModel).toHaveBeenCalledWith('eco-smart', {
        persist: true,
        explicit: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the ready affordance when still busy after the one retry — and never retries again', async () => {
    vi.useFakeTimers();
    try {
      mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
      mockPerformSwap.mockResolvedValue({ kind: 'busy', message: 'still busy' });

      const { result } = renderDriver();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        swapPulledModelNow();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });

      // Exactly two swap attempts (original + one retry). Each busy self-
      // refunds its optimistic attempt in performUpgradeSwap, so the retry
      // never burns one of MAX_SWAP_ATTEMPTS.
      expect(mockPerformSwap).toHaveBeenCalledTimes(2);
      expect(result.current).toMatchObject({ kind: 'ready', target: TARGET, notice: 'still busy' });

      // Single-retry cap: no further attempts as time passes.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(mockPerformSwap).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT auto-retry a real swap failure — one attempt only', async () => {
    vi.useFakeTimers();
    try {
      mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
      mockPerformSwap.mockResolvedValue({ kind: 'failed', result: { success: false } });

      const { result } = renderDriver();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        swapPulledModelNow();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });

      expect(mockPerformSwap).toHaveBeenCalledTimes(1);
      expect(result.current).toMatchObject({ kind: 'ready', target: TARGET });
      expect((result.current as { notice?: string }).notice).toMatch(/untouched/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never swaps mid-generation', async () => {
    isStreaming = true;
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));

    renderDriver();
    await settle();
    await act(async () => {
      swapPulledModelNow();
    });

    expect(mockPerformSwap).not.toHaveBeenCalled();
  });

  it('refuses to swap anything that is not staged', async () => {
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'downloading' }));

    renderDriver();
    await settle();
    await act(async () => {
      swapPulledModelNow();
    });

    expect(mockPerformSwap).not.toHaveBeenCalled();
  });
});
