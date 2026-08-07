// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eco-tangent A/B machinery — arms, tangent flagger, reporting, experiment set,
 * and the harness arm-override seam.
 *
 * These tests pin
 * the invariants the measurement depends on: the arm swap touches ONLY the
 * identity sentence, the flagger never auto-fails (it only surfaces candidates),
 * and the experiment set stays out of the curated felt/fixed pool.
 */

import { describe, expect, it } from 'vitest';
import {
  ECO_TANGENT_ARM_A_SENTENCE,
  ECO_TANGENT_ARM_B_SENTENCE,
  ECO_TANGENT_ARM_C_SENTENCE,
  ECO_TANGENT_LEXICON,
  ECO_TANGENT_PROBES,
  ECO_TANGENT_PROBE_IDS,
  applyEcoTangentArm,
  flagEcoTangent,
  reportEcoTangentFlags,
  type EcoTangentArm,
} from '../eco-tangent';
import { runEval } from '../harness';
import type { EvalGenerationFn, EvalRunnerDeps } from '../harness';
import { getOnDeviceSystemPrompt } from '../../../lib/system-prompt';
import { inferChatIntent } from '../../../lib/chat-intent';
import { EVAL_PROMPTS } from '../prompts';
import { SHAPE_PROBES, SHAPE_RESEARCH_ARMS } from '../shape-probes';
import { FELT_PROBES } from '../felt-probes';
import type { ChatMessage, GenerateOptions, TokenEvent } from '../../runtime/types';
import type { ModelConfig } from '../../types';
import type { EvalResult, EvalRun, EvalRunDevice } from '../types';

// ─── Arms ────────────────────────────────────────────────────────────────────

describe('applyEcoTangentArm', () => {
  const BASE = `${ECO_TANGENT_ARM_A_SENTENCE} Reply in a natural voice. Match depth to the question.`;

  it('arm A is a no-op (control is the live sentence, verbatim)', () => {
    expect(applyEcoTangentArm(BASE, 'A')).toBe(BASE);
  });

  it('arm B swaps ONLY the identity sentence, preserving the rest byte-for-byte', () => {
    const out = applyEcoTangentArm(BASE, 'B');
    expect(out).toBe(`${ECO_TANGENT_ARM_B_SENTENCE} Reply in a natural voice. Match depth to the question.`);
    expect(out).not.toContain(ECO_TANGENT_ARM_A_SENTENCE);
    expect(out).toContain(ECO_TANGENT_ARM_B_SENTENCE);
  });

  it('arm C swaps ONLY the identity sentence, preserving the rest byte-for-byte', () => {
    const out = applyEcoTangentArm(BASE, 'C');
    expect(out).toBe(`${ECO_TANGENT_ARM_C_SENTENCE} Reply in a natural voice. Match depth to the question.`);
    expect(out).not.toContain(ECO_TANGENT_ARM_A_SENTENCE);
    expect(out).toContain(ECO_TANGENT_ARM_C_SENTENCE);
  });

  it('the suffix after the identity sentence is identical across all three arms', () => {
    const suffix = (arm: EcoTangentArm): string => {
      const out = applyEcoTangentArm(BASE, arm);
      return out.slice(out.length - ' Reply in a natural voice. Match depth to the question.'.length);
    };
    expect(suffix('A')).toBe(suffix('B'));
    expect(suffix('B')).toBe(suffix('C'));
  });

  it('no-ops when the control sentence is absent (drift → silent no-op, guarded below)', () => {
    const drifted = 'You are a totally different assistant. Be helpful.';
    expect(applyEcoTangentArm(drifted, 'B')).toBe(drifted);
  });

  it('DRIFT GUARD: the live on-device prompt still contains the arm-A control sentence', () => {
    // If this fails, the shipped identity sentence changed and the arm sentences
    // (here and in the design doc) must be re-synced, or the A/B swaps nothing.
    expect(getOnDeviceSystemPrompt()).toContain(ECO_TANGENT_ARM_A_SENTENCE);
  });

  it('swaps the identity sentence of the REAL live prompt for B and C', () => {
    const live = getOnDeviceSystemPrompt();
    for (const arm of ['B', 'C'] as const) {
      const swapped = applyEcoTangentArm(live, arm);
      expect(swapped).not.toBe(live);
      expect(swapped).not.toContain(ECO_TANGENT_ARM_A_SENTENCE);
      expect(swapped).toContain(
        arm === 'B' ? ECO_TANGENT_ARM_B_SENTENCE : ECO_TANGENT_ARM_C_SENTENCE,
      );
    }
  });
});

// ─── Flagger ─────────────────────────────────────────────────────────────────

describe('flagEcoTangent', () => {
  it('does not flag an everyday reply with no environmental content', () => {
    const flag = flagEcoTangent(
      'Sure — boil the pasta, toss it with olive oil, garlic, and parmesan, and dinner is ready in ten minutes.',
    );
    expect(flag.flagged).toBe(false);
    expect(flag.matchedStems).toEqual([]);
  });

  it('flags a reply that drifts into ecology talk, listing the matched stems', () => {
    const flag = flagEcoTangent(
      'You could also choose sustainable ingredients to reduce your carbon footprint and help the planet.',
    );
    expect(flag.flagged).toBe(true);
    expect(flag.matchedStems).toEqual(['sustainab', 'carbon', 'planet', 'footprint']);
  });

  it('is case-insensitive', () => {
    expect(flagEcoTangent('This is ECO-FRIENDLY and RENEWABLE.').matchedStems).toEqual([
      'eco-friendly',
      'renewable',
    ]);
  });

  it('flags the genuinely ambiguous cases by design (the human confirms/rejects)', () => {
    // "development environment" (code), "climate" as weather, "green vegetables"
    // (cooking) all flag — over-flagging is the intended direction.
    expect(flagEcoTangent('Set up your development environment first.').matchedStems).toEqual([
      'environment',
    ]);
    expect(flagEcoTangent('Lisbon has a mild climate in spring.').matchedStems).toEqual(['climate']);
    expect(flagEcoTangent('Add green vegetables like spinach.').matchedStems).toEqual(['green']);
  });

  it('does NOT flag word-boundary near-misses', () => {
    for (const text of [
      'A warm greeting to start the day.', // "greeting" — not "green"
      'The greenhouse effect is not mentioned here at all, just a building.', // "greenhouse"
      'Try spaghetti carbonara tonight.', // "carbonara" — not "carbon"
      'Let your body acclimate to the altitude.', // "acclimate" — not "climate"
    ]) {
      expect(flagEcoTangent(text), text).toMatchObject({ flagged: false });
    }
  });

  it('lexicon entries are distinct stems', () => {
    const stems = ECO_TANGENT_LEXICON.map((e) => e.stem);
    expect(new Set(stems).size).toBe(stems.length);
  });
});

// ─── Reporting ───────────────────────────────────────────────────────────────

const DEVICE: EvalRunDevice = {
  profileKey: 'test',
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceClass: 'high-memory-laptop',
};

function resultFor(promptId: string, modelId: string, output: string, sampleIndex?: number): EvalResult {
  return {
    promptId,
    ...(sampleIndex !== undefined ? { sampleIndex } : {}),
    category: 'conversation',
    modelId,
    runtimeAdapter: 'transformers',
    output,
    generationOptions: {},
    scores: {
      correctStop: 1,
      noRepetition: 1,
      noCannedLeakage: 1,
      noThinkLeakage: 1,
      noCjkLeak: 1,
      formatAdherence: null,
      exactness: null,
      instructionFollowing: null,
      appropriateUncertainty: null,
      answerDepth: null,
      depthMatch: null,
      deliversFirst: null,
      preservesUserText: null,
      preservesFacts: null,
      preservesHistoryFacts: null,
      honorsRuledOut: null,
      coherence: null,
      taskFit: null,
    },
    perf: { ttftMs: 1, tokensPerSec: 1, totalMs: 1, completionTokens: 1, smokePass: true },
    error: null,
  };
}

function runWith(results: EvalResult[]): EvalRun {
  return {
    schemaVersion: 1,
    runId: 'run-x',
    label: 'arm-B',
    startedAt: '2026-07-03T00:00:00.000Z',
    finishedAt: '2026-07-03T00:01:00.000Z',
    device: DEVICE,
    results,
  };
}

describe('reportEcoTangentFlags', () => {
  const tangentId = ECO_TANGENT_PROBES[0]!.id;

  it('considers ONLY eco-tangent probe results (ignores felt/fixed probes)', () => {
    const report = reportEcoTangentFlags(
      runWith([
        resultFor(tangentId, 'model-a', 'Buy sustainable, eco-friendly ingredients.'),
        // A felt probe reply full of eco words must be ignored — not in scope.
        resultFor('felt-teach-not-thin', 'model-a', 'The planet needs renewable energy.'),
      ]),
    );
    expect(report.totalResults).toBe(1);
    expect(report.flaggedResults).toBe(1);
    expect(report.flags).toHaveLength(1);
    expect(report.flags[0]!.promptId).toBe(tangentId);
  });

  it('tallies per model and carries sampleIndex + matched stems into the confirm queue', () => {
    const report = reportEcoTangentFlags(
      runWith([
        resultFor(tangentId, 'model-a', 'A perfectly neutral reply.', 1),
        resultFor(tangentId, 'model-a', 'This is more sustainable and greener.', 2),
        resultFor(tangentId, 'model-b', 'A completely ordinary reply.', 1),
      ]),
    );
    expect(report.byModel).toContainEqual({ modelId: 'model-a', total: 2, flagged: 1 });
    expect(report.byModel).toContainEqual({ modelId: 'model-b', total: 1, flagged: 0 });
    expect(report.flags).toHaveLength(1);
    expect(report.flags[0]).toMatchObject({
      modelId: 'model-a',
      sampleIndex: 2,
      matchedStems: ['sustainab', 'green'],
    });
  });

  it('an errored/empty output never flags', () => {
    const report = reportEcoTangentFlags(runWith([resultFor(tangentId, 'model-a', '')]));
    expect(report.flaggedResults).toBe(0);
  });
});

// ─── Experiment set ──────────────────────────────────────────────────────────

describe('ECO_TANGENT_PROBES', () => {
  it('is a curated non-empty set with unique, prefixed ids', () => {
    expect(ECO_TANGENT_PROBES.length).toBeGreaterThanOrEqual(15);
    const ids = ECO_TANGENT_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('eco-tangent-')).toBe(true);
    expect(ECO_TANGENT_PROBE_IDS).toEqual(new Set(ids));
  });

  it('never overlaps the checked-in prompt pool (it is session-scoped only)', () => {
    const pool = new Set(
      [...EVAL_PROMPTS, ...SHAPE_PROBES, ...SHAPE_RESEARCH_ARMS, ...FELT_PROBES].map((p) => p.id),
    );
    for (const probe of ECO_TANGENT_PROBES) expect(pool.has(probe.id)).toBe(false);
  });

  it('carries NO auto-fail scoring fields — the only signal is the lexicon flag', () => {
    for (const probe of ECO_TANGENT_PROBES) {
      expect(probe.forbiddenAnswers, probe.id).toBeUndefined();
      expect(probe.expectedAnswers, probe.id).toBeUndefined();
      expect(probe.exactReply, probe.id).toBeUndefined();
      expect(probe.expectDecline, probe.id).toBeUndefined();
    }
  });

  it('keeps intent labels in lockstep with the live router', () => {
    for (const probe of ECO_TANGENT_PROBES) {
      expect(
        inferChatIntent(probe.prompt, { hasPriorTurns: (probe.history?.length ?? 0) > 0 }),
        `${probe.id} ("${probe.prompt}") routes differently than its spec.intent`,
      ).toBe(probe.intent);
    }
  });

  it('the hand-written multi-turn history carries no eco-words (so only model output can flag)', () => {
    for (const probe of ECO_TANGENT_PROBES) {
      for (const turn of probe.history ?? []) {
        expect(flagEcoTangent(turn.content).flagged, `${probe.id}: "${turn.content}"`).toBe(false);
      }
    }
  });
});

// ─── Harness arm-override seam ───────────────────────────────────────────────

function fakeModel(id: string): ModelConfig {
  return { id, runtime: 'transformers' } as ModelConfig;
}

/** Deps that capture the system message passed to `generate`, fully offline. */
function capturingDeps(base: string, captured: { system: string | null }): EvalRunnerDeps {
  const generate: EvalGenerationFn = (
    _model: ModelConfig,
    messages: ChatMessage[],
    _options: GenerateOptions,
  ) => {
    const sys = messages.find((m) => m.role === 'system');
    captured.system = sys ? sys.content : null;
    return (async function* () {
      yield { kind: 'token', text: 'ok' } satisfies TokenEvent;
      yield { kind: 'done', completionTokens: 1 } satisfies TokenEvent;
    })();
  };
  return {
    prepareModel: async () => {},
    getModel: (id) => fakeModel(id),
    buildOptions: () => ({ temperature: 0.5, maxTokens: 64 }),
    buildSystemPrompt: () => base,
    getDevice: () => DEVICE,
    save: () => undefined,
    generateRunId: () => 'run-arm',
    now: () => 0,
    generate,
  };
}

describe('runEval — eco-tangent arm override', () => {
  const base = `${ECO_TANGENT_ARM_A_SENTENCE} Reply naturally.`;

  it('leaves the shipped prompt untouched when no arm is set', async () => {
    const captured = { system: null as string | null };
    await runEval(
      { label: 'no-arm', modelIds: ['m'], promptIds: ['fk1'] },
      capturingDeps(base, captured),
    );
    expect(captured.system).toBe(base);
  });

  it('arm A composes the identical (control) system prompt', async () => {
    const captured = { system: null as string | null };
    await runEval(
      { label: 'arm-A', modelIds: ['m'], promptIds: ['fk1'], identityArm: 'A' },
      capturingDeps(base, captured),
    );
    expect(captured.system).toBe(base);
  });

  it('arm B swaps the identity sentence into the composed system prompt', async () => {
    const captured = { system: null as string | null };
    await runEval(
      { label: 'arm-B', modelIds: ['m'], promptIds: ['fk1'], identityArm: 'B' },
      capturingDeps(base, captured),
    );
    expect(captured.system).toBe(`${ECO_TANGENT_ARM_B_SENTENCE} Reply naturally.`);
  });
});
