// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Focused behavior tests for the eval-harness diagnostics panel's two W1b
 * enablers: the `?eco-eval-autorun=1` URL trigger and the judge-score backfill
 * control. Both are mocked at their real seams — `runEval` (the harness boundary
 * the autorun must reach) and `setJudgeScores` (the storage writer) — so the
 * assertions are about real wired behavior, not implementation details.
 */

import '@testing-library/jest-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalRunConfig } from '../../../../src/local-ai/eval/harness';
import type { EvalRun } from '../../../../src/local-ai/eval/types';

// ── next/navigation: drive the URL via a mutable param map ──
let currentParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => currentParams,
}));

// ── Catalog + candidate picker (deterministic two-model list) ──
vi.mock('../../../../src/local-ai/catalog/catalog', () => ({
  getCatalog: () => [
    { id: 'local/model-a', friendlyName: 'Model A', sizeGB: 1, runtime: 'transformers' },
  ],
}));
vi.mock('../../../../src/local-ai/eval/eval-candidates', () => ({
  getEvalCandidateModels: () => [
    { id: 'candidate/model-b', friendlyName: 'Model B', sizeGB: 2, runtime: 'transformers' },
  ],
}));

// ── Harness: capture each runEval call ──
const runEvalMock = vi.fn(
  async (config: EvalRunConfig): Promise<EvalRun> => ({
    schemaVersion: 1,
    runId: 'run-autorun',
    label: config.label,
    startedAt: '2026-06-07T00:00:00.000Z',
    finishedAt: '2026-06-07T00:01:00.000Z',
    device: {
      profileKey: 'test',
      browserClass: 'chromium',
      webgpuSupport: 'webgpu',
      deviceClass: 'high-memory-laptop',
    },
    results: [],
  }),
);
vi.mock('../../../../src/local-ai/eval/harness', () => ({
  runEval: (config: EvalRunConfig) => runEvalMock(config),
}));

// ── Storage: an in-memory run + a capturing setJudgeScores ──
const SELECTED_RUN: EvalRun = {
  schemaVersion: 1,
  runId: 'run-1',
  label: 'baseline',
  startedAt: '2026-06-06T00:00:00.000Z',
  finishedAt: '2026-06-06T00:01:00.000Z',
  device: {
    profileKey: 'test',
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceClass: 'high-memory-laptop',
  },
  results: [],
};
const setJudgeScoresMock = vi.fn((_runId: string, _updates: unknown): boolean => true);
vi.mock('../../../../src/local-ai/eval/storage', () => ({
  loadEvalRuns: () => [SELECTED_RUN],
  setJudgeScores: (runId: string, updates: unknown) => setJudgeScoresMock(runId, updates),
  buildJudgeSkeleton: () => [
    { promptId: 'reasoning-1', modelId: 'candidate/model-b', needs: ['coherence', 'taskFit'] },
  ],
  exportEvalRuns: () => '{}',
  clearEvalRuns: () => {},
}));

// ── Aggregate: scorecard build is irrelevant here; stub to a stable shape ──
vi.mock('../../../../src/local-ai/eval/aggregate', () => ({
  buildScorecard: () => ({
    runId: 'run-1',
    label: 'baseline',
    device: SELECTED_RUN.device,
    models: [],
  }),
  diffScorecards: () => null,
  compareModels: () => null,
}));

import { EvalHarnessPanel } from '../EvalHarnessPanel';

/**
 * The scorecard run picker — the first combobox carrying a `run-1` option.
 * Targeted by content (not list index) so unrelated selects on the panel — e.g.
 * the decode-mode control — can be added without breaking these tests.
 */
async function findRunPicker(): Promise<HTMLElement> {
  const comboboxes = await screen.findAllByRole('combobox');
  const picker = comboboxes.find((c) => within(c).queryByRole('option', { name: /run-1/ }));
  if (!picker) throw new Error('run picker (combobox with a run-1 option) not found');
  return picker;
}

describe('EvalHarnessPanel — W1b enablers', () => {
  beforeEach(() => {
    currentParams = new URLSearchParams();
    runEvalMock.mockClear();
    setJudgeScoresMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Part A: URL autorun ──────────────────────────────────────────────────

  it('autoruns once with parsed model ids + label when eco-eval-autorun=1', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-autorun=1&eco-eval-models=local/model-a,candidate/model-b&eco-eval-label=after-fix&eco-eval-maxtokens=256&eco-eval-sampling=greedy&eco-eval-samples=3&eco-eval-topology=system',
    );

    render(<EvalHarnessPanel />);

    await waitFor(() => {
      expect(runEvalMock).toHaveBeenCalledTimes(1);
    });
    const config = runEvalMock.mock.calls[0]![0];
    expect(config.modelIds).toEqual(['local/model-a', 'candidate/model-b']);
    expect(config.label).toBe('after-fix');
    expect(config.maxTokensCap).toBe(256);
    expect(config.samplingMode).toBe('greedy');
    expect(config.samplesPerProbe).toBe(3);
    expect(config.messageTopology).toBe('system-front-hints');
  });

  it('autoruns the Gemma-native topology when eco-eval-topology=gemma-native', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-autorun=1&eco-eval-models=candidate/model-b&eco-eval-topology=gemma-native',
    );

    render(<EvalHarnessPanel />);

    await waitFor(() => {
      expect(runEvalMock).toHaveBeenCalledTimes(1);
    });
    expect(runEvalMock.mock.calls[0]![0].messageTopology).toBe('gemma-native-user-contract');
  });

  it('autoruns an exact prompt-id subset when eco-eval-prompts is present', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-autorun=1&eco-eval-models=local/model-a,candidate/model-b&eco-eval-prompts=if4,if5,if6,st2,rich5',
    );

    render(<EvalHarnessPanel />);

    await waitFor(() => {
      expect(runEvalMock).toHaveBeenCalledTimes(1);
    });
    expect(runEvalMock.mock.calls[0]![0].promptIds).toEqual(['if4', 'if5', 'if6', 'st2', 'rich5']);
  });

  it('skips autorun when eco-eval-prompts contains no known prompt ids', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-autorun=1&eco-eval-models=local/model-a&eco-eval-prompts=not-a-prompt,also-missing',
    );

    render(<EvalHarnessPanel />);

    await screen.findByText(/no prompts match ids/i);
    await act(async () => {
      await Promise.resolve();
    });
    expect(runEvalMock).not.toHaveBeenCalled();
  });

  it('filters unknown eco-eval-prompts ids before autorun', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-autorun=1&eco-eval-models=local/model-a&eco-eval-prompts=if4,not-a-prompt',
    );

    render(<EvalHarnessPanel />);

    await waitFor(() => {
      expect(runEvalMock).toHaveBeenCalledTimes(1);
    });
    expect(runEvalMock.mock.calls[0]![0].promptIds).toEqual(['if4']);
    expect(await screen.findByText(/skipped unknown prompts/i)).toBeInTheDocument();
  });

  it('does not autorun when eco-eval-autorun is absent', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-models=local/model-a',
    );

    render(<EvalHarnessPanel />);

    // Let the mount effects + picker load settle (picker render is the signal
    // the autorun effect has had its chance to evaluate).
    await screen.findByText(/Model A/);
    await act(async () => {
      await Promise.resolve();
    });
    expect(runEvalMock).not.toHaveBeenCalled();
  });

  it('skips unknown model ids and does not run when none are valid', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-autorun=1&eco-eval-models=does/not-exist',
    );

    render(<EvalHarnessPanel />);

    await screen.findByText(/Autorun skipped/);
    await act(async () => {
      await Promise.resolve();
    });
    expect(runEvalMock).not.toHaveBeenCalled();
  });

  it('runs only valid ids when the list mixes known + unknown', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-autorun=1&eco-eval-models=local/model-a,ghost/model',
    );

    render(<EvalHarnessPanel />);

    await waitFor(() => {
      expect(runEvalMock).toHaveBeenCalledTimes(1);
    });
    expect(runEvalMock.mock.calls[0]![0].modelIds).toEqual(['local/model-a']);
  });

  // ── Part B: judge-score backfill ─────────────────────────────────────────

  it('button is disabled until a run is selected and the textarea is non-empty', async () => {
    render(<EvalHarnessPanel />);
    const button = await screen.findByRole('button', { name: /apply judge scores/i });
    // No run selected yet → disabled.
    expect(button).toBeDisabled();
  });

  it('applies valid judge entries to the selected run via setJudgeScores', async () => {
    const user = userEvent.setup();
    render(<EvalHarnessPanel />);

    // Select the run from the scorecard run picker (first combobox on the page).
    const select = await findRunPicker();
    await user.selectOptions(select, 'run-1');

    const textarea = await screen.findByPlaceholderText(/promptId/);
    await user.click(textarea);
    await user.paste(
      '[{ "promptId": "math-1", "modelId": "candidate/model-b", "coherence": 4, "taskFit": 5 }]',
    );

    const button = screen.getByRole('button', { name: /apply judge scores/i });
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
    await user.click(button);

    await waitFor(() => {
      expect(setJudgeScoresMock).toHaveBeenCalledTimes(1);
    });
    expect(setJudgeScoresMock).toHaveBeenCalledWith('run-1', [
      { promptId: 'math-1', modelId: 'candidate/model-b', coherence: 4, taskFit: 5 },
    ]);
    expect(await screen.findByText(/Applied 1 entry/)).toBeInTheDocument();
  });

  it('copies a judge skeleton with placeholders for the requested dimensions', async () => {
    const user = userEvent.setup();
    render(<EvalHarnessPanel />);

    const select = await findRunPicker();
    await user.selectOptions(select, 'run-1');

    await user.click(screen.getByRole('button', { name: /copy judge skeleton/i }));

    const textarea = await screen.findByPlaceholderText(/promptId/);
    await waitFor(() => {
      expect(textarea).toHaveValue(
        JSON.stringify(
          [
            {
              promptId: 'reasoning-1',
              modelId: 'candidate/model-b',
              coherence: null,
              taskFit: null,
            },
          ],
          null,
          2,
        ),
      );
    });
  });

  it('rejects invalid JSON without calling setJudgeScores and shows an error note', async () => {
    const user = userEvent.setup();
    render(<EvalHarnessPanel />);

    const select = await findRunPicker();
    await user.selectOptions(select, 'run-1');

    const textarea = await screen.findByPlaceholderText(/promptId/);
    await user.click(textarea);
    await user.paste('{ not valid json');

    await user.click(screen.getByRole('button', { name: /apply judge scores/i }));

    expect(await screen.findByText(/Invalid JSON/)).toBeInTheDocument();
    expect(setJudgeScoresMock).not.toHaveBeenCalled();
  });

  it('rejects out-of-range scores without calling setJudgeScores', async () => {
    const user = userEvent.setup();
    render(<EvalHarnessPanel />);

    const select = await findRunPicker();
    await user.selectOptions(select, 'run-1');

    const textarea = await screen.findByPlaceholderText(/promptId/);
    await user.click(textarea);
    await user.paste(
      '[{ "promptId": "math-1", "modelId": "candidate/model-b", "coherence": 9 }]',
    );

    await user.click(screen.getByRole('button', { name: /apply judge scores/i }));

    expect(await screen.findByText(/No valid entries/)).toBeInTheDocument();
    expect(setJudgeScoresMock).not.toHaveBeenCalled();
  });
});
