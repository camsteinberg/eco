// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The everyday CONVERSATION instrument, as reached from the diagnostics panel.
 *
 * PR #103 shipped the multi-turn corpus and `EVERYDAY_CONVERSATION_PROBES` with
 * no route into the only surface that can run them against a real loaded model
 * — `eco-eval-categories=everyday-conversation` matched nothing. That is the
 * same gap PR #93 closed for the single-turn set, and these tests are the same
 * shape of net.
 *
 * ★ WHY THIS ASSERTS HISTORY AND NOT JUST IDS. Every probe here is a probe only
 * because of the turns above it: strip `history` and `convo-insurance-recall`
 * stops asking whether a figure pasted twelve turns ago survived and starts
 * asking an unanswerable question about nothing. A wiring bug that dropped the
 * whole probe would show up as a missing id; one that dropped only its history
 * would run, score, and report a number that measures the opposite of what the
 * corpus claims. So the history is asserted as CONTENT, turn by turn, and the
 * single-turn set is asserted to still carry none — the two sets have to stay
 * distinguishable at the seam, not just countable.
 */

import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVERYDAY_CONVERSATION_PROBES } from '../../../../src/local-ai/eval/everyday-conversation-probes';
import type { EvalRunConfig } from '../../../../src/local-ai/eval/harness';
import type { EvalRun } from '../../../../src/local-ai/eval/types';

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
    startedAt: '2026-08-01T00:00:00.000Z',
    finishedAt: '2026-08-01T00:01:00.000Z',
    device: DEVICE,
    results: [],
  }),
);
vi.mock('../../../../src/local-ai/eval/harness', () => ({
  runEval: (config: EvalRunConfig) => runEvalMock(config),
}));

// ── Storage: no saved runs; this file is about the launch path only ──
vi.mock('../../../../src/local-ai/eval/storage', () => ({
  loadEvalRuns: () => [],
  setJudgeScores: () => true,
  buildJudgeSkeleton: () => [],
  exportEvalRuns: () => '{}',
  clearEvalRuns: () => {},
}));

// `everyday-conversation-probes` is deliberately NOT mocked — the set that has
// to become reachable is the real one.
import { EvalHarnessPanel } from '../EvalHarnessPanel';

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

const CONVERSATION_PROBE_IDS = EVERYDAY_CONVERSATION_PROBES.map((p) => p.id);

/**
 * ★ The set pinned as a LIST, not a count. Adding a ninth conversation has to
 * land here deliberately — the alternative is a new probe joining the run
 * silently, which is exactly how a set drifts away from what it claims to
 * measure. Cross-checked against the derived table below so the two cannot
 * diverge without one of them failing.
 */
const EXPECTED_CONVERSATION_PROBE_IDS = [
  'everyday-convo-convo-air-fryer-doneness',
  'everyday-convo-convo-milestone-gift-mailable',
  'everyday-convo-convo-teacher-email-resend',
  'everyday-convo-convo-grape-climbdown',
  'everyday-convo-convo-monstera-contradiction',
  'everyday-convo-convo-birthday-lunch-message',
  'everyday-convo-convo-four-day-budget-list',
  'everyday-convo-convo-insurance-recall',
];

describe('EvalHarnessPanel — everyday-conversation probes are reachable', () => {
  beforeEach(() => {
    currentParams = new URLSearchParams();
    runEvalMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('the derived set is exactly the eight conversations this test pins', () => {
    expect(CONVERSATION_PROBE_IDS).toEqual(EXPECTED_CONVERSATION_PROBE_IDS);
  });

  it('runs exactly the conversation probe set for eco-eval-categories=everyday-conversation', async () => {
    currentParams = url('eco-eval-categories=everyday-conversation');
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    // Exactly the derived set, in corpus order — not "at least N".
    expect(config.promptIds).toEqual(CONVERSATION_PROBE_IDS);
    // Derived, so outside the harness's pool: they must ride as extras.
    expect(config.extraPrompts).toEqual([...EVERYDAY_CONVERSATION_PROBES]);
  });

  it('★ carries every probe’s history through to the run, turn for turn', async () => {
    currentParams = url('eco-eval-categories=everyday-conversation');
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    const carried = config.extraPrompts ?? [];
    expect(carried).toHaveLength(EVERYDAY_CONVERSATION_PROBES.length);

    for (const source of EVERYDAY_CONVERSATION_PROBES) {
      const arrived = carried.find((p) => p.id === source.id);
      expect(arrived, `${source.id} never reached the run`).toBeDefined();
      // Not "is an array" — the same turns, same roles, same text, same order.
      expect(arrived?.history).toEqual(source.history);
      // A probe here without prior turns is not a conversation probe at all,
      // so this also stops the assertion above passing on two empty arrays.
      expect(arrived?.history?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('carries only the conversation probes a prompt-id subset actually named', async () => {
    const [first, second] = CONVERSATION_PROBE_IDS;
    currentParams = url(`eco-eval-prompts=${first!},${second!}`);
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    expect(config.promptIds).toEqual([first, second]);
    expect(config.extraPrompts?.map((p) => p.id)).toEqual([first, second]);
    // The named subset keeps its history too — the whole point of naming it.
    for (const probe of config.extraPrompts ?? []) {
      expect(probe.history?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('resolves a single conversation probe named on its own, history intact', async () => {
    const target = EVERYDAY_CONVERSATION_PROBES.find(
      (p) => p.id === 'everyday-convo-convo-insurance-recall',
    );
    expect(target).toBeDefined();
    currentParams = url(`eco-eval-prompts=${target!.id}`);
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    expect(config.promptIds).toEqual([target!.id]);
    expect(config.extraPrompts).toEqual([target]);
    expect(config.extraPrompts?.[0]?.history).toEqual(target!.history);
  });
});

describe('EvalHarnessPanel — the two everyday sets do not select each other', () => {
  beforeEach(() => {
    currentParams = new URLSearchParams();
    runEvalMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * R6 deleted the single-turn everyday-use set, so the bleed this used to pin
   * (a conversation probe averaged into the single-turn scorecard) can no
   * longer occur from that direction. What still has to hold is that the
   * category selects THIS set and nothing else in the pool.
   */
  it('everyday-conversation resolves to the conversation set alone', async () => {
    currentParams = url('eco-eval-categories=everyday-conversation');
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    expect(config.promptIds).toEqual(CONVERSATION_PROBE_IDS);
    expect(config.extraPrompts).toEqual([...EVERYDAY_CONVERSATION_PROBES]);
  });

  it('leaves a non-everyday selection exactly as it was — no probes, no extras', async () => {
    currentParams = url('eco-eval-prompts=if4');
    render(<EvalHarnessPanel />);

    const config = await lastConfig();
    expect(config.promptIds).toEqual(['if4']);
    expect(config.extraPrompts).toBeUndefined();
  });

  it('does not autorun the conversation set without eco-eval-autorun', async () => {
    currentParams = new URLSearchParams(
      'eco-diagnostics=1&eco-eval-models=local/model-a&eco-eval-categories=everyday-conversation',
    );
    render(<EvalHarnessPanel />);

    await settle();
    expect(runEvalMock).not.toHaveBeenCalled();
  });
});
