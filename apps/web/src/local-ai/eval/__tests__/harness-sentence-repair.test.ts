// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The harness end of the two-pass repair.
 *
 * The chat path and the harness compose messages separately — the harness
 * mirrors dispatch rather than calling it — so a mechanism wired into only one
 * of them is a mechanism the scorecard cannot see. These tests assert the
 * harness runs the same protocol dispatch does: the model is asked for
 * numbered corrections, the HARNESS applies them, and what gets scored is the
 * person's text with those sentences substituted — never the corrections list.
 */

import { describe, expect, it } from 'vitest';

import { runEval } from '../harness';
import type { EvalGenerationFn, EvalRunnerDeps } from '../harness';
import type { ModelConfig } from '../../types';
import type { TokenEvent } from '../../runtime/types';
import type { EvalPromptSpec, EvalRunDevice } from '../types';

const DEVICE: EvalRunDevice = {
  profileKey: 'chromium|high-memory-laptop|webgpu',
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceClass: 'high-memory-laptop',
};

const SOURCE =
  'Dear Ms. Halbrook,\n\n'
  + 'I am the mother of Mateo of your class of 4 grade. '
  + 'I want to say sorry because he not finish the reading log since two weeks.\n\n'
  + 'He is not a lazy boy. He like very much your class, specially the part of the '
  + 'volcanos, he explain to me all the thing about the lava in the dinner.\n\n'
  + 'With respect,\nYaneth';

const REPAIR_PROBE: EvalPromptSpec = {
  id: 'sr-note',
  category: 'everyday-use',
  intent: 'writing',
  prompt: `hi can you check this for mistakes please, dont change the way i say things\n\n${SOURCE}`,
};

/** A probe that is not a repair ask — the control for "a mixed run stays mixed". */
const PLAIN_PROBE: EvalPromptSpec = {
  id: 'sr-plain',
  category: 'everyday-use',
  intent: 'quick',
  prompt: 'how long do you boil eggs for hard boiled',
};

function fakeModel(id: string): ModelConfig {
  return { id, runtime: 'transformers' } as ModelConfig;
}

function baseDeps(overrides?: Partial<EvalRunnerDeps>): EvalRunnerDeps {
  return {
    prepareModel: async () => {},
    getModel: (id) => fakeModel(id),
    buildOptions: () => ({ temperature: 0.48, maxTokens: 512, topP: 0.9, noRepeatNgramSize: 4 }),
    buildSystemPrompt: (id) => `system for ${id}`,
    getDevice: () => DEVICE,
    save: () => undefined,
    generateRunId: () => 'run-1',
    now: () => 0,
    ...overrides,
  };
}

/** A `generate` that replies with `replies[n]` on its n-th call, recording prompts. */
function scriptedReplies(replies: readonly string[]): {
  generate: EvalGenerationFn;
  seen: { messages: { role: string; content: string }[]; maxTokens?: number; temperature?: number }[];
} {
  const seen: {
    messages: { role: string; content: string }[];
    maxTokens?: number;
    temperature?: number;
  }[] = [];
  const generate: EvalGenerationFn = async function* (_model, messages, options) {
    const index = seen.length;
    seen.push({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.noRepeatNgramSize !== undefined
        ? { noRepeatNgramSize: options.noRepeatNgramSize }
        : {}),
    });
    yield { kind: 'token', text: replies[index] ?? '' } satisfies TokenEvent;
    yield { kind: 'done', completionTokens: 5 } satisfies TokenEvent;
  };
  return { generate, seen };
}

describe('runEval — the two-pass sentence repair', () => {
  it('is off unless the config asks for it', async () => {
    const { generate, seen } = scriptedReplies(['whatever the model says']);
    const run = await runEval(
      { label: 'control', modelIds: ['m'], promptIds: ['sr-note'], extraPrompts: [REPAIR_PROBE] },
      baseDeps({ generate }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messages.at(-1)!.content).not.toContain('1. Dear Ms. Halbrook,');
    expect(run.results[0]!.output).toBe('whatever the model says');
    expect(run.config?.sentenceRepair).toBeUndefined();
  });

  it('asks for numbered corrections, then scores the applied text', async () => {
    const { generate, seen } = scriptedReplies([
      '3: I want to say sorry because he has not finished the reading log for two weeks.',
    ]);
    const run = await runEval(
      {
        label: 'two-pass',
        modelIds: ['m'],
        promptIds: ['sr-note'],
        extraPrompts: [REPAIR_PROBE],
        sentenceRepair: true,
      },
      baseDeps({ generate }),
    );

    // One generation, and it was the corrections pass.
    expect(seen).toHaveLength(1);
    const sent = seen[0]!;
    expect(sent.messages[0]!.content).toContain('numbered lines');
    expect(sent.messages.at(-1)!.content).toContain('1. Dear Ms. Halbrook,');
    // Her own constraint still leads the prompt.
    expect(sent.messages.at(-1)!.content).toContain('dont change the way i say things');

    // What is scored is HER text with one sentence substituted.
    const output = run.results[0]!.output;
    expect(output).toContain('he has not finished the reading log for two weeks');
    expect(output).toContain('With respect,\nYaneth');
    expect(output).toContain('he explain to me all the thing about the lava in the dinner');
    // Never the corrections list.
    expect(output.startsWith('3:')).toBe(false);
    expect(run.config?.sentenceRepair).toBe(true);
  });

  it('runs colder than the writing profile and never bans n-gram reuse', async () => {
    const { generate, seen } = scriptedReplies(['3: fixed sentence.']);
    await runEval(
      {
        label: 'two-pass',
        modelIds: ['m'],
        promptIds: ['sr-note'],
        extraPrompts: [REPAIR_PROBE],
        sentenceRepair: true,
      },
      baseDeps({ generate }),
    );
    // The recorded temperature is how a measurement run verifies which path
    // produced a row — 0.48 is the writing profile, this is not it.
    expect(seen[0]!.temperature).toBe(0.2);
    expect(seen[0]!).not.toHaveProperty('noRepeatNgramSize');
  });

  it('falls back to the whole-text generation when the corrections do not parse', async () => {
    const { generate, seen } = scriptedReplies([
      'Dear Ms. Halbrook, I hope this message finds you well.',
      'the ordinary whole-text answer',
    ]);
    const run = await runEval(
      {
        label: 'two-pass',
        modelIds: ['m'],
        promptIds: ['sr-note'],
        extraPrompts: [REPAIR_PROBE],
        sentenceRepair: true,
      },
      baseDeps({ generate }),
    );

    expect(seen).toHaveLength(2);
    // The second call is today's path, unchanged — same prompt, same options.
    expect(seen[1]!.messages.at(-1)!.content).not.toContain('1. Dear Ms. Halbrook,');
    expect(seen[1]!.temperature).toBe(0.48);
    expect(run.results[0]!.output).toBe('the ordinary whole-text answer');
    // And the row records the options that actually produced it.
    expect(run.results[0]!.generationOptions.temperature).toBe(0.48);
  });

  it('leaves a probe that is not a repair ask completely alone', async () => {
    const { generate, seen } = scriptedReplies(['about 9 minutes']);
    const run = await runEval(
      {
        label: 'two-pass',
        modelIds: ['m'],
        promptIds: ['sr-plain'],
        extraPrompts: [PLAIN_PROBE],
        sentenceRepair: true,
      },
      baseDeps({ generate }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.temperature).toBe(0.48);
    expect(run.results[0]!.output).toBe('about 9 minutes');
  });
});
