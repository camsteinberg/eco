// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Try again on the exhausted surface actually retries — the real gate, the real
 * useLocalAiSetup hook and the real setup runner; only the runner's seams (the
 * slot store, the attempt) are injected.
 *
 * An iPhone whose one model failed lands on the exhausted surface and loads
 * nothing. Pressing Try again must start ONE run that is allowed to retry the
 * failed model, and that run must attempt it. (Found in real Safari: the click's
 * flag was dropped across the reset, and the gate's own mount effect restarted
 * setup without it, landing on the same surface again.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AttemptResult } from '../../../local-ai/lifecycle/setup-cascade';
import type { SetupRunnerOptions } from '../../../local-ai/lifecycle/setup-runner';
import type { SlotState } from '../../../local-ai/lifecycle/slots';
import type { DeviceProfile, ModelConfig, Slot } from '../../../local-ai/types';

const IPHONE: DeviceProfile = {
  browserClass: 'safari', webgpuSupport: 'webgpu', deviceMemoryGB: 0, isMobile: true, override: 'auto', webgpuShaderF16: true,
};
const MOBILE_MLC = 'candidate/qwen2.5-0.5b-mlc';

const harness = vi.hoisted(() => ({
  seams: {} as Record<string, unknown>,
  runs: [] as Array<SetupRunnerOptions | undefined>,
}));

// The real runner, with this test's seams merged in on every run.
vi.mock('../../../local-ai/lifecycle/setup-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../local-ai/lifecycle/setup-runner')>();
  return {
    ...actual,
    executeSetup: (actions: Parameters<typeof actual.executeSetup>[0], options?: SetupRunnerOptions) => {
      harness.runs.push(options);
      return actual.executeSetup(actions, { ...options, seams: { ...harness.seams, ...options?.seams } });
    },
  };
});
vi.mock('../../../hooks/local-ai/useDeviceProfile', () => ({ useDeviceProfile: () => IPHONE }));
vi.mock('../../../local-ai/diagnostics/capture', () => ({
  exportDiagnostics: vi.fn(async () => '{"entries":[]}'),
}));

import { LocalAiSetupGate } from '../LocalAiSetupGate';
import { getModel } from '../../../local-ai/catalog/catalog';
import { clearEvidence, recordEvidence } from '../../../local-ai/evidence/ledger';

const runAttempt = vi.fn(async (_slot: Slot, _model: ModelConfig): Promise<AttemptResult> => ({ ok: true }));

beforeEach(() => {
  localStorage.clear();
  clearEvidence();
  harness.runs.length = 0;
  runAttempt.mockClear();
  const mobile = getModel(MOBILE_MLC)!;
  const errored = { modelId: mobile.id, status: 'error', model: mobile } as unknown as SlotState;
  const empty = { modelId: null, status: 'empty', model: null } as unknown as SlotState;
  harness.seams = {
    bootstrap: vi.fn(async () => {}),
    resolveProfile: vi.fn(async () => IPHONE),
    getSlot: vi.fn((slot: Slot) => (slot === 'eco-fast' ? errored : empty)),
    setSlot: vi.fn(),
    setSlotStatus: vi.fn(),
    runAttempt,
    isModelCached: vi.fn(async () => false),
    waitForNetwork: vi.fn(async () => false),
  };
  // The iPhone's one model failed once on this device.
  recordEvidence({ modelId: MOBILE_MLC, profile: IPHONE, outcome: 'smoke-fail' });
});

describe('LocalAiSetupGate — Try again after the last model failed', () => {
  it('the landing loads nothing; Try again starts one run that attempts the model', async () => {
    render(<LocalAiSetupGate><div>chat</div></LocalAiSetupGate>);

    const tryAgain = await screen.findByRole('button', { name: /try setting up eco again/i });
    expect(runAttempt).not.toHaveBeenCalled();
    expect(harness.runs).toHaveLength(1);

    await act(async () => {
      fireEvent.click(tryAgain);
    });

    await waitFor(() => expect(runAttempt).toHaveBeenCalledTimes(1));
    expect(runAttempt.mock.calls[0]?.[1].id).toBe(MOBILE_MLC);
    await screen.findByText('chat');
    // One run for the landing, exactly one for the click — no double start.
    expect(harness.runs).toHaveLength(2);
    expect(harness.runs[1]?.retryFailed).toBe(true);
  });
});
