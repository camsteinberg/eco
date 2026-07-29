// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The everyday-use instrument, as reached from the diagnostics panel.
 *
 * PR #91 shipped `EVERYDAY_USE_PROBES` and `EVERYDAY_ARMS` with no route into
 * the only surface that can run them against a real loaded model. These tests
 * hold that route open at its two real seams — `runEval` (what the harness is
 * actually asked to run) and `compareEverydayArms` (the module that decides
 * whether a result may be reported at all).
 *
 * The expectations are derived from the real tables (`EVERYDAY_USE_PROBES`,
 * `EVERYDAY_ARMS`) rather than restated here, so adding a probe or an arm cell
 * updates what is asserted instead of quietly escaping it.
 */

import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVERYDAY_ARMS,
  getEverydayArm,
} from '../../../../src/local-ai/eval/everyday-arms';
import { EVERYDAY_USE_PROBES } from '../../../../src/local-ai/eval/everyday-probes';
import type { EvalRunConfig } from '../../../../src/local-ai/eval/harness';
import type {
  EvalEverydayArmId,
  EvalRun,
  EvalRunConfigFingerprint,
  SamplingMode,
} from '../../../../src/local-ai/eval/types';

// ── next/navigation: drive the URL via a mutable param map ──
let currentParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => currentParams,
}));

// ── Catalog + candidate picker (deterministic model list) ──
vi.mock('../../../../src/local-ai/catalog/catalog', () => ({
  getCatalog: () => [
    { id: 'local/model-a', friendlyName: 'Model A', sizeGB: 1, runtime: 'transformers' },
  ],
}));
vi.mock('../../../../src/local-ai/eval/eval-candidates', () => ({
  getEvalCandidateModels: () => [],
}));

const DEVICE = {
  profileKey: 'test',
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceClass: 'high-memory-laptop',
};

// ── Harness: capture each runEval call ──
const runEvalMock = vi.fn(
  async (config: EvalRunConfig): Promise<EvalRun> => ({
    schemaVersion: 1,
    runId: 'run-autorun',
    label: config.label,
    startedAt: '2026-07-27T00:00:00.000Z',
    finishedAt: '2026-07-27T00:01:00.000Z',
    device: DEVICE,
    results: [],
  }),
);
vi.mock('../../../../src/local-ai/eval/harness', () => ({
  runEval: (config: EvalRunConfig) => runEvalMock(config),
}));

// ── Storage: a mutable in-memory run list ──
let savedRuns: EvalRun[] = [];
vi.mock('../../../../src/local-ai/eval/storage', () => ({
  loadEvalRuns: () => savedRuns,
  setJudgeScores: () => true,
  buildJudgeSkeleton: () => [],
  exportEvalRuns: () => '{}',
  clearEvalRuns: () => {},
}));

// `aggregate`, `everyday-arms` and `everyday-probes` are deliberately NOT mocked
// — the refusals under test are the real ones.
import { EvalHarnessPanel } from '../EvalHarnessPanel';

function fingerprint(
  everydayArm: EvalEverydayArmId | undefined,
  samplingMode: SamplingMode,
): EvalRunConfigFingerprint {
  return {
    messageTopology: 'production-user-turn-hints',
    samplingMode,
    samplesPerProbe: 1,
    maxTokensCap: 512,
    perGenerationTimeoutMs: 60_000,
    includeResearchArms: false,
    ...(everydayArm ? { everydayArm } : {}),
    promptCount: 40,
    promptSetHash: 'hash',
    compositionEra: 'era',
    harnessVersion: 1,
  };
}

function savedRun(
  runId: string,
  everydayArm: EvalEverydayArmId | undefined,
  samplingMode: SamplingMode = 'sampled',
): EvalRun {
  return {
    schemaVersion: 1,
    runId,
    label: everydayArm ?? 'unstamped',
    startedAt: '2026-07-27T00:00:00.000Z',
    finishedAt: '2026-07-27T00:01:00.000Z',
    device: DEVICE,
    config: fingerprint(everydayArm, samplingMode),
    results: [],
  };
}

function url(extra: string): URLSearchParams {
  return new URLSearchParams(
    `eco-diagnostics=1&eco-eval-autorun=1&eco-eval-models=local/model-a&${extra}`,
  );
}

async function lastConfig(): Promise<EvalRunConfig> {
  await waitFor(() => {
    expect(runEvalMock).toHaveBeenCalledTimes(1);
  });
  return runEvalMock.mock.calls[0]![0];
}

/** Let the mount + autorun effects settle when nothing is expected to happen. */
async function settle(): Promise<void> {
  await screen.findByText(/Model A/);
  await act(async () => {
    await Promise.resolve();
  });
}

const EVERYDAY_PROBE_IDS = EVERYDAY_USE_PROBES.map((p) => p.id);

describe('EvalHarnessPanel — everyday-use probes are reachable', () => {
  beforeEach(() => {
    currentParams = new URLSearchParams();
    savedRuns = [];
    runEvalMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs exactly the everyday probe set for eco-eval-categories=everyday-use', async () => {
    currentParams = url('eco-eval-categories=everyday-use');
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    // Exactly the checked-in set, in corpus order — not "at least N".
    expect(config.promptIds).toEqual(EVERYDAY_PROBE_IDS);
    // They are derived, not in the harness's pool, so they must ride along.
    expect(config.extraPrompts).toEqual([...EVERYDAY_USE_PROBES]);
  });

  it('carries only the everyday probes a prompt-id subset actually named', async () => {
    const [first, second] = EVERYDAY_PROBE_IDS;
    currentParams = url(`eco-eval-prompts=${first!},${second!}`);
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    expect(config.promptIds).toEqual([first, second]);
    expect(config.extraPrompts?.map((p) => p.id)).toEqual([first, second]);
  });

  it('leaves a non-everyday selection exactly as it was — no probes, no extras', async () => {
    currentParams = url('eco-eval-prompts=if4');
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    expect(config.promptIds).toEqual(['if4']);
    expect(config.extraPrompts).toBeUndefined();
  });
});

describe('EvalHarnessPanel — the everyday A/B arms', () => {
  beforeEach(() => {
    currentParams = new URLSearchParams();
    savedRuns = [];
    runEvalMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(EVERYDAY_ARMS.map((arm) => [arm.id]))(
    'stamps the %s arm on the run from eco-eval-everyday-arm',
    async (armId) => {
      currentParams = url(`eco-eval-everyday-arm=${armId}`);
      render(<EvalHarnessPanel />);

      expect((await lastConfig()).everydayArm).toBe(armId);
    },
  );

  it('ignores an unknown arm id rather than stamping it', async () => {
    currentParams = url('eco-eval-everyday-arm=not-an-arm');
    render(<EvalHarnessPanel />);

    expect((await lastConfig()).everydayArm).toBeUndefined();
  });

  it('leaves the arm unset when the parameter is absent', async () => {
    currentParams = url('eco-eval-label=plain');
    render(<EvalHarnessPanel />);

    expect((await lastConfig()).everydayArm).toBeUndefined();
  });
});

describe('★ EvalHarnessPanel — greedy decode cannot be paired with an n-gram arm', () => {
  beforeEach(() => {
    currentParams = new URLSearchParams();
    savedRuns = [];
    runEvalMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Greedy collapses options to { temperature: 0, maxTokens } and drops
  // noRepeatNgramSize for EVERY arm, so an ngram-off arm run greedily is
  // byte-identical to its control. The split below is read off the arm table,
  // so a new cell lands on whichever side its own `ngramBan` puts it.
  const ngramArms = EVERYDAY_ARMS.filter((a) => a.ngramBan === 'off').map((a) => a.id);
  const otherArms = EVERYDAY_ARMS.filter((a) => a.ngramBan !== 'off').map((a) => a.id);

  it('the arm table still has both an n-gram side and a non-n-gram side', () => {
    expect(ngramArms.length).toBeGreaterThan(0);
    expect(otherArms.length).toBeGreaterThan(0);
  });

  it.each(ngramArms.map((id) => [id]))(
    'refuses to launch %s under greedy, and says why',
    async (armId) => {
      currentParams = url(`eco-eval-everyday-arm=${armId}&eco-eval-sampling=greedy`);
      render(<EvalHarnessPanel />);

      expect(
        await screen.findByText(/noRepeatNgramSize.*greedy decode already drops it/i),
      ).toBeInTheDocument();
      await act(async () => {
        await Promise.resolve();
      });
      expect(runEvalMock).not.toHaveBeenCalled();
    },
  );

  it.each(otherArms.map((id) => [id]))(
    'still launches %s under greedy — that pairing measures something',
    async (armId) => {
      currentParams = url(`eco-eval-everyday-arm=${armId}&eco-eval-sampling=greedy`);
      render(<EvalHarnessPanel />);

      const config = await lastConfig();
      expect(config.everydayArm).toBe(armId);
      expect(config.samplingMode).toBe('greedy');
    },
  );

  it.each(ngramArms.map((id) => [id]))(
    'launches %s when sampled, which is where the switch is measurable',
    async (armId) => {
      currentParams = url(`eco-eval-everyday-arm=${armId}`);
      render(<EvalHarnessPanel />);

      expect((await lastConfig()).everydayArm).toBe(armId);
    },
  );
});

describe('★ EvalHarnessPanel — the A/B comparison reports refusals on screen', () => {
  beforeEach(() => {
    currentParams = new URLSearchParams('eco-diagnostics=1');
    savedRuns = [];
    runEvalMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function place(runId: string): Promise<void> {
    const user = userEvent.setup();
    const box = await screen.findByRole('checkbox', {
      name: `Place ${runId} in the everyday A/B`,
    });
    await user.click(box);
  }

  it('refuses a treatment arm with no control, naming the missing control', async () => {
    savedRuns = [savedRun('run-treatment', 'no-add-context')];
    render(<EvalHarnessPanel />);

    await place('run-treatment');

    expect(await screen.findByText(/no control-arm run present/i)).toBeInTheDocument();
  });

  it('refuses a run that carries no arm stamp', async () => {
    savedRuns = [savedRun('run-plain', undefined)];
    render(<EvalHarnessPanel />);

    await place('run-plain');

    expect(await screen.findByText(/carries no everydayArm stamp/i)).toBeInTheDocument();
  });

  it('refuses an n-gram arm recorded under greedy, even alongside a control', async () => {
    // The launch guard stops this being made here; a run imported from another
    // origin, or recorded before that guard existed, still can be. The refusal
    // has to reach the operator either way.
    savedRuns = [
      savedRun('run-control', 'control'),
      savedRun('run-greedy-ngram', 'ngram-off', 'greedy'),
    ];
    render(<EvalHarnessPanel />);

    await place('run-control');
    await place('run-greedy-ngram');

    expect(
      await screen.findByText(/the n-gram switch cannot be measured here/i),
    ).toBeInTheDocument();
  });

  it('reports a delta once a control is present', async () => {
    savedRuns = [savedRun('run-control', 'control'), savedRun('run-treatment', 'no-add-context')];
    render(<EvalHarnessPanel />);

    await place('run-control');
    await place('run-treatment');

    // A delta table rendered (these stub runs share no model rows, which is
    // what that table says) — and no refusal anywhere on the surface.
    expect(
      await screen.findByText(/No models are present in both runs/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no control-arm run present/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Control arm only/i)).not.toBeInTheDocument();
  });
});

describe('EvalHarnessPanel — default behaviour is unchanged', () => {
  beforeEach(() => {
    currentParams = new URLSearchParams();
    savedRuns = [];
    runEvalMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The exact key set a plain autorun produced before any of this existed.
   * Pinned as a LIST, so a new field leaking into the default path fails here
   * rather than riding along unnoticed.
   */
  it('sends the same run config keys as before for a plain autorun', async () => {
    currentParams = url('eco-eval-label=plain');
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    expect(Object.keys(config).sort()).toEqual([
      'label',
      'maxTokensCap',
      'modelIds',
      'onProgress',
      'samplesPerProbe',
      'samplingMode',
      'signal',
    ]);
  });

  it('does not autorun at all without eco-eval-autorun', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-models=local/model-a&eco-eval-everyday-arm=ngram-off&eco-eval-categories=everyday-use',
    );
    render(<EvalHarnessPanel />);

    await settle();
    expect(runEvalMock).not.toHaveBeenCalled();
  });

  it('every arm the table declares is reachable, and none is silently dropped', () => {
    for (const arm of EVERYDAY_ARMS) {
      expect(getEverydayArm(arm.id)).toBe(arm);
    }
  });
});
