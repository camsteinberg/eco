// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SwitchAIDialog } from '../SwitchAIDialog';
import type { ModelConfig } from '../../../local-ai/types';
import type {
  SwitchAIChoice,
  SwitchAIResult,
  UseSwitchAIReturn,
} from '../../../hooks/local-ai/useSwitchAI';

const LFM2: ModelConfig = {
  id: 'candidate/lfm2.5-1.2b-instruct-onnx',
  friendlyName: 'LFM2.5 1.2B',
  vendor: 'Liquid AI',
  sizeGB: 0.76,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 8192 },
  bestFor: 'conversation',
  knownLimitation: 'k',
  evidenceTier: 'proven',
};

const THIRD_MODEL: ModelConfig = {
  id: 'local/qwen3-0.6b',
  friendlyName: 'Qwen3',
  vendor: 'Alibaba',
  sizeGB: 0.57,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['snappy'], tasks: ['chat'], contextTokens: 2048 },
  bestFor: 'fast chat',
  knownLimitation: 'untested',
  evidenceTier: 'proven',
};

const QWEN: ModelConfig = {
  id: 'local/qwen3-0.5b',
  friendlyName: 'Qwen3',
  vendor: 'Alibaba',
  sizeGB: 0.6,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['snappy'], tasks: ['chat'], contextTokens: 2048 },
  bestFor: 'small device',
  knownLimitation: 'small',
  evidenceTier: 'proven',
};

function makeState(overrides: Partial<UseSwitchAIReturn> = {}): UseSwitchAIReturn {
  const choices: SwitchAIChoice[] = [
    { model: LFM2, confidence: 'benchmark', isTop: true },
    { model: THIRD_MODEL, confidence: 'calculated', isTop: false },
  ];
  return {
    recommendation: LFM2,
    choices,
    selectedId: THIRD_MODEL.id,
    select: vi.fn(),
    commit: vi.fn(async (): Promise<SwitchAIResult> => ({ success: true })),
    commitWith: vi.fn(async (): Promise<SwitchAIResult> => ({ success: true })),
    saving: false,
    ...overrides,
  };
}

describe('SwitchAIDialog — single calm list', () => {
  it('renders one radiogroup with every choice as a selectable row', () => {
    const onClose = vi.fn();
    const state = makeState();
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} state={state} />,
    );
    expect(screen.getByRole('radiogroup', { name: /available ais/i })).toBeInTheDocument();
    // Display-mapped names (LFM2.5 1.2B -> Eco Fast, Qwen3 -> Eco Compact)
    expect(screen.getByText('Eco Fast (Liquid)')).toBeInTheDocument();
    expect(screen.getByText('Eco Compact (Qwen)')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('does NOT render the old two-mode picker', () => {
    const onClose = vi.fn();
    const state = makeState();
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} state={state} />,
    );
    expect(screen.queryByText(/eco picks/i)).toBeNull();
    expect(screen.queryByText(/choose your own/i)).toBeNull();
  });

  it('marks the top entry with a quiet "Recommended for your device" sublabel only', () => {
    const onClose = vi.fn();
    const state = makeState();
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} state={state} />,
    );
    const recommended = screen.getAllByText(/recommended for your device/i);
    // One sublabel — on LFM2 (isTop:true entry).
    expect(recommended.length).toBe(1);
    // No standalone pulsing "Recommended" pill copy.
    expect(screen.queryByText(/^recommended$/i)).toBeNull();
  });

  it('selecting a row calls state.select with that model id', () => {
    const onClose = vi.fn();
    const select = vi.fn();
    const state = makeState({ select });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} state={state} />,
    );
    fireEvent.click(screen.getByText('Eco Fast (Liquid)'));
    expect(select).toHaveBeenCalledWith(LFM2.id);
  });

  it('reflects the current selection via aria-checked', () => {
    const onClose = vi.fn();
    const state = makeState({ selectedId: LFM2.id });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} state={state} />,
    );
    const radios = screen.getAllByRole('radio');
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
  });

  it('does NOT render mono technical provenance inline', () => {
    const onClose = vi.fn();
    const state = makeState();
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} state={state} />,
    );
    // provenance is "ONNX Community · 1.1 GB" / "Microsoft · 2.1 GB" — the
    // GB-suffixed technical line must not leak into the calm list.
    expect(screen.queryByText(/\d+\.\d+ GB/)).toBeNull();
  });

  it('does NOT show any "untested" or "may not work" warning copy', () => {
    const onClose = vi.fn();
    const state = makeState();
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} state={state} />,
    );
    expect(screen.queryByText(/untested on this hardware/i)).toBeNull();
    expect(screen.queryByText(/may not work/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /yes, switch/i })).toBeNull();
  });

  it('renders empty-state copy when no choices are available', () => {
    const onClose = vi.fn();
    const state = makeState({ choices: [], selectedId: null });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} state={state} />,
    );
    expect(screen.getByText(/no alternative ais are available/i)).toBeInTheDocument();
  });

  it('current row reads "Currently running" when the model is ready', () => {
    const onClose = vi.fn();
    const state = makeState();
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} currentModelReady state={state} />,
    );
    expect(screen.getByText(/currently running/i)).toBeInTheDocument();
    expect(screen.queryByText(/setting up/i)).toBeNull();
  });

  it('current row reads "Setting up…" when the current model is not ready', () => {
    const onClose = vi.fn();
    const state = makeState();
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={THIRD_MODEL} currentModelReady={false} state={state} />,
    );
    expect(screen.getByText(/setting up/i)).toBeInTheDocument();
    expect(screen.queryByText(/currently running/i)).toBeNull();
  });
});

describe('SwitchAIDialog — failure flow with cascade suggestion', () => {
  it('does NOT close on failure; renders the in-dialog error block', async () => {
    const onClose = vi.fn();
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'smoke-failed',
      failedModel: THIRD_MODEL,
      suggestedNext: QWEN,
    }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    // No warning gate any more — Save commits immediately.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/didn't respond as expected on your device/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try qwen3/i })).toBeInTheDocument();
  });

  it('clicking "Try [suggested]" invokes commitWith for the suggested model', async () => {
    const onClose = vi.fn();
    const commitWith = vi.fn(async (): Promise<SwitchAIResult> => ({ success: true }));
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'smoke-failed',
      failedModel: THIRD_MODEL,
      suggestedNext: QWEN,
    }));
    const state = makeState({ commit, commitWith });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try qwen3/i }));
    });

    expect(commitWith).toHaveBeenCalledWith(QWEN.id);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Pick another" clears the failure block but keeps the dialog open', async () => {
    const onClose = vi.fn();
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'smoke-failed',
      failedModel: THIRD_MODEL,
      suggestedNext: QWEN,
    }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(screen.getByRole('button', { name: /pick another/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /pick another/i }));
    expect(screen.queryByText(/didn't respond as expected/i)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders failure UI without a "Try ..." button when cascade is exhausted', async () => {
    const onClose = vi.fn();
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'smoke-failed',
      failedModel: THIRD_MODEL,
      suggestedNext: null,
    }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(screen.getByText(/didn't respond as expected/i)).toBeInTheDocument();
    // No "Try [model name]" cascade button when there's no suggestion. The
    // primary button reads "Try again" (Save retry), so we assert no
    // model-named cascade button (e.g. "Try Eco Reasoning") is present.
    expect(screen.queryByRole('button', { name: /try eco /i })).toBeNull();
    expect(screen.getByRole('button', { name: /pick another/i })).toBeInTheDocument();
  });

  it('load-failed renders the load-specific copy', async () => {
    const onClose = vi.fn();
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'load-failed',
      failedModel: THIRD_MODEL,
      suggestedNext: null,
    }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(screen.getByText(/couldn't get.*running here/i)).toBeInTheDocument();
  });

  it('network-failed shows a connection message, never a hardware verdict or downgrade', async () => {
    const onClose = vi.fn();
    // Even if a suggestion were somehow attached, the network notice must not
    // surface a downgrade — a dropped wifi is not a reason to pick a lesser model.
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'network-failed',
      failedModel: THIRD_MODEL,
      suggestedNext: QWEN,
    }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });

    // Honest connection copy — points at the network, not the device.
    expect(screen.getByText(/connection dropped while downloading/i)).toBeInTheDocument();
    expect(screen.getByText(/not your device/i)).toBeInTheDocument();
    // NOT the load-failed hardware verdict.
    expect(screen.queryByText(/certain hardware configurations/i)).toBeNull();
    expect(screen.queryByText(/couldn't get.*running here/i)).toBeNull();
    // No downgrade CTA — retry is the footer's "Try again", not a lesser model.
    expect(screen.queryByRole('button', { name: /try qwen3/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /pick another/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('insufficient-storage shows the needed-vs-free figures, never a hardware verdict or downgrade', async () => {
    const onClose = vi.fn();
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'insufficient-storage',
      failedModel: LFM2,
      suggestedNext: QWEN,
      storageMessage:
        'Eco needs about 0.8 GB of free space for this model, but only about 0.3 GB is available on this device.',
    }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });

    expect(screen.getByText(/isn't enough free space to download/i)).toBeInTheDocument();
    expect(screen.getByText(/only about 0\.3 GB is available/i)).toBeInTheDocument();
    // A fullish disk is not a hardware verdict.
    expect(screen.queryByText(/certain hardware configurations/i)).toBeNull();
    expect(screen.queryByText(/couldn't get.*running here/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /try qwen3/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calculated-confidence failure uses warmer "closer fit" copy', async () => {
    const onClose = vi.fn();
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'smoke-failed',
      failedModel: THIRD_MODEL,
      suggestedNext: QWEN,
      failedConfidence: 'calculated',
    }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    // Calculated-confidence: softer framing pointing to device fit
    expect(screen.getByText(/closer fit for your device/i)).toBeInTheDocument();
    // Should NOT use the benchmark-style "on your device" terminal phrasing
    expect(screen.queryByText(/didn't respond as expected on your device/i)).toBeNull();
  });

  it('benchmark-confidence failure uses standard "didn\'t respond as expected" copy', async () => {
    const onClose = vi.fn();
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'smoke-failed',
      failedModel: THIRD_MODEL,
      suggestedNext: null,
      failedConfidence: 'benchmark',
    }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(screen.getByText(/didn't respond as expected on your device/i)).toBeInTheDocument();
  });
});

describe('SwitchAIDialog — busy runtime (slice 2a)', () => {
  it('renders a calm status notice with the busy copy — no failure alert, no cascade button', async () => {
    // Slice 3: a busy first surfaces the silent auto-retry wait; the manual
    // BusyNotice is the fallback once the one retry is still busy.
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
        success: false,
        reason: 'busy',
        failedModel: THIRD_MODEL,
        suggestedNext: null,
        busyMessage: 'Eco is preparing a local model. Wait for it to finish before starting another local model task.',
      }));
      const state = makeState({ commit });
      render(
        <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });
      // Advance past the auto-retry so the (still busy) fallback notice shows.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(onClose).not.toHaveBeenCalled();
      // Busy is not a failure: calm status region, not an alert.
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText(/wait for it to finish/i)).toBeInTheDocument();
      // No hardware-failure copy, no cascade suggestion.
      expect(screen.queryByText(/hardware configurations/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /pick another/i })).toBeNull();
      // The footer primary offers the retry.
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SwitchAIDialog — transient-busy auto-retry (slice 3)', () => {
  const AUTO_RETRY_DELAY_MS = 3_000;

  function busyResult(): SwitchAIResult {
    return {
      success: false,
      reason: 'busy',
      failedModel: THIRD_MODEL,
      suggestedNext: null,
      busyMessage: 'A readiness check is already running. Wait for it to finish before starting another local model task.',
    };
  }

  it('shows honest waiting copy then retries once and closes on the retry success', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const commit = vi
        .fn<() => Promise<SwitchAIResult>>()
        .mockResolvedValueOnce(busyResult())
        .mockResolvedValueOnce({ success: true });
      const state = makeState({ commit });
      render(
        <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });
      // Waiting state: honest progress copy, no manual "Try again" fallback yet.
      expect(commit).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/finishing a quick check/i)).toBeInTheDocument();
      expect(screen.queryByText(/wait for it to finish/i)).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAY_MS);
      });
      // The single silent retry succeeded → dialog closes.
      expect(commit).toHaveBeenCalledTimes(2);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/finishing a quick check/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the manual busy notice when still busy after the one auto-retry — and never retries again', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const commit = vi.fn<() => Promise<SwitchAIResult>>().mockResolvedValue(busyResult());
      const state = makeState({ commit });
      render(
        <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAY_MS);
      });

      // Exactly two commits: the original + one auto-retry. Then the manual
      // BusyNotice (calm status, not an alert) with the footer "Try again".
      expect(commit).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/finishing a quick check/i)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText(/wait for it to finish/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();

      // Single-retry cap: further time passing does NOT trigger more retries.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAY_MS * 3);
      });
      expect(commit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT auto-retry a real load failure — it surfaces immediately', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const commit = vi.fn<() => Promise<SwitchAIResult>>().mockResolvedValue({
        success: false,
        reason: 'load-failed',
        failedModel: THIRD_MODEL,
        suggestedNext: null,
      });
      const state = makeState({ commit });
      render(
        <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });
      // Failure copy is shown at once — no waiting state.
      expect(screen.getByText(/couldn't get.*running here/i)).toBeInTheDocument();
      expect(screen.queryByText(/finishing a quick check/i)).toBeNull();

      // No retry fires even after the auto-retry window elapses.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAY_MS * 2);
      });
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelling during the wait aborts the pending auto-retry', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const commit = vi.fn<() => Promise<SwitchAIResult>>().mockResolvedValue(busyResult());
      const state = makeState({ commit });
      render(
        <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });
      expect(screen.getByText(/finishing a quick check/i)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);

      // The retry that was queued behind the delay must not fire after close.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAY_MS * 2);
      });
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SwitchAIDialog — loading progress', () => {
  it('labels the download phase honestly', () => {
    const onClose = vi.fn();
    const state = makeState({ saving: true });
    render(
      <SwitchAIDialog
        open
        onClose={onClose}
        currentModel={LFM2}
        state={state}
        loadProgress={0.3}
        loadPhase="downloading"
      />,
    );
    expect(screen.getByText(/downloading model/i)).toBeInTheDocument();
  });

  it('renders progress indicator when saving and no failure', () => {
    const onClose = vi.fn();
    const state = makeState({ saving: true });
    render(
      <SwitchAIDialog
        open
        onClose={onClose}
        currentModel={LFM2}
        state={state}
        loadProgress={0.45}
        loadPhase="load-start"
      />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/45%/)).toBeInTheDocument();
    expect(screen.getByText(/loading model weights/i)).toBeInTheDocument();
  });

  it('does NOT render progress indicator when not saving', () => {
    const onClose = vi.fn();
    const state = makeState({ saving: false });
    render(
      <SwitchAIDialog
        open
        onClose={onClose}
        currentModel={LFM2}
        state={state}
        loadProgress={0.45}
        loadPhase="load-start"
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders Stop button instead of Cancel when saving with onAbort', () => {
    const onClose = vi.fn();
    const onAbort = vi.fn();
    const state = makeState({ saving: true });
    render(
      <SwitchAIDialog
        open
        onClose={onClose}
        currentModel={LFM2}
        state={state}
        loadProgress={0.3}
        loadPhase="load-start"
        onAbort={onAbort}
      />,
    );
    const stopBtn = screen.getByRole('button', { name: /stop/i });
    expect(stopBtn).toBeInTheDocument();
    // Cancel button should NOT be present when Stop is shown
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    fireEvent.click(stopBtn);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('does NOT render progress indicator when a failure is displayed', () => {
    const onClose = vi.fn();
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({
      success: false,
      reason: 'smoke-failed',
      failedModel: THIRD_MODEL,
      suggestedNext: null,
    }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog
        open
        onClose={onClose}
        currentModel={LFM2}
        state={state}
        loadProgress={1}
        loadPhase="load-finish"
      />,
    );
    // Trigger the failure
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    // After failure, saving is false again (via the mock), so progress is hidden
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('SwitchAIDialog — success path closes the dialog', () => {
  it('closes on successful save (no warning gate)', async () => {
    const onClose = vi.fn();
    const commit = vi.fn(async (): Promise<SwitchAIResult> => ({ success: true }));
    const state = makeState({ commit });
    render(
      <SwitchAIDialog open onClose={onClose} currentModel={LFM2} state={state} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
