// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Focused behavior test for the sustained-probe panel's model picker: the
 * eval-lane candidates (A-3 measurement cells like the q4 load-peak build) are
 * offered ONLY when the validation harness is enabled, and are marked " (eval)"
 * so they read as non-catalog. Harness state is mocked at its real seam
 * (`isValidationHarnessEnabled`), so the assertion is about wired behavior.
 */

import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mount-effect dependencies (all dynamically imported inside the panel) ──
vi.mock('../../../../src/local-ai/diagnostics/sustained-probe', () => ({
  recoverOrphanedMarker: () => null,
  readActiveLevers: () => null,
  loadSustainedProbes: () => [],
  clearSustainedProbes: () => {},
}));

vi.mock('../../../../src/local-ai/catalog/catalog', () => ({
  getCatalog: () => [
    {
      id: 'local/model-a',
      friendlyName: 'Model A',
      artifact: { hfId: 'x/model-a', revision: 'r', files: ['onnx/model_q4f16.onnx'] },
    },
  ],
  getModel: (id: string) =>
    id === 'local/model-a' ? { id, friendlyName: 'Model A' } : undefined,
}));

vi.mock('../../../../src/local-ai/eval/eval-candidates', () => ({
  getEvalCandidateModels: () => [
    {
      id: 'candidate/qwen3-0.6b-q4',
      friendlyName: 'Qwen3 0.6B (q4)',
      artifact: { hfId: 'onnx-community/Qwen3-0.6B-ONNX', revision: 'r', files: ['onnx/model_q4.onnx'] },
    },
  ],
  getEvalCandidateModel: (id: string) =>
    id === 'candidate/qwen3-0.6b-q4' ? { id, friendlyName: 'Qwen3 0.6B (q4)' } : null,
}));

vi.mock('../../../../src/local-ai/lifecycle/slots', () => ({
  SLOTS: ['eco-fast', 'eco-smart'],
  getSlot: () => ({ status: 'empty', modelId: null }),
}));

// The harness toggle under test — driven per-test via a mutable flag.
let harnessEnabled = false;
vi.mock('../../../../src/lib/validation-harness', () => ({
  isValidationHarnessEnabled: () => harnessEnabled,
}));

// ── Weights-staging seams (bootstrap, cached-check, download) ──
vi.mock('../../../../src/local-ai/bootstrap', () => ({
  bootstrapLocalAi: async () => {},
}));

// Mutable per-test: whether the picked model's weights verify as cached.
let weightsCached = true;
vi.mock('../../../../src/local-ai/diagnostics/sustained-probe-runner', () => ({
  areProbeWeightsCached: async () => weightsCached,
  runSustainedProbe: vi.fn(),
}));

const downloadModelMock = vi.fn(async () => {
  weightsCached = true;
  return { modelId: 'local/model-a', bytesDownloaded: 1, filesFetched: 1, filesSkipped: 0 };
});
vi.mock('../../../../src/local-ai/download/download', () => ({
  downloadModel: (...args: unknown[]) => downloadModelMock(...(args as [])),
}));

vi.mock('../../../../src/local-ai/download/progress', () => ({
  ProgressTracker: class {
    subscribe() {
      return () => {};
    }
  },
}));

import { fireEvent } from '@testing-library/react';
import { SustainedProbePanel } from '../SustainedProbePanel';

async function findModelPicker(): Promise<HTMLElement> {
  return screen.findByRole('combobox');
}

describe('SustainedProbePanel — model picker', () => {
  beforeEach(() => {
    harnessEnabled = false;
    weightsCached = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists only catalog models when the validation harness is disabled', async () => {
    harnessEnabled = false;
    render(<SustainedProbePanel />);

    const picker = await findModelPicker();
    await waitFor(() => {
      expect(within(picker).getByRole('option', { name: 'Model A' })).toBeInTheDocument();
    });
    expect(within(picker).queryByRole('option', { name: /\(eval\)/ })).not.toBeInTheDocument();
  });

  it('appends the eval-lane candidates, marked (eval), when the harness is enabled', async () => {
    harnessEnabled = true;
    render(<SustainedProbePanel />);

    const picker = await findModelPicker();
    await waitFor(() => {
      expect(
        within(picker).getByRole('option', { name: 'Qwen3 0.6B (q4) (eval)' }),
      ).toBeInTheDocument();
    });
    // Catalog models still present; the candidate rides alongside them.
    expect(within(picker).getByRole('option', { name: 'Model A' })).toBeInTheDocument();
  });
});

describe('SustainedProbePanel — weights staging', () => {
  beforeEach(() => {
    harnessEnabled = false;
    weightsCached = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers no download affordance when the picked model verifies as cached', async () => {
    weightsCached = true;
    render(<SustainedProbePanel />);
    await findModelPicker();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Download weights' })).not.toBeInTheDocument();
    });
  });

  it('surfaces missing weights and downloads them through the real seam on request', async () => {
    // The probe run never downloads weights, and a compatibility-declined
    // device (WebKit-mobile) cannot stage them through the normal journey —
    // this affordance is that device's only on-ramp to an instrumented run.
    weightsCached = false;
    render(<SustainedProbePanel />);

    const button = await screen.findByRole('button', { name: 'Download weights' });
    expect(screen.getByText('Weights for this model are not on this device.')).toBeInTheDocument();

    fireEvent.click(button);
    await waitFor(() => {
      expect(downloadModelMock).toHaveBeenCalledTimes(1);
    });
    // Completion flips the panel to ready: staging row gone, status line shown.
    await waitFor(() => {
      expect(screen.getByText('Weights ready — run the probe.')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Download weights' })).not.toBeInTheDocument();
  });
});
