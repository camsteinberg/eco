// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * ★ THE TOOL SEAM: does setting `groundingArm` actually run a tool and put its
 * note in front of the model?
 *
 * This is the one thing no earlier harness test could check, because until the
 * retrieval arm existed the harness never ran a tool at all. So the assertions
 * here are about plumbing, not quality: the note is appended to the SYSTEM prompt
 * joined by "\n\n" (the join the chat pipeline uses), the history is untouched, the
 * arm is stamped on the run fingerprint, and an unset arm leaves the harness
 * exactly as tool-free as it has always been.
 *
 * `fetch` is stubbed for the whole file: a harness test must never reach
 * Wikipedia, and a probe whose lookup fails still exercises the injection path
 * through the tool's honest hedge/degrade note.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inferChatIntent } from '../../../lib/chat-intent';
import { runEval } from '../harness';
import type { EvalGenerationFn, EvalRunnerDeps } from '../harness';
import type { EvalPromptSpec } from '../types';
import type { ModelConfig } from '../../types';
import type { ChatMessage, TokenEvent } from '../../runtime/types';

const LOOKUP_PROBE: EvalPromptSpec = {
  id: 'retrieval/lookup-calories-apple',
  category: 'retrieval',
  intent: inferChatIntent('how many calories in an apple'),
  prompt: 'how many calories in an apple',
};

const NO_TOOL_PROBE: EvalPromptSpec = {
  id: 'retrieval/no-tool-personal-writing/self-review-perf',
  category: 'retrieval',
  intent: inferChatIntent(
    'here is my self review, tell me if it is specific enough or still vague',
  ),
  prompt: 'here is my self review, tell me if it is specific enough or still vague',
};

function recordingGenerate(seen: ChatMessage[][]): EvalGenerationFn {
  return (_model, messages) => {
    seen.push(messages);
    return (async function* () {
      yield { kind: 'token', text: 'about 52 calories' } satisfies TokenEvent;
      yield { kind: 'done', completionTokens: 4, promptTokens: 137 } satisfies TokenEvent;
    })();
  };
}

function deps(seen: ChatMessage[][]): EvalRunnerDeps {
  return {
    prepareModel: async () => {},
    generate: recordingGenerate(seen),
    getModel: (id) => ({ id, runtime: 'transformers' }) as ModelConfig,
    buildSystemPrompt: () => 'BASE PROMPT',
    buildOptions: () => ({ temperature: 0, maxTokens: 64 }),
    getDevice: () => ({
      profileKey: 'test',
      browserClass: 'chromium',
      webgpuSupport: 'webgpu',
      deviceClass: 'high-memory-laptop',
    }),
    save: () => undefined,
    generateRunId: () => 'run-retrieval',
    now: () => 0,
  };
}

beforeEach(() => {
  // Every outbound request fails: the tool degrades honestly and still produces a
  // note, which is what the injection assertions need. Nothing leaves the machine.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline in tests'))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('★ harness retrieval arm', () => {
  it('runs no tool at all when the arm is unset', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'control',
        modelIds: ['test-model'],
        extraPrompts: [LOOKUP_PROBE],
        promptIds: [LOOKUP_PROBE.id],
      },
      deps(seen),
    );

    expect(seen[0]?.[0]?.content).toBe('BASE PROMPT');
    expect(run.results[0]?.grounding).toBeUndefined();
    expect(run.config?.groundingArm).toBeUndefined();
  });

  it('appends the tool note to the SYSTEM prompt with the pipeline’s "\\n\\n" join', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'lead',
        modelIds: ['test-model'],
        extraPrompts: [LOOKUP_PROBE],
        promptIds: [LOOKUP_PROBE.id],
        groundingArm: 'lead',
      },
      deps(seen),
    );

    const system = seen[0]?.[0];
    expect(system?.role).toBe('system');
    expect(system?.content.startsWith('BASE PROMPT\n\n')).toBe(true);
    expect(system?.content.length).toBeGreaterThan('BASE PROMPT\n\n'.length);

    const record = run.results[0]?.grounding;
    expect(record?.fired).toBe(true);
    expect(record?.injectedChars).toBeGreaterThan(0);
    expect(record?.injectedTokensEstimate).toBe(Math.round(record!.injectedChars / 4));
    expect(run.config?.groundingArm).toBe('lead');
  });

  it('leaves the user turn and history untouched — grounding rides the system prompt', async () => {
    const seen: ChatMessage[][] = [];
    await runEval(
      {
        label: 'passages',
        modelIds: ['test-model'],
        extraPrompts: [{ ...LOOKUP_PROBE, history: [{ role: 'user', content: 'earlier turn' }] }],
        promptIds: [LOOKUP_PROBE.id],
        groundingArm: 'passages',
      },
      deps(seen),
    );

    const messages = seen[0] ?? [];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(messages[1]?.content).toContain('earlier turn');
    expect(messages[1]?.content).not.toContain('SOURCE TEXT');
    expect(messages[2]?.content).toContain('how many calories in an apple');
    expect(messages[2]?.content).not.toContain('SOURCE TEXT');
  });

  it('records a clean no-fire on a row the shipped matcher abstains from', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'passages',
        modelIds: ['test-model'],
        extraPrompts: [NO_TOOL_PROBE],
        promptIds: [NO_TOOL_PROBE.id],
        groundingArm: 'passages',
      },
      deps(seen),
    );

    expect(seen[0]?.[0]?.content).toBe('BASE PROMPT');
    expect(run.results[0]?.grounding).toMatchObject({ fired: false, outcome: 'none' });
  });

  it('records the adapter-reported promptTokens alongside the estimate', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'lead',
        modelIds: ['test-model'],
        extraPrompts: [LOOKUP_PROBE],
        promptIds: [LOOKUP_PROBE.id],
        groundingArm: 'lead',
      },
      deps(seen),
    );

    expect(run.results[0]?.perf.promptTokens).toBe(137);
  });
});
