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
// Mutable per-test: the records the panel renders (echo-display assertions set it).
let probeRecords: unknown[] = [];
vi.mock('../../../../src/local-ai/diagnostics/sustained-probe', () => ({
  recoverOrphanedMarker: () => null,
  readActiveLevers: () => null,
  loadSustainedProbes: () => probeRecords,
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

// Storage seam for the panel's storage readout + clear-and-retry affordance.
const clearModelMock = vi.fn(async () => {});
vi.mock('../../../../src/local-ai/download/storage', () => ({
  pickStorage: () => ({
    listForModel: async () => [
      { url: 'https://x/api/f.onnx.ecopart.abc.0', sizeBytes: 4 },
    ],
    clearModel: clearModelMock,
  }),
}));

import { fireEvent } from '@testing-library/react';
import { runSustainedProbe } from '../../../../src/local-ai/diagnostics/sustained-probe-runner';
import { SustainedProbePanel } from '../SustainedProbePanel';

const runSustainedProbeMock = vi.mocked(runSustainedProbe);

// Two comboboxes now exist (Model + Context); scope the picker by its label.
// A wrapping <label> around a <select> folds the selected option text into the
// accessible name, so match the label prefix by regex rather than exact string.
async function findModelPicker(): Promise<HTMLElement> {
  return screen.findByRole('combobox', { name: /Model/ });
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

describe('SustainedProbePanel — context + tokens controls', () => {
  beforeEach(() => {
    harnessEnabled = false;
    weightsCached = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Context and Tokens/turn controls', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();
    expect(await screen.findByRole('combobox', { name: /Context/ })).toBeInTheDocument();
    expect(await screen.findByRole('spinbutton', { name: 'Tokens/turn' })).toBeInTheDocument();
  });

  it('forwards the chosen contextMode and targetTokensPerTurn into the run config', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();

    fireEvent.change(await screen.findByRole('combobox', { name: /Context/ }), {
      target: { value: 'fresh' },
    });
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Tokens/turn' }), {
      target: { value: '128' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Run probe' }));

    await waitFor(() => {
      expect(runSustainedProbeMock).toHaveBeenCalledWith(
        expect.objectContaining({ contextMode: 'fresh', targetTokensPerTurn: 128 }),
        expect.anything(),
      );
    });
  });

  // Per-keystroke clamping made these fields unusable: a controlled value that
  // clamped on every change turned "64" into "16" after the first digit and
  // couldn't be cleared. The fix holds free-typed text while focused and clamps
  // only on blur and at run().
  it('lets you type a multi-digit tokens/turn value without per-keystroke clamping', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();
    const input = await screen.findByRole('spinbutton', { name: 'Tokens/turn' });

    // First digit is below the min but must NOT snap to 16 mid-type.
    fireEvent.change(input, { target: { value: '6' } });
    expect(input).toHaveValue(6);
    fireEvent.change(input, { target: { value: '64' } });
    expect(input).toHaveValue(64);

    fireEvent.click(await screen.findByRole('button', { name: 'Run probe' }));
    await waitFor(() => {
      expect(runSustainedProbeMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetTokensPerTurn: 64 }),
        expect.anything(),
      );
    });
  });

  it('lets you clear the tokens/turn field and retype', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();
    const input = await screen.findByRole('spinbutton', { name: 'Tokens/turn' });

    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue(null);
    fireEvent.change(input, { target: { value: '32' } });
    expect(input).toHaveValue(32);
  });

  it('clamps an out-of-range tokens/turn value on blur, not per keystroke', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();
    const input = await screen.findByRole('spinbutton', { name: 'Tokens/turn' });

    fireEvent.change(input, { target: { value: '9999' } });
    expect(input).toHaveValue(9999);
    fireEvent.blur(input);
    expect(input).toHaveValue(512);
  });

  it('lets you type a multi-digit turns value without per-keystroke clamping', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();
    const input = await screen.findByRole('spinbutton', { name: 'Turns' });

    // "12" would snap to "1" then jump under per-keystroke clamping.
    fireEvent.change(input, { target: { value: '1' } });
    expect(input).toHaveValue(1);
    fireEvent.change(input, { target: { value: '12' } });
    expect(input).toHaveValue(12);
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue(null);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(30);
  });
});

describe('SustainedProbePanel — weights staging', () => {
  beforeEach(() => {
    harnessEnabled = false;
    weightsCached = true;
    localStorage.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
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

  it('reports the death point of a previous download that never finished (devtools-less diagnostics)', async () => {
    // A WebKit tab-kill leaves a `done:false` attempt record behind; on the next
    // mount the panel reads it and tells the user where the download stopped so
    // they can retest without devtools. Sizes are in bytes; the line renders MB.
    // A death note is only meaningful while the weights are genuinely missing —
    // so this genuine-death path requires the cache check to resolve absent.
    weightsCached = false;
    localStorage.setItem(
      'eco-probe-weights-attempt-v1',
      JSON.stringify({
        modelId: 'local/model-a',
        startedAt: new Date().toISOString(),
        lastLoaded: 120 * 1024 * 1024,
        total: 543 * 1024 * 1024,
        done: false,
      }),
    );

    render(<SustainedProbePanel />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Previous weights download died at 120 of 543 MB — resume continues from persisted chunks.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('offers clear-and-retry on an insufficient-storage failure and retries from clean', async () => {
    // Stranded parts from a dead attempt occupy quota the preflight can't
    // always credit (observed on iOS Safari) — freeing the model's storage and
    // retrying is the guaranteed unblock, so the panel offers exactly that.
    weightsCached = false;
    const quotaError = new Error('Eco needs about 0.5 GB of free space for this model.');
    quotaError.name = 'InsufficientStorageError';
    downloadModelMock.mockRejectedValueOnce(quotaError);
    render(<SustainedProbePanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Download weights' }));
    const retry = await screen.findByRole('button', { name: 'Free this model’s storage and retry' });

    fireEvent.click(retry);
    await waitFor(() => {
      expect(clearModelMock).toHaveBeenCalledTimes(1);
    });
    // The retry re-enters the normal download flow (second downloadModel call).
    await waitFor(() => {
      expect(downloadModelMock).toHaveBeenCalledTimes(2);
    });
  });

  it('does not report a previous download that completed (done:true record)', async () => {
    localStorage.setItem(
      'eco-probe-weights-attempt-v1',
      JSON.stringify({
        modelId: 'local/model-a',
        startedAt: new Date().toISOString(),
        lastLoaded: 543 * 1024 * 1024,
        total: 543 * 1024 * 1024,
        done: true,
      }),
    );

    render(<SustainedProbePanel />);
    await findModelPicker();
    await waitFor(() => {
      expect(screen.queryByText(/Previous weights download died/)).not.toBeInTheDocument();
    });
  });

  it('does not resurrect a death note when weights are actually cached, and resolves the stale record', async () => {
    // The immortal-banner bug: a `done:false` record matched the pick and the
    // banner rendered forever, even after weights arrived via some other path.
    // The note is only meaningful while weights are missing — so when the cache
    // check resolves present, no banner shows and the stale record is resolved
    // (marked done) so it can never resurrect.
    weightsCached = true;
    localStorage.setItem(
      'eco-probe-weights-attempt-v1',
      JSON.stringify({
        modelId: 'local/model-a',
        startedAt: new Date().toISOString(),
        lastLoaded: 120 * 1024 * 1024,
        total: 543 * 1024 * 1024,
        done: false,
      }),
    );

    render(<SustainedProbePanel />);
    await findModelPicker();

    // The cache check resolves present, at which point the effect resolves the
    // stale record. Wait for that write, then assert the banner never showed.
    await waitFor(() => {
      const raw = localStorage.getItem('eco-probe-weights-attempt-v1');
      expect(raw).not.toBeNull();
      expect((JSON.parse(raw as string) as { done: boolean }).done).toBe(true);
    });
    expect(screen.queryByText(/Previous weights download died/)).not.toBeInTheDocument();
  });
});

// Zero-click cells: real Safari has no scriptable clicks, so a measurement cell
// is described entirely in the URL and the panel arms itself from it.
describe('SustainedProbePanel — cell-via-URL levers', () => {
  function setSearch(search: string): void {
    window.history.replaceState({}, '', `/${search}`);
  }

  beforeEach(() => {
    harnessEnabled = false;
    weightsCached = true;
    probeRecords = [];
    localStorage.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    probeRecords = [];
    localStorage.clear();
    setSearch(''); // reset location so params never leak between tests
  });

  it('prefills turns / tokens / context / cooldown from the URL', async () => {
    setSearch('?eco-probe-turns=12&eco-probe-tokens=64&eco-probe-context=fresh&eco-probe-cooldown-ms=5000');
    render(<SustainedProbePanel />);
    await findModelPicker();

    expect(await screen.findByRole('spinbutton', { name: 'Turns' })).toHaveValue(12);
    expect(await screen.findByRole('spinbutton', { name: 'Tokens/turn' })).toHaveValue(64);
    expect(await screen.findByRole('combobox', { name: /Context/ })).toHaveValue('fresh');
    expect(await screen.findByRole('spinbutton', { name: 'Cooldown ms' })).toHaveValue(5000);
  });

  it('clamps out-of-range URL values into the field bounds', async () => {
    setSearch('?eco-probe-turns=999&eco-probe-tokens=1&eco-probe-cooldown-ms=999999');
    render(<SustainedProbePanel />);
    await findModelPicker();

    expect(await screen.findByRole('spinbutton', { name: 'Turns' })).toHaveValue(30);
    expect(await screen.findByRole('spinbutton', { name: 'Tokens/turn' })).toHaveValue(16);
    expect(await screen.findByRole('spinbutton', { name: 'Cooldown ms' })).toHaveValue(60000);
  });

  it('prefills idle-observe and heartbeat from the URL, clamping the window', async () => {
    setSearch('?eco-probe-idle-observe-s=9999&eco-probe-heartbeat=raf');
    render(<SustainedProbePanel />);
    await findModelPicker();

    expect(await screen.findByRole('spinbutton', { name: 'Idle observe s' })).toHaveValue(600);
    expect(await screen.findByRole('combobox', { name: 'Heartbeat' })).toHaveValue('raf');
  });

  it('rejects an unknown heartbeat value and keeps the control at none', async () => {
    setSearch('?eco-probe-heartbeat=warp');
    render(<SustainedProbePanel />);
    await findModelPicker();

    expect(await screen.findByRole('combobox', { name: 'Heartbeat' })).toHaveValue('none');
  });

  it('selects a valid model id from the URL', async () => {
    harnessEnabled = true; // makes the eval candidate a second, valid pick
    setSearch('?eco-probe-model=candidate/qwen3-0.6b-q4');
    render(<SustainedProbePanel />);

    const picker = await findModelPicker();
    await waitFor(() => expect(picker).toHaveValue('candidate/qwen3-0.6b-q4'));
  });

  it('rejects an unknown model id from the URL and keeps the default pick', async () => {
    setSearch('?eco-probe-model=does/not-exist');
    render(<SustainedProbePanel />);

    const picker = await findModelPicker();
    await waitFor(() => expect(picker).toHaveValue('local/model-a'));
  });

  it('autorun fires the run exactly once when weights resolve cached', async () => {
    weightsCached = true;
    setSearch('?eco-probe-autorun=1');
    render(<SustainedProbePanel />);

    await waitFor(() => expect(runSustainedProbeMock).toHaveBeenCalledTimes(1));
    // A re-render must not re-fire it (fire-once ref).
    await new Promise((r) => setTimeout(r, 20));
    expect(runSustainedProbeMock).toHaveBeenCalledTimes(1);
  });

  it('autorun stays inert when weights are missing (a probe never downloads)', async () => {
    weightsCached = false;
    setSearch('?eco-probe-autorun=1');
    render(<SustainedProbePanel />);

    // Weights are missing — the download affordance appears, but no run fires and
    // no download is triggered (autofetch was not armed).
    await screen.findByRole('button', { name: 'Download weights' });
    await new Promise((r) => setTimeout(r, 30));
    expect(runSustainedProbeMock).not.toHaveBeenCalled();
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it('autofetch fires the weights download exactly once when weights are missing', async () => {
    weightsCached = false;
    setSearch('?eco-probe-autofetch=1');
    render(<SustainedProbePanel />);

    await waitFor(() => expect(downloadModelMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(downloadModelMock).toHaveBeenCalledTimes(1);
  });
});

describe('SustainedProbePanel — cooldown control', () => {
  beforeEach(() => {
    harnessEnabled = false;
    weightsCached = true;
    probeRecords = [];
    localStorage.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    probeRecords = [];
    localStorage.clear();
  });

  it('renders the Cooldown ms control defaulting to 0', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();
    expect(await screen.findByRole('spinbutton', { name: 'Cooldown ms' })).toHaveValue(0);
  });

  it('forwards the chosen cooldownMs into the run config', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();

    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Cooldown ms' }), {
      target: { value: '5000' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Run probe' }));

    await waitFor(() => {
      expect(runSustainedProbeMock).toHaveBeenCalledWith(
        expect.objectContaining({ cooldownMs: 5000 }),
        expect.anything(),
      );
    });
  });

  it('defaults cooldownMs to 0 in the run config when the field is untouched', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();
    fireEvent.click(await screen.findByRole('button', { name: 'Run probe' }));

    await waitFor(() => {
      expect(runSustainedProbeMock).toHaveBeenCalledWith(
        expect.objectContaining({ cooldownMs: 0 }),
        expect.anything(),
      );
    });
  });

  it('echoes a non-zero cooldown on a completed record', async () => {
    probeRecords = [
      {
        version: 1,
        recordedAt: '2026-07-18T00:00:00.000Z',
        modelId: 'local/model-a',
        backend: 'wasm',
        outcome: 'completed',
        turnsRequested: 3,
        turnsCompleted: 3,
        targetTokensPerTurn: 200,
        levers: { ortArtifact: null, numThreads: null, forceWasm: false },
        contextMode: 'growing',
        cooldownMs: 5000,
        crossOriginIsolated: true,
        memoryApi: { performanceMemory: true, measureUserAgent: false },
        turns: [],
        samples: [],
        peakUsedJSHeapMB: 512,
        error: null,
      },
    ];
    render(<SustainedProbePanel />);
    await findModelPicker();
    expect(await screen.findByText('Cooldown')).toBeInTheDocument();
    expect(await screen.findByText('5000ms')).toBeInTheDocument();
  });

  it('omits the cooldown row when the record ran back-to-back (0 / absent)', async () => {
    probeRecords = [
      {
        version: 1,
        recordedAt: '2026-07-18T00:00:00.000Z',
        modelId: 'local/model-a',
        backend: 'wasm',
        outcome: 'completed',
        turnsRequested: 3,
        turnsCompleted: 3,
        targetTokensPerTurn: 200,
        levers: { ortArtifact: null, numThreads: null, forceWasm: false },
        contextMode: 'growing',
        cooldownMs: 0,
        crossOriginIsolated: true,
        memoryApi: { performanceMemory: true, measureUserAgent: false },
        turns: [],
        samples: [],
        peakUsedJSHeapMB: 512,
        error: null,
      },
    ];
    render(<SustainedProbePanel />);
    await findModelPicker();
    await waitFor(() => expect(screen.getByText('Backend')).toBeInTheDocument());
    expect(screen.queryByText('Cooldown')).not.toBeInTheDocument();
  });
});

describe('SustainedProbePanel — idle-observe control', () => {
  beforeEach(() => {
    harnessEnabled = false;
    weightsCached = true;
    probeRecords = [];
    localStorage.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    probeRecords = [];
    localStorage.clear();
  });

  it('renders the Idle observe control at 0 and the Heartbeat control at none', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();
    expect(await screen.findByRole('spinbutton', { name: 'Idle observe s' })).toHaveValue(0);
    expect(await screen.findByRole('combobox', { name: 'Heartbeat' })).toHaveValue('none');
  });

  it('forwards the chosen window and heartbeat into the run config', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();

    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Idle observe s' }), {
      target: { value: '120' },
    });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Heartbeat' }), {
      target: { value: 'compute' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Run probe' }));

    await waitFor(() => {
      expect(runSustainedProbeMock).toHaveBeenCalledWith(
        expect.objectContaining({ idleObserveSeconds: 120, heartbeat: 'compute' }),
        expect.anything(),
      );
    });
  });

  it('defaults the run config to no observe window and heartbeat none when untouched', async () => {
    render(<SustainedProbePanel />);
    await findModelPicker();
    fireEvent.click(await screen.findByRole('button', { name: 'Run probe' }));

    await waitFor(() => {
      expect(runSustainedProbeMock).toHaveBeenCalledWith(
        expect.objectContaining({ idleObserveSeconds: 0, heartbeat: 'none' }),
        expect.anything(),
      );
    });
  });

  it('echoes the observe cell on a record (survived/requested + heartbeat)', async () => {
    probeRecords = [
      {
        version: 1,
        recordedAt: '2026-07-20T00:00:00.000Z',
        modelId: 'local/model-a',
        backend: 'webgpu',
        outcome: 'killed',
        turnsRequested: 1,
        turnsCompleted: 1,
        targetTokensPerTurn: 64,
        levers: { ortArtifact: null, numThreads: null, forceWasm: false },
        contextMode: 'fresh',
        idleObserveSeconds: 120,
        idleObservedSeconds: 5,
        heartbeat: 'none',
        crossOriginIsolated: true,
        memoryApi: { performanceMemory: false, measureUserAgent: false },
        turns: [],
        samples: [],
        peakUsedJSHeapMB: null,
        error: 'Tab was killed during the post-run idle-observe window — survived ~5s of 120s at heartbeat=none, after completing all 1/1 turns.',
      },
    ];
    render(<SustainedProbePanel />);
    await findModelPicker();
    expect(await screen.findByText('Idle observe')).toBeInTheDocument();
    expect(await screen.findByText('5s/120s survived · heartbeat=none')).toBeInTheDocument();
  });

  it('omits the observe row when no window was requested', async () => {
    probeRecords = [
      {
        version: 1,
        recordedAt: '2026-07-20T00:00:00.000Z',
        modelId: 'local/model-a',
        backend: 'wasm',
        outcome: 'completed',
        turnsRequested: 3,
        turnsCompleted: 3,
        targetTokensPerTurn: 200,
        levers: { ortArtifact: null, numThreads: null, forceWasm: false },
        contextMode: 'growing',
        crossOriginIsolated: true,
        memoryApi: { performanceMemory: true, measureUserAgent: false },
        turns: [],
        samples: [],
        peakUsedJSHeapMB: 512,
        error: null,
      },
    ];
    render(<SustainedProbePanel />);
    await findModelPicker();
    await waitFor(() => expect(screen.getByText('Backend')).toBeInTheDocument());
    expect(screen.queryByText('Idle observe')).not.toBeInTheDocument();
  });
});
