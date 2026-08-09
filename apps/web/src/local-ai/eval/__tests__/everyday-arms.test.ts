// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Everyday-use A/B arms — unit tests.
 *
 * The load-bearing ones are the drift guard (an arm that silently no-ops
 * measures nothing while looking like it measured something) and the
 * control-arm enforcement (a treatment-vs-treatment delta reads like evidence
 * and is not).
 */

import { describe, expect, it } from 'vitest';

import { getOnDeviceSystemPrompt } from '../../../lib/system-prompt';
import { getGenerationProfile } from '../../../lib/chat-intent';
import {
  ADD_CONTEXT_CLAUSE_CONDITIONED,
  ADD_CONTEXT_CLAUSE_SHIPPED,
  EVERYDAY_ARMS,
  EVERYDAY_CONTROL_ARM_ID,
  POSTURE_BASE_DIRECT,
  POSTURE_BASE_SHIPPED,
  applyEverydayArmOptions,
  applyEverydayArmSystemPrompt,
  armRewritesSystemPrompt,
  compareEverydayArms,
  getEverydayArm,
} from '../everyday-arms';
import type {
  EvalEverydayArmId,
  EvalMessageTopology,
  EvalRun,
  RubricScores,
} from '../types';

const STARTER_350M = 'candidate/lfm2.5-350m-onnx';

// ─── the arm table ─────────────────────────────────────────────────────────

describe('the arm table', () => {
  it('has a control cell that changes nothing', () => {
    const control = getEverydayArm(EVERYDAY_CONTROL_ARM_ID);
    expect(control.addContextClause).toBe('as-shipped');
    expect(control.ngramBan).toBe('as-shipped');
  });

  it('covers the full 2x2 with distinct ids', () => {
    const cells = EVERYDAY_ARMS.map((a) => `${a.addContextClause}/${a.ngramBan}`);
    expect(new Set(cells).size).toBe(4);
    // ⚠ PIN CHANGED when the posture arm landed. This line was
    // `expect(new Set(ids).size).toBe(4)` — a COUNT, which a third switch
    // legitimately outgrows. Restated as the LIST it was standing in for, so it
    // still asserts distinctness AND now also fails when an arm is added or
    // removed without anyone saying so.
    expect(EVERYDAY_ARMS.map((a) => a.id)).toEqual([
      'control',
      'no-add-context',
      'ngram-off',
      'no-add-context-ngram-off',
      'posture-direct',
    ]);
    expect(new Set(EVERYDAY_ARMS.map((a) => a.id)).size).toBe(EVERYDAY_ARMS.length);
  });

  it('throws on an unknown arm rather than silently measuring the control', () => {
    expect(() => getEverydayArm('nope' as EvalEverydayArmId)).toThrow(/unknown everyday arm/);
  });
});

// ─── arm 1: the add-context clause ─────────────────────────────────────────

describe('the add-context clause arm', () => {
  it('★ drift guard: the shipped clause is still IN the shipped prompt', () => {
    // If this fails the prompt was edited and `applyEverydayArmSystemPrompt`
    // has been quietly no-opping — the arm would report "no effect" for a
    // change it never made.
    expect(getOnDeviceSystemPrompt()).toContain(ADD_CONTEXT_CLAUSE_SHIPPED);
  });

  it('conditions the clause and leaves the rest of the prompt untouched', () => {
    const base = getOnDeviceSystemPrompt();
    const conditioned = applyEverydayArmSystemPrompt(base, getEverydayArm('no-add-context'));

    expect(conditioned).toContain(ADD_CONTEXT_CLAUSE_CONDITIONED);
    expect(conditioned).not.toContain(ADD_CONTEXT_CLAUSE_SHIPPED);
    // everything either side of the clause survives verbatim
    const [head, tail] = base.split(ADD_CONTEXT_CLAUSE_SHIPPED);
    expect(conditioned).toBe(`${head}${ADD_CONTEXT_CLAUSE_CONDITIONED}${tail}`);
  });

  it('★ conditions the clause without instructing brevity', () => {
    // Testing "be brief" instead would measure a different and much blunter
    // thing, and terseness is the exact risk being managed.
    expect(ADD_CONTEXT_CLAUSE_CONDITIONED).not.toMatch(/\b(brief|short|concise|terse)\b/i);
    expect(ADD_CONTEXT_CLAUSE_CONDITIONED).toContain('when the ask invites it');
  });

  it('leaves the prompt alone on the control arm', () => {
    const base = getOnDeviceSystemPrompt();
    expect(applyEverydayArmSystemPrompt(base, getEverydayArm('control'))).toBe(base);
    expect(applyEverydayArmSystemPrompt(base, getEverydayArm('ngram-off'))).toBe(base);
  });
});

// ─── arm 3: the whole-base posture ─────────────────────────────────────────

describe('the posture-removal arm', () => {
  const posture = getEverydayArm('posture-direct');

  it('★ drift guard: the shipped base is EXACTLY what production composes', () => {
    // Exact equality, not `contains`: a whole-base swap has to reproduce the
    // base byte for byte or `applyEverydayArmSystemPrompt` throws at run time.
    // This is also what makes holding a copy of the prod constant safe.
    expect(getOnDeviceSystemPrompt()).toBe(POSTURE_BASE_SHIPPED);
  });

  it('replaces the whole base and keeps the model directive appended after it', () => {
    const withSuffix = `${POSTURE_BASE_SHIPPED}\nKeep replies plain.`;
    expect(applyEverydayArmSystemPrompt(withSuffix, posture)).toBe(
      `${POSTURE_BASE_DIRECT}\nKeep replies plain.`,
    );
  });

  it('leaves anything appended after the base — custom instructions included — untouched', () => {
    // Production appends user custom instructions after the base with a blank
    // line (useChat.buildSystemPrompt). The arm must not disturb that block.
    const composed = `${POSTURE_BASE_SHIPPED}\n\nAlways answer in British English.`;
    expect(applyEverydayArmSystemPrompt(composed, posture)).toBe(
      `${POSTURE_BASE_DIRECT}\n\nAlways answer in British English.`,
    );
  });

  it('★ the treatment removes the elaboration push it is meant to remove', () => {
    expect(POSTURE_BASE_DIRECT).not.toContain(ADD_CONTEXT_CLAUSE_SHIPPED);
    expect(POSTURE_BASE_DIRECT).not.toContain('deserves a thorough, well-developed reply');
  });

  it('★ and does NOT command brevity — the axis is open vs closed, not short vs long', () => {
    // The binding constraint on this arm. An instruction to be terse would
    // measure a blunter thing and would optimise the product into terseness.
    expect(POSTURE_BASE_DIRECT).not.toMatch(/\b(brief|briefly|short|shorter|concise|terse|succinct|minimal)\b/i);
    // The open side has to survive in the text, or the arm IS the terse arm.
    expect(POSTURE_BASE_DIRECT).toContain('an open question');
    expect(POSTURE_BASE_DIRECT).toContain('invitation to say more');
  });

  it('★ does not reintroduce the phrasing the 1.2B literalized into an H1', () => {
    // lib/system-prompt.ts records that "Lead with the answer" produced replies
    // opening with a literal "Answer" heading on the 1.2B default.
    expect(POSTURE_BASE_DIRECT).not.toMatch(/lead with the answer/i);
  });

  it('keeps the identity sentence and the user-instruction clause verbatim', () => {
    // Identity is the eco-tangent A/B's variable; changing it here would
    // confound two experiments.
    expect(POSTURE_BASE_DIRECT).toContain(
      'You are Eco, a private AI — a compact open model running entirely on this device; conversations stay with the user.',
    );
    expect(POSTURE_BASE_DIRECT).toContain(
      'When the user gives explicit format or length instructions, follow them exactly.',
    );
  });

  it('★ throws rather than silently no-op when the base is not the prefix', () => {
    // The run-time case no drift guard can see: another local arm (the
    // eco-tangent identity swap) already rewrote the base. A silent pass-through
    // there would report a clean zero for a change never applied.
    const tangentArmed = POSTURE_BASE_SHIPPED.replace(
      'You are Eco, a private AI —',
      'You are a private AI called Eco —',
    );
    expect(() => applyEverydayArmSystemPrompt(tangentArmed, posture)).toThrow(
      /does not start with the shipped base/,
    );
  });

  it('leaves generation options alone — this arm is prompt-only', () => {
    const options = { temperature: 0.45, noRepeatNgramSize: 3 };
    expect(applyEverydayArmOptions(options, posture)).toEqual(options);
  });

  it('★ table invariant: no arm rewrites the system prompt two different ways', () => {
    // A cell setting both would make the clause swap search text the posture
    // swap already deleted — a silent no-op wearing the name of a switch.
    for (const arm of EVERYDAY_ARMS) {
      if (arm.posture === 'as-shipped') continue;
      expect(arm.addContextClause).toBe('as-shipped');
    }
  });

  it('is recognised as a system-prompt arm, alongside the clause arms', () => {
    expect(armRewritesSystemPrompt(posture)).toBe(true);
    expect(armRewritesSystemPrompt(getEverydayArm('no-add-context'))).toBe(true);
    expect(armRewritesSystemPrompt(getEverydayArm('control'))).toBe(false);
    expect(armRewritesSystemPrompt(getEverydayArm('ngram-off'))).toBe(false);
  });
});

// ─── arm 2: the prompt-inclusive n-gram ban ────────────────────────────────

describe('the n-gram ban arm', () => {
  // ★ THIS ARM IS SPENT, and that is the thing worth asserting now. It existed to
  // settle one question — whether the starter's prompt-inclusive n-gram ban should
  // come off — and a real-model A/B (n=10, 490 generations per arm) answered yes:
  // `preservesUserText` cleared the pre-registered bar and the feared runaway
  // repetition never appeared. The removal shipped, base and `writing` override
  // both.
  //
  // So `ngram-off` and `control` now hand this model IDENTICAL options. Re-running
  // that pair would measure nothing and report an honest-looking zero. Asserted
  // rather than deleted so the next person reads "the question is answered" instead
  // of discovering a null result the hard way — the same vacuous-counterweight trap
  // documented in everyday-use-routing-sweep.test.ts.
  it('★ the starter no longer carries the ban, so this arm has nothing left to toggle', () => {
    const profile = getGenerationProfile('quick', true, STARTER_350M, {
      allowValidationModel: true,
    });
    expect(profile.noRepeatNgramSize).toBeUndefined();
  });

  it('drops the ban on the off arm and keeps every other knob', () => {
    const options = { temperature: 0.45, maxTokens: 1024, topP: 0.86, repetitionPenalty: 1.08, noRepeatNgramSize: 3 };
    const off = applyEverydayArmOptions(options, getEverydayArm('ngram-off'));

    expect(off.noRepeatNgramSize).toBeUndefined();
    // repetitionPenalty in particular must survive: it is the loop guard that
    // has to hold the line once the ban is gone.
    expect(off.repetitionPenalty).toBe(1.08);
    expect(off).toEqual({ temperature: 0.45, maxTokens: 1024, topP: 0.86, repetitionPenalty: 1.08 });
  });

  it('leaves options untouched on the control arm', () => {
    const options = { temperature: 0.45, noRepeatNgramSize: 3 };
    expect(applyEverydayArmOptions(options, getEverydayArm('control'))).toEqual(options);
    expect(applyEverydayArmOptions(options, getEverydayArm('no-add-context'))).toEqual(options);
  });
});

// ─── the mandatory control arm ─────────────────────────────────────────────

function scores(): RubricScores {
  return {
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
    deliversFirst: 1,
    preservesUserText: null,
    preservesUserRegister: null,
    preservesFacts: null,
    preservesHistoryFacts: null,
    honorsRuledOut: null,
    deliversAskedArtifact: null,
    noUnfilledSlots: null,
    noInventedTime: null,
    deliversUnburied: null,
    coherence: null,
    taskFit: null,
  };
}

function runFor(
  armId: EvalEverydayArmId | undefined,
  runId: string,
  samplingMode: 'greedy' | 'sampled' = 'sampled',
  messageTopology: EvalMessageTopology = 'production-user-turn-hints',
): EvalRun {
  return {
    schemaVersion: 1,
    runId,
    label: armId ?? 'unstamped',
    startedAt: '2026-07-28T00:00:00.000Z',
    finishedAt: '2026-07-28T00:10:00.000Z',
    device: {
      profileKey: 'k',
      browserClass: 'chromium',
      webgpuSupport: 'yes',
      deviceClass: 'desktop',
    },
    config: {
      messageTopology,
      samplingMode,
      samplesPerProbe: 1,
      maxTokensCap: 512,
      perGenerationTimeoutMs: 60_000,
      includeResearchArms: false,
      promptCount: 1,
      promptSetHash: 'hash',
      compositionEra: 'wave2.6-stage1-user-turn-hints',
      harnessVersion: 1,
      ...(armId ? { everydayArm: armId } : {}),
    },
    results: [
      {
        promptId: 'everyday-factual-01',
        category: 'everyday-use',
        modelId: STARTER_350M,
        runtimeAdapter: 'transformers',
        output: 'About 10-12 minutes, then into cold water.',
        generationOptions: { temperature: 0 },
        scores: scores(),
        perf: { ttftMs: 10, tokensPerSec: 10, totalMs: 100, completionTokens: 10, smokePass: true },
        error: null,
      },
    ],
  };
}

describe('★ compareEverydayArms refuses to report without a control', () => {
  it('diffs each treatment against the control when one is present', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-control'),
      runFor('ngram-off', 'r-ngram'),
    ]);

    expect(comparison.problems).toEqual([]);
    expect(comparison.controlRunId).toBe('r-control');
    expect(comparison.deltas).toHaveLength(1);
    expect(comparison.deltas[0]?.armId).toBe('ngram-off');
    expect(comparison.deltas[0]?.diff.models[0]?.modelId).toBe(STARTER_350M);
  });

  it('★ refuses two treatments with no control — the +43% TTFT mistake, prevented', () => {
    const comparison = compareEverydayArms([
      runFor('ngram-off', 'r-a'),
      runFor('no-add-context', 'r-b'),
    ]);

    expect(comparison.deltas).toEqual([]);
    expect(comparison.problems.join(' ')).toMatch(/no control-arm run present/);
  });

  it('refuses two runs both claiming the control', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-a'),
      runFor('control', 'r-b'),
    ]);

    expect(comparison.deltas).toEqual([]);
    expect(comparison.problems.join(' ')).toMatch(/claim the control arm/);
  });

  it('refuses a run carrying no arm stamp', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-control'),
      runFor(undefined, 'r-unstamped'),
    ]);

    expect(comparison.deltas).toEqual([]);
    expect(comparison.problems.join(' ')).toMatch(/carries no everydayArm stamp/);
  });

  it('refuses an empty set rather than returning an empty comparison', () => {
    expect(compareEverydayArms([]).problems.join(' ')).toMatch(/no control-arm run present/);
  });

  it('★ refuses an n-gram arm run under greedy decode, where the switch cannot act', () => {
    // `toGreedyOptions` collapses to { temperature: 0, maxTokens } and drops
    // noRepeatNgramSize for EVERY arm — so this pair would report a clean zero
    // for a change that was never applied.
    const comparison = compareEverydayArms([
      runFor('control', 'r-control', 'greedy'),
      runFor('ngram-off', 'r-ngram', 'greedy'),
    ]);

    expect(comparison.deltas).toEqual([]);
    expect(comparison.problems.join(' ')).toMatch(/n-gram switch cannot be measured here/);
  });

  it('allows the add-context arm under greedy decode — the prompt swap still acts', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-control', 'greedy'),
      runFor('no-add-context', 'r-clause', 'greedy'),
    ]);

    expect(comparison.problems).toEqual([]);
    expect(comparison.deltas).toHaveLength(1);
  });

  it('pairs the posture arm against the control like any other treatment', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-control'),
      runFor('posture-direct', 'r-posture'),
    ]);

    expect(comparison.problems).toEqual([]);
    expect(comparison.controlRunId).toBe('r-control');
    expect(comparison.deltas.map((d) => d.armId)).toEqual(['posture-direct']);
  });

  it('allows the posture arm under greedy decode — a prompt swap is not a sampling knob', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-control', 'greedy'),
      runFor('posture-direct', 'r-posture', 'greedy'),
    ]);

    expect(comparison.problems).toEqual([]);
    expect(comparison.deltas).toHaveLength(1);
  });
});

// ─── the topology under which a system-prompt arm cannot act ────────────────

describe('★ compareEverydayArms refuses a system-prompt arm with no system prompt', () => {
  const GEMMA_NATIVE = 'gemma-native-user-contract';

  // Read off the arm table, so a new cell lands on whichever side its own
  // settings put it — the same split the panel's launch guard uses.
  const promptArms = EVERYDAY_ARMS.filter(armRewritesSystemPrompt).map((a) => a.id);
  const otherArms = EVERYDAY_ARMS.filter((a) => !armRewritesSystemPrompt(a)).map((a) => a.id);

  it('the arm table still has both a system-prompt side and a non-system-prompt side', () => {
    expect(promptArms.length).toBeGreaterThan(0);
    expect(otherArms.length).toBeGreaterThan(0);
  });

  it.each(promptArms.map((id) => [id]))(
    'refuses %s recorded under the gemma-native topology, and says why',
    (armId) => {
      const comparison = compareEverydayArms([
        runFor('control', 'r-control', 'sampled', GEMMA_NATIVE),
        runFor(armId, 'r-arm', 'sampled', GEMMA_NATIVE),
      ]);

      expect(comparison.deltas).toEqual([]);
      expect(comparison.problems.join(' ')).toMatch(
        /system-prompt switch cannot be measured here/,
      );
    },
  );

  it.each(otherArms.filter((id) => id !== 'control').map((id) => [id]))(
    'still reports %s under the gemma-native topology — its switch is not the prompt',
    (armId) => {
      const comparison = compareEverydayArms([
        runFor('control', 'r-control', 'sampled', GEMMA_NATIVE),
        runFor(armId, 'r-arm', 'sampled', GEMMA_NATIVE),
      ]);

      expect(comparison.problems).toEqual([]);
      expect(comparison.deltas).toHaveLength(1);
    },
  );
});
