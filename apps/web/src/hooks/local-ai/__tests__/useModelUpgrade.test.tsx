// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * useModelUpgrade — session orchestration of the consent-driven upgrade.
 *
 * The state machine itself is covered by lifecycle/__tests__/upgrade.test.ts;
 * these tests lock the HOOK's contract at the module boundary: when the boot
 * flow offers / resumes / boot-swaps, that consent gates the download, that
 * the swap routes chat to eco-smart, that streaming blocks a manual swap, and
 * that the boot flow runs exactly once across instances and remounts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ModelConfig } from '../../../local-ai/types';
import type { UpgradeRecord } from '../../../local-ai/lifecycle/upgrade';

const mockReconcile = vi.fn();
const mockReadRecord = vi.fn();
const mockApplyEvent = vi.fn();
const mockPlanOffer = vi.fn();
const mockRunDownload = vi.fn();
const mockPerformSwap = vi.fn();
const mockGetSlot = vi.fn();
const mockGetModel = vi.fn();
const mockSetSelectedModel = vi.fn();

let isStreaming = false;

vi.mock('../../../local-ai/lifecycle/upgrade', () => ({
  UPGRADE_STORAGE_KEY: 'eco-local-ai-upgrade-v1',
  reconcileUpgradeOnBoot: (...args: unknown[]) => mockReconcile(...args),
  readUpgradeRecord: (...args: unknown[]) => mockReadRecord(...args),
  applyUpgradeEvent: (...args: unknown[]) => mockApplyEvent(...args),
  planUpgradeOffer: (...args: unknown[]) => mockPlanOffer(...args),
  runUpgradeDownload: (...args: unknown[]) => mockRunDownload(...args),
  performUpgradeSwap: (...args: unknown[]) => mockPerformSwap(...args),
}));

vi.mock('../../../local-ai/lifecycle/slots', () => ({
  getSlot: (...args: unknown[]) => mockGetSlot(...args),
}));

vi.mock('../../../local-ai/catalog/catalog', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
}));

vi.mock('../../../local-ai/device/profile', () => ({
  getDeviceProfile: () => ({ browserClass: 'chromium' }),
}));

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({ isStreaming, setSelectedModel: mockSetSelectedModel }),
  },
}));

import { useModelUpgrade, _resetModelUpgradeForTesting } from '../useModelUpgrade';

const TARGET = { id: 'target', friendlyName: 'Qwen (test)', sizeGB: 1.4 } as unknown as ModelConfig;

function upgradeRecord(over: Partial<UpgradeRecord> = {}): UpgradeRecord {
  return {
    version: 1,
    phase: 'offered',
    targetModelId: 'target',
    baseModelId: 'starter',
    deferral: null,
    swapAttempts: 0,
    updatedAt: 0,
    ...over,
  };
}

function fastSlot(modelId: string | null = 'starter') {
  return { slot: 'eco-fast', modelId, model: modelId ? { id: modelId } : null, status: 'ready' };
}

function emptySmartSlot() {
  return { slot: 'eco-smart', modelId: null, model: null, status: 'empty' };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetModelUpgradeForTesting();
  isStreaming = false;
  mockReconcile.mockReturnValue(null);
  mockReadRecord.mockReturnValue(null);
  mockPlanOffer.mockReturnValue(null);
  mockGetModel.mockImplementation((id: string) => (id === 'target' ? TARGET : null));
  mockGetSlot.mockImplementation((slot: string) =>
    slot === 'eco-fast' ? fastSlot() : emptySmartSlot(),
  );
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

describe('useModelUpgrade — gating and boot flow', () => {
  it('does nothing while disabled', async () => {
    renderHook(() => useModelUpgrade({ enabled: false }));
    await settle();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('offers the recommended upgrade on a fresh session and records the offer', async () => {
    mockPlanOffer.mockReturnValue(TARGET);
    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();

    expect(result.current.ui).toEqual({ kind: 'offer', target: TARGET });
    expect(mockApplyEvent).toHaveBeenCalledWith({
      type: 'offer',
      targetModelId: 'target',
      baseModelId: 'starter',
    });
    // Consent gate: no download without an accept.
    expect(mockRunDownload).not.toHaveBeenCalled();
  });

  it('stays hidden when there is nothing to offer (convergence / settled cycle)', async () => {
    mockPlanOffer.mockReturnValue(null);
    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();
    expect(result.current.ui).toEqual({ kind: 'hidden' });
    expect(mockApplyEvent).not.toHaveBeenCalled();
  });

  it('runs the boot flow exactly once across instances and remounts', async () => {
    mockPlanOffer.mockReturnValue(TARGET);
    const first = renderHook(() => useModelUpgrade({ enabled: true }));
    const second = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();
    first.rerender();
    second.rerender();
    await settle();

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    // Both instances render the shared module state.
    expect(first.result.current.ui.kind).toBe('offer');
    expect(second.result.current.ui.kind).toBe('offer');
  });

  it('resumes a consented download from a prior session (no re-ask)', async () => {
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'downloading' }));
    mockRunDownload.mockResolvedValue({ kind: 'staged' });
    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();

    expect(mockRunDownload).toHaveBeenCalledTimes(1);
    expect(mockPlanOffer).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.ui).toEqual({ kind: 'ready', target: TARGET }));
  });
});

describe('useModelUpgrade — consent + download', () => {
  it('accept() starts the background download and lands on the ready prompt', async () => {
    mockPlanOffer.mockReturnValue(TARGET);
    mockApplyEvent.mockImplementation((event: { type: string }) =>
      event.type === 'accept' ? upgradeRecord({ phase: 'accepted' }) : upgradeRecord(),
    );
    mockRunDownload.mockResolvedValue({ kind: 'staged' });

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();
    await act(async () => {
      result.current.accept();
    });
    await settle();

    expect(mockApplyEvent).toHaveBeenCalledWith({ type: 'accept' });
    expect(mockRunDownload).toHaveBeenCalledTimes(1);
    expect(result.current.ui).toEqual({ kind: 'ready', target: TARGET });
  });

  it('reflects download progress events', async () => {
    mockPlanOffer.mockReturnValue(TARGET);
    mockApplyEvent.mockImplementation((event: { type: string }) =>
      event.type === 'accept' ? upgradeRecord({ phase: 'accepted' }) : upgradeRecord(),
    );
    let capturedOnProgress: ((e: unknown) => void) | undefined;
    mockRunDownload.mockImplementation(async (opts: { onProgressEvent?: (e: unknown) => void }) => {
      capturedOnProgress = opts.onProgressEvent;
      capturedOnProgress?.({ kind: 'progress', phase: 'downloading', percent: 0.4 });
      return { kind: 'staged' };
    });

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();
    await act(async () => {
      result.current.accept();
    });
    await settle();

    expect(capturedOnProgress).toBeDefined();
    expect(result.current.ui.kind).toBe('ready');
  });

  it('a deferred download surfaces the honest note', async () => {
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'accepted' }));
    const deferral = { code: 'insufficient-storage' as const, message: 'not enough space' };
    mockRunDownload.mockResolvedValue({ kind: 'deferred', deferral });

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();

    await waitFor(() => expect(result.current.ui).toEqual({ kind: 'deferred', deferral }));
  });

  it('decline() settles the cycle and hides', async () => {
    mockPlanOffer.mockReturnValue(TARGET);
    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();
    await act(async () => {
      result.current.decline();
    });

    expect(mockApplyEvent).toHaveBeenCalledWith({ type: 'decline' });
    expect(result.current.ui).toEqual({ kind: 'hidden' });
    expect(mockRunDownload).not.toHaveBeenCalled();
  });
});

describe('useModelUpgrade — boot swap (staged from a prior session)', () => {
  it('swaps silently at boot, routes chat to eco-smart, and greets with the boost note', async () => {
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'staged' }));
    mockPerformSwap.mockResolvedValue({ kind: 'swapped', model: TARGET });

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();

    await waitFor(() => expect(result.current.ui).toEqual({ kind: 'boosted', target: TARGET, atBoot: true }));
    expect(mockPerformSwap).toHaveBeenCalledTimes(1);
    expect(mockSetSelectedModel).toHaveBeenCalledWith('eco-smart', { persist: true, explicit: false });
    // No prompt at boot — the user consented when they accepted the download.
    expect(mockPlanOffer).not.toHaveBeenCalled();
  });

  it('waits out a busy runtime (mount warmup) and retries the boot swap', async () => {
    vi.useFakeTimers();
    try {
      mockReconcile.mockReturnValue(upgradeRecord({ phase: 'staged' }));
      mockPerformSwap
        .mockResolvedValueOnce({ kind: 'busy', message: 'warming' })
        .mockResolvedValueOnce({ kind: 'swapped', model: TARGET });

      const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });

      expect(mockPerformSwap).toHaveBeenCalledTimes(2);
      expect(result.current.ui).toEqual({ kind: 'boosted', target: TARGET, atBoot: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent on a boot-swap failure — the starter keeps working', async () => {
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'staged' }));
    mockPerformSwap.mockResolvedValue({ kind: 'failed', result: { success: false } });

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();

    await waitFor(() => expect(result.current.ui).toEqual({ kind: 'hidden' }));
  });

  it('an evicted staged cache re-downloads instead of a doomed load', async () => {
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'staged' }));
    mockPerformSwap.mockResolvedValue({ kind: 'reverted-to-download' });
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'accepted' }));
    mockRunDownload.mockResolvedValue({ kind: 'staged' });

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();

    await waitFor(() => expect(mockRunDownload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.ui).toEqual({ kind: 'ready', target: TARGET }));
  });
});

describe('useModelUpgrade — manual swap', () => {
  it('swapNow() swaps a staged upgrade and routes chat to eco-smart', async () => {
    mockPlanOffer.mockReturnValue(TARGET);
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
    mockPerformSwap.mockResolvedValue({ kind: 'swapped', model: TARGET });

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();
    await act(async () => {
      result.current.swapNow();
    });
    await settle();

    expect(mockPerformSwap).toHaveBeenCalledTimes(1);
    expect(mockSetSelectedModel).toHaveBeenCalledWith('eco-smart', { persist: true, explicit: false });
    expect(result.current.ui).toEqual({ kind: 'boosted', target: TARGET, atBoot: false });
  });

  it('auto-retries a manual swap once after a transient busy, then boosts', async () => {
    vi.useFakeTimers();
    try {
      mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
      mockPerformSwap
        .mockResolvedValueOnce({ kind: 'busy', message: 'A readiness check is already running.' })
        .mockResolvedValueOnce({ kind: 'swapped', model: TARGET });

      const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        result.current.swapNow();
      });
      // First swap resolved busy — waiting on the silent retry timer.
      expect(mockPerformSwap).toHaveBeenCalledTimes(1);
      expect(result.current.ui).toEqual({ kind: 'swapping', target: TARGET, atBoot: false });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      // The single retry swapped successfully.
      expect(mockPerformSwap).toHaveBeenCalledTimes(2);
      expect(result.current.ui).toEqual({ kind: 'boosted', target: TARGET, atBoot: false });
      expect(mockSetSelectedModel).toHaveBeenCalledWith('eco-smart', { persist: true, explicit: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the ready prompt when still busy after the one retry — and never retries again', async () => {
    vi.useFakeTimers();
    try {
      mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
      mockPerformSwap.mockResolvedValue({ kind: 'busy', message: 'still busy' });

      const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        result.current.swapNow();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });

      // Exactly two swap attempts (original + one retry). Each busy self-
      // refunds its optimistic attempt in performUpgradeSwap, so the retry
      // never burns one of MAX_SWAP_ATTEMPTS. Then the manual prompt returns.
      expect(mockPerformSwap).toHaveBeenCalledTimes(2);
      expect(result.current.ui).toMatchObject({ kind: 'ready', target: TARGET, notice: 'still busy' });

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

      const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        result.current.swapNow();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });

      // Real failures bypass the busy retry entirely.
      expect(mockPerformSwap).toHaveBeenCalledTimes(1);
      expect(result.current.ui).toMatchObject({ kind: 'ready', target: TARGET });
      expect((result.current.ui as { notice?: string }).notice).toMatch(/untouched/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never swaps mid-generation', async () => {
    isStreaming = true;
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();
    await act(async () => {
      result.current.swapNow();
    });

    expect(mockPerformSwap).not.toHaveBeenCalled();
  });

  it('a failed swap returns to the ready prompt with honest copy — current model untouched', async () => {
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
    mockPerformSwap.mockResolvedValue({ kind: 'failed', result: { success: false } });

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();
    await act(async () => {
      result.current.swapNow();
    });
    await settle();

    expect(result.current.ui).toMatchObject({ kind: 'ready', target: TARGET });
    expect((result.current.ui as { notice?: string }).notice).toMatch(/untouched/i);
  });

  it('notNow() hides the prompt but keeps the staged record for the next boot', async () => {
    mockReadRecord.mockReturnValue(upgradeRecord({ phase: 'staged' }));
    mockReconcile.mockReturnValue(upgradeRecord({ phase: 'staged' }));
    mockPerformSwap.mockResolvedValue({ kind: 'swapped', model: TARGET });

    const { result } = renderHook(() => useModelUpgrade({ enabled: true }));
    await settle();
    await act(async () => {
      result.current.notNow();
    });

    expect(result.current.ui).toEqual({ kind: 'hidden' });
    // No decline event — the staged record must survive.
    expect(mockApplyEvent).not.toHaveBeenCalledWith({ type: 'decline' });
  });
});
