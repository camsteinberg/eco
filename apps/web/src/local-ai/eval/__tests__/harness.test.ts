// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from 'vitest';
import { runEval } from '../harness';
import type {
  EvalGenerationFn,
  EvalPrepareModelFn,
  EvalProgress,
  EvalRunnerDeps,
} from '../harness';
import {
  buildHintedUserTurn,
  buildTurnQualityInstruction,
  composeQualitySystemPrompt,
} from '../../../lib/chat-intent';
import type { ChatMessage, GenerateOptions, TokenEvent } from '../../runtime/types';
import type { ModelConfig } from '../../types';
import { EVAL_MESSAGE_TOPOLOGIES } from '../types';
import type { EvalPromptSpec, EvalRun, EvalRunDevice } from '../types';

// ─── Fakes ───────────────────────────────────────────────────────────────────

const DEVICE: EvalRunDevice = {
  profileKey: 'chromium|high-memory-laptop|webgpu',
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceClass: 'high-memory-laptop',
};

const CAPTURED_PROBE = {
  id: 'cap-t1',
  category: 'captured',
  intent: 'explain',
  prompt: 'so which one should i actually use',
  history: [
    { role: 'user', content: 'compare rust and go' },
    { role: 'assistant', content: 'Rust favors safety; Go favors simplicity.' },
  ],
  judge: ['coherence', 'taskFit'],
} as const satisfies EvalPromptSpec;

/** Minimal fake model — only the fields the harness reads (`id`, `runtime`). */
function fakeModel(id: string, runtime: ModelConfig['runtime'] = 'transformers'): ModelConfig {
  return { id, runtime } as ModelConfig;
}

/**
 * A clock the test drives. Each call returns the current value; `advance` bumps
 * it. The harness reads `now()` at start, per token, and at end — so a script
 * that advances the clock between events controls every timing measurement.
 */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
  };
}

/** A `generate` that yields a fixed script of events. */
function scriptedGenerate(script: TokenEvent[]): EvalGenerationFn {
  return async function* () {
    for (const event of script) yield event;
  };
}

/**
 * Base deps that keep the runner fully offline: no-op `prepareModel` (skips
 * bootstrap/load entirely), fake model lookup, fixed options, fixed system
 * prompt, fixed device, no-op save, deterministic run id. Tests override
 * `prepareModel`/`generate`/`now` (and others) as needed.
 */
function baseDeps(overrides?: Partial<EvalRunnerDeps>): EvalRunnerDeps {
  return {
    prepareModel: async () => {},
    getModel: (id) => fakeModel(id),
    buildOptions: () => ({ temperature: 0.5, maxTokens: 64, topP: 0.9 }),
    buildSystemPrompt: (id) => `system for ${id}`,
    getDevice: () => DEVICE,
    save: () => undefined,
    generateRunId: () => 'run-1',
    now: () => 0,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runEval', () => {
  it('assembles correct EvalResults for a multi-(model,prompt) run', async () => {
    // A clock that advances 10ms before the first token, 5ms per later step.
    const clock = fakeClock();
    let calls = 0;
    const generate: EvalGenerationFn = (_model, _messages, _options) => {
      calls++;
      return (async function* () {
        clock.advance(10); // → first token at +10ms (ttft)
        yield { kind: 'token', text: 'Paris' } satisfies TokenEvent;
        clock.advance(5);
        yield { kind: 'token', text: ' is the capital.' } satisfies TokenEvent;
        clock.advance(5); // total 20ms
        yield { kind: 'done', completionTokens: 7 } satisfies TokenEvent;
      })();
    };

    const run = await runEval(
      { label: 'baseline', modelIds: ['local/qwen3-0.6b'], promptIds: ['fk1'] },
      baseDeps({ generate, now: clock.now }),
    );

    expect(calls).toBe(1);
    expect(run.results).toHaveLength(1);
    const r = run.results[0]!;
    expect(r.promptId).toBe('fk1');
    expect(r.modelId).toBe('local/qwen3-0.6b');
    expect(r.category).toBe('factual-known');
    expect(r.runtimeAdapter).toBe('transformers');
    expect(r.output).toBe('Paris is the capital.');
    expect(r.error).toBeNull();
    // ttft = time to first token = +10ms from start.
    expect(r.perf.ttftMs).toBe(10);
    // completionTokens taken from the 'done' event (worker-side count).
    expect(r.perf.completionTokens).toBe(7);
    // totalMs = 20, so tokensPerSec = 7 / (20/1000) = 350.
    expect(r.perf.totalMs).toBe(20);
    expect(r.perf.tokensPerSec).toBeCloseTo(350, 5);
    expect(r.perf.smokePass).toBe(true);
    // generationOptions captured (the clamped maxTokens, plus temp + topP).
    expect(r.generationOptions).toEqual({ temperature: 0.5, maxTokens: 64, topP: 0.9 });
    // Real rubric ran: fk1 expects 'paris' → exactness should be 1.
    expect(r.scores.exactness).toBe(1);
    // Run envelope.
    expect(run.schemaVersion).toBe(1);
    expect(run.runId).toBe('run-1');
    expect(run.label).toBe('baseline');
    expect(run.device).toEqual(DEVICE);
    expect(run.finishedAt).not.toBeNull();
  });

  it('keeps LiteRT throughput null because its completion count is chunk-proxy accounting', async () => {
    const clock = fakeClock();
    const generate: EvalGenerationFn = () => {
      return (async function* () {
        clock.advance(10);
        yield { kind: 'token', text: 'Gemma' } satisfies TokenEvent;
        clock.advance(10);
        yield { kind: 'done', completionTokens: 7 } satisfies TokenEvent;
      })();
    };

    const run = await runEval(
      { label: 'litert-perf', modelIds: ['candidate/gemma-4-e2b-litert'], promptIds: ['fk1'] },
      baseDeps({
        generate,
        now: clock.now,
        getModel: (id) => fakeModel(id, 'litert'),
      }),
    );

    const result = run.results[0]!;
    expect(result.runtimeAdapter).toBe('litert');
    expect(result.perf.completionTokens).toBe(7);
    expect(result.perf.tokensPerSec).toBeNull();
  });

  it('falls back to token-event count when no completionTokens is reported', async () => {
    const generate = scriptedGenerate([
      { kind: 'token', text: 'a' },
      { kind: 'token', text: 'b' },
      { kind: 'done' }, // no completionTokens
    ]);
    const run = await runEval(
      { label: 'baseline', modelIds: ['m'], promptIds: ['fk1'] },
      baseDeps({ generate }),
    );
    expect(run.results[0]!.perf.completionTokens).toBe(2);
  });

  it('records an error and marks smoke fail when an error event arrives', async () => {
    const generate = scriptedGenerate([
      { kind: 'token', text: 'partial' },
      { kind: 'error', reason: 'worker crashed', code: 'generation-failed' },
    ]);
    const run = await runEval(
      { label: 'baseline', modelIds: ['m'], promptIds: ['fk1'] },
      baseDeps({ generate }),
    );
    const r = run.results[0]!;
    expect(r.error).toBe('worker crashed');
    expect(r.perf.smokePass).toBe(false); // error present → not a pass
    // endedCleanly false flows into the rubric's correctStop via ctx.
    expect(r.output).toBe('partial');
  });

  it('times out a never-ending stream and labels the error', async () => {
    const clock = fakeClock();
    // A stream that keeps yielding tokens, advancing the clock each time.
    const generate: EvalGenerationFn = () =>
      (async function* () {
        for (;;) {
          clock.advance(3);
          yield { kind: 'token', text: 'x' } satisfies TokenEvent;
        }
      })();

    const run = await runEval(
      {
        label: 'baseline',
        modelIds: ['m'],
        promptIds: ['fk1'],
        perGenerationTimeoutMs: 10, // trips after ~4 tokens (12ms elapsed)
      },
      baseDeps({ generate, now: clock.now }),
    );
    const r = run.results[0]!;
    expect(r.error).toBe('timeout: exceeded 10ms');
    expect(r.perf.smokePass).toBe(false); // error present
    expect(r.perf.completionTokens).toBeGreaterThan(0); // tokens were produced
  });

  it('marks hitTokenCap when completionTokens >= the requested cap', async () => {
    const generate = scriptedGenerate([
      { kind: 'token', text: 'x' },
      { kind: 'done', completionTokens: 8 },
    ]);
    const run = await runEval(
      {
        label: 'baseline',
        modelIds: ['m'],
        promptIds: ['cv1'], // free-form chat prompt (no exactness check)
        maxTokensCap: 8, // clamp request to 8 → completionTokens(8) >= 8
      },
      baseDeps({ generate }),
    );
    const r = run.results[0]!;
    expect(r.generationOptions.maxTokens).toBe(8);
    // hitTokenCap drives correctStop to 0.5 in the rubric.
    expect(r.scores.correctStop).toBe(0.5);
  });

  it('does NOT count prepareModel time against the stream timeout', async () => {
    const clock = fakeClock();
    // prepareModel takes a "long" cold-load: advance the clock 10_000ms — far
    // past the 50ms stream timeout — BEFORE resolving. If the deadline started
    // at/under prepare, this would falsely time out.
    const prepareModel: EvalPrepareModelFn = async () => {
      clock.advance(10_000);
    };
    // A normal fast stream: a couple of cheap tokens, a few ms each.
    const generate: EvalGenerationFn = () =>
      (async function* () {
        clock.advance(2);
        yield { kind: 'token', text: 'a' } satisfies TokenEvent;
        clock.advance(2);
        yield { kind: 'done', completionTokens: 1 } satisfies TokenEvent;
      })();

    const run = await runEval(
      {
        label: 'baseline',
        modelIds: ['m'],
        promptIds: ['fk1'],
        perGenerationTimeoutMs: 50, // far less than the 10s prepare
      },
      baseDeps({ prepareModel, generate, now: clock.now }),
    );
    const r = run.results[0]!;
    // The stream ran in ~4ms; prepare's 10s is outside the timed window.
    expect(r.error).toBeNull();
    expect(r.perf.smokePass).toBe(true);
    expect(r.perf.ttftMs).toBe(2); // first token at +2ms from stream start, not +10_002ms
  });

  it('calls prepareModel once per model, not once per prompt', async () => {
    const prepareModel = vi.fn<EvalPrepareModelFn>(async () => {});
    const generate = scriptedGenerate([
      { kind: 'token', text: 'x' },
      { kind: 'done', completionTokens: 1 },
    ]);
    await runEval(
      // 2 models × 3 prompts: prepare should fire 2 times, generate 6 times.
      { label: 'baseline', modelIds: ['m1', 'm2'], promptIds: ['fk1', 'm1', 'if1'] },
      baseDeps({ prepareModel, generate }),
    );
    expect(prepareModel).toHaveBeenCalledTimes(2);
    expect(prepareModel.mock.calls.map((c) => c[0].id)).toEqual(['m1', 'm2']);
  });

  it('records error results for a model whose prepareModel throws, and keeps going', async () => {
    // m1 fails to load; m2 loads fine. The run must finalize with both models'
    // results — m1 as load errors, m2 as real generations.
    const prepareModel: EvalPrepareModelFn = async (model) => {
      if (model.id === 'm1') throw new Error('cooldown active');
    };
    const generate = scriptedGenerate([
      { kind: 'token', text: 'ok' },
      { kind: 'done', completionTokens: 1 },
    ]);
    const save = vi.fn<(run: EvalRun) => void>();
    const run = await runEval(
      { label: 'baseline', modelIds: ['m1', 'm2'], promptIds: ['fk1', 'm1'] },
      baseDeps({ prepareModel, generate, save }),
    );

    expect(run.results).toHaveLength(4); // 2 models × 2 prompts, none skipped
    const m1 = run.results.filter((r) => r.modelId === 'm1');
    const m2 = run.results.filter((r) => r.modelId === 'm2');
    expect(m1).toHaveLength(2);
    for (const r of m1) {
      expect(r.error).toContain('load failed');
      expect(r.error).toContain('cooldown active');
      expect(r.runtimeAdapter).toBe('transformers'); // known model → known adapter
      expect(r.perf.smokePass).toBe(false);
    }
    for (const r of m2) {
      expect(r.error).toBeNull();
      expect(r.perf.smokePass).toBe(true);
    }
    expect(save).toHaveBeenCalledTimes(1); // run still finalizes once
  });

  it('emits an error progress event when prepareModel throws', async () => {
    const events: EvalProgress[] = [];
    const prepareModel: EvalPrepareModelFn = async () => {
      throw new Error('init-failed');
    };
    await runEval(
      {
        label: 'baseline',
        modelIds: ['m'],
        promptIds: ['fk1'],
        onProgress: (p) => events.push(p),
      },
      baseDeps({ prepareModel }),
    );
    const errorEvents = events.filter((e) => e.phase === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.note).toBe('load failed');
  });

  it('finalizes with no results when config.signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn<EvalGenerationFn>();

    const run = await runEval(
      { label: 'baseline', modelIds: ['m1', 'm2'], promptIds: ['fk1'], signal: controller.signal },
      baseDeps({ generate }),
    );
    expect(generate).not.toHaveBeenCalled();
    expect(run.results).toHaveLength(0);
    expect(run.finishedAt).not.toBeNull();
  });

  it('calls save exactly once with the assembled run', async () => {
    const save = vi.fn<(run: EvalRun) => void>();
    const generate = scriptedGenerate([
      { kind: 'token', text: 'ok' },
      { kind: 'done', completionTokens: 1 },
    ]);
    const run = await runEval(
      { label: 'after-phase-1', modelIds: ['m'], promptIds: ['fk1'] },
      baseDeps({ generate, save }),
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(run);
    expect(save.mock.calls[0]![0].label).toBe('after-phase-1');
  });

  it('records an error result per prompt for an unknown model without throwing', async () => {
    const generate = vi.fn<EvalGenerationFn>();
    const run = await runEval(
      { label: 'baseline', modelIds: ['ghost/model'], promptIds: ['fk1', 'm1'] },
      baseDeps({ generate, getModel: () => null }),
    );
    expect(generate).not.toHaveBeenCalled();
    expect(run.results).toHaveLength(2);
    for (const r of run.results) {
      expect(r.error).toContain('unknown model');
      expect(r.runtimeAdapter).toBe('unknown');
      expect(r.perf.smokePass).toBe(false);
    }
  });

  it('fires progress callbacks across phases', async () => {
    const events: EvalProgress[] = [];
    const generate = scriptedGenerate([
      { kind: 'token', text: 'hi' },
      { kind: 'done', completionTokens: 1 },
    ]);
    await runEval(
      {
        label: 'baseline',
        modelIds: ['m'],
        promptIds: ['fk1'],
        onProgress: (p) => events.push(p),
      },
      baseDeps({ generate }),
    );
    const phases = events.map((e) => e.phase);
    expect(phases).toContain('loading');
    expect(phases).toContain('generating');
    expect(phases).toContain('scoring');
    expect(phases).toContain('model-done');
    expect(phases).toContain('run-done');
    // total is models * prompts; completed reaches total by the end.
    const last = events.at(-1)!;
    expect(last.phase).toBe('run-done');
    expect(last.completed).toBe(last.total);
    expect(last.total).toBe(1);
  });

  it('runs the full grid across multiple models and prompts', async () => {
    const generate = scriptedGenerate([
      { kind: 'token', text: 'a' },
      { kind: 'done', completionTokens: 1 },
    ]);
    const run = await runEval(
      { label: 'baseline', modelIds: ['m1', 'm2'], promptIds: ['fk1', 'm1', 'if1'] },
      baseDeps({ generate }),
    );
    expect(run.results).toHaveLength(6); // 2 models × 3 prompts
    expect(new Set(run.results.map((r) => r.modelId))).toEqual(new Set(['m1', 'm2']));
  });

  it('clamps maxTokens to the cap when the profile asks for more', async () => {
    const generate = scriptedGenerate([
      { kind: 'token', text: 'x' },
      { kind: 'done', completionTokens: 1 },
    ]);
    const run = await runEval(
      { label: 'baseline', modelIds: ['m'], promptIds: ['fk1'], maxTokensCap: 32 },
      // buildOptions asks for 64, cap is 32 → clamp to 32.
      baseDeps({ generate, buildOptions: () => ({ temperature: 0.5, maxTokens: 64 }) }),
    );
    expect(run.results[0]!.generationOptions.maxTokens).toBe(32);
  });

  it('routes litert models to the litert runtime adapter', async () => {
    const generate = scriptedGenerate([
      { kind: 'token', text: 'x' },
      { kind: 'done', completionTokens: 1 },
    ]);
    const run = await runEval(
      { label: 'baseline', modelIds: ['w'], promptIds: ['fk1'] },
      baseDeps({ generate, getModel: (id) => fakeModel(id, 'litert') }),
    );
    expect(run.results[0]!.runtimeAdapter).toBe('litert');
  });

  it('passes the production system prompt and user prompt to generate', async () => {
    const seen: { messages: ChatMessage[]; options: GenerateOptions }[] = [];
    const generate: EvalGenerationFn = (_model, messages, options) => {
      seen.push({ messages, options });
      return (async function* () {
        yield { kind: 'done', completionTokens: 0 } satisfies TokenEvent;
      })();
    };
    const run = await runEval(
      { label: 'baseline', modelIds: ['m'], promptIds: ['fk1'] },
      baseDeps({ generate }),
    );
    expect(seen).toHaveLength(1);
    const { messages, options } = seen[0]!;
    // Production composition (Wave 2.6 Stage 1): the system message is the
    // BASE prompt only — hints ride user turns. fk1 is a quick probe (empty
    // hint), so its user turn is the raw prompt.
    expect(messages[0]).toEqual({ role: 'system', content: 'system for m' });
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toBe('What is the capital of France?');
    // A signal is always injected (timeout/abort wiring).
    expect(options.signal).toBeInstanceOf(AbortSignal);

    // Honest 0-completion-tokens path: a runtime that reports completionTokens: 0
    // (e.g. think-only / empty visible output) must be recorded AS ZERO, not
    // silently coerced to the token-event count. Pins `?? ` over `||` so a
    // future regression can't make a 0-token generation look productive.
    const r = run.results[0]!;
    expect(r.perf.completionTokens).toBe(0);
    expect(r.perf.tokensPerSec).toBeNull();
    expect(r.perf.smokePass).toBe(false);
  });
});

// ─── Multi-turn + extra prompts (failure-capture loop, chat #7 W2.1) ─────────

describe('runEval — captured probes', () => {
  function recordingGenerate(seen: ChatMessage[][]): EvalGenerationFn {
    return (_model, messages) => {
      seen.push(messages);
      return (async function* () {
        yield { kind: 'token', text: 'ok' } satisfies TokenEvent;
        yield { kind: 'done', completionTokens: 1 } satisfies TokenEvent;
      })();
    };
  }

  it('replays history between the system prompt and the failing user turn', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'felt',
        modelIds: ['m'],
        promptIds: ['cap-t1'],
        extraPrompts: [CAPTURED_PROBE],
      },
      baseDeps({ generate: recordingGenerate(seen) }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      // Stage-1 composition: base-only system; history user turns re-hinted
      // exactly as production re-renders them ("compare rust and go" routes
      // deep via DEEP_RE → deep hint appended); the final user turn carries
      // the spec-intent (explain) hint.
      { role: 'system', content: 'system for m' },
      { role: 'user', content: buildHintedUserTurn('compare rust and go', 'deep', true, 'm') },
      { role: 'assistant', content: 'Rust favors safety; Go favors simplicity.' },
      {
        role: 'user',
        content: buildHintedUserTurn('so which one should i actually use', 'explain', true, 'm'),
      },
    ]);
    const r = run.results[0]!;
    expect(r.promptId).toBe('cap-t1');
    expect(r.category).toBe('captured');
    expect(r.error).toBeNull();
  });

  it('carries the figures an earlier turn stated into the probed turn', async () => {
    // ★ STANDING NET. The harness composes its own message list, so a probe can
    // silently stop mirroring dispatch — which is how a derived probe set has
    // twice gone unwired here. If this breaks, a before/after run of the recap
    // change is measuring nothing, and would report "no effect" either way.
    const seen: ChatMessage[][] = [];
    await runEval(
      {
        label: 'felt',
        modelIds: ['m'],
        promptIds: ['budget-t1'],
        extraPrompts: [
          {
            id: 'budget-t1',
            category: 'captured',
            intent: 'explain',
            prompt: 'write it out as a list i can stick on the fridge',
            history: [
              { role: 'user', content: 'take home was 2690 a month now its 2180' },
              { role: 'assistant', content: 'Right, list what leaves your account.' },
              { role: 'user', content: 'rent 745. council tax 142. water 31.' },
              { role: 'assistant', content: 'Total out: 918.' },
            ],
          } as const satisfies EvalPromptSpec,
        ],
      },
      baseDeps({ generate: recordingGenerate(seen) }),
    );

    const probedTurn = seen[0]!.at(-1)!.content;
    expect(probedTurn).toContain('2180');
    expect(probedTurn).toContain('rent 745');
    // Derived from the turns BEFORE it, never from its own text.
    expect(probedTurn.startsWith('write it out as a list')).toBe(true);
  });

  it('includes extra prompts after the fixed pool in a default run', async () => {
    const seen: ChatMessage[][] = [];
    const { EVAL_PROMPTS } = await import('../prompts');
    const { FELT_PROBES } = await import('../felt-probes');
    const { SHAPE_PROBES } = await import('../shape-probes');
    const run = await runEval(
      { label: 'felt', modelIds: ['m'], extraPrompts: [CAPTURED_PROBE] },
      baseDeps({ generate: recordingGenerate(seen) }),
    );
    expect(run.results).toHaveLength(
      EVAL_PROMPTS.length + SHAPE_PROBES.length + FELT_PROBES.length + 1,
    );
    expect(run.results.at(-1)!.promptId).toBe('cap-t1');
  });

  it('dedupes an extra prompt whose id collides with a fixed prompt', async () => {
    const seen: ChatMessage[][] = [];
    const collider = { ...CAPTURED_PROBE, id: 'fk1', prompt: 'SHOULD NEVER RUN' };
    await runEval(
      { label: 'felt', modelIds: ['m'], promptIds: ['fk1'], extraPrompts: [collider] },
      baseDeps({ generate: recordingGenerate(seen) }),
    );
    expect(seen).toHaveLength(1);
    // The FIXED fk1 wins — the colliding extra never reaches the model.
    expect(seen[0]!.at(-1)!.content).toBe('What is the capital of France?');
  });
});

// ─── Answer-shape composition (Wave 2.6 Stage 0) ─────────────────────────────

describe('runEval — answer-shape composition', () => {
  function recordingGenerate(seen: ChatMessage[][]): EvalGenerationFn {
    return (_model, messages) => {
      seen.push(messages);
      return (async function* () {
        yield { kind: 'token', text: 'ok' } satisfies TokenEvent;
        yield { kind: 'done', completionTokens: 1 } satisfies TokenEvent;
      })();
    };
  }

  it('places the spec-intent hint at the end of the user turn (production fidelity)', async () => {
    const seen: ChatMessage[][] = [];
    // as1 is a deep-intent (teaching-shaped) probe in the default pool.
    await runEval(
      { label: 'shape', modelIds: ['m'], promptIds: ['as1'] },
      baseDeps({ generate: recordingGenerate(seen) }),
    );
    expect(seen).toHaveLength(1);
    const [system, user] = [seen[0]![0]!, seen[0]!.at(-1)!];
    const deepHint = buildTurnQualityInstruction('deep', true, 'm');
    // System front is the BASE prompt only — KV-stable across intent changes.
    expect(system).toEqual({ role: 'system', content: 'system for m' });
    // The hint rides the END of the user turn.
    expect(user.role).toBe('user');
    expect(user.content).toBe(`please teach me how to invest\n\n${deepHint}`);
  });

  it('excludes research arms by default and includes them with includeResearchArms', async () => {
    const { SHAPE_RESEARCH_ARMS } = await import('../shape-probes');
    const armIds = SHAPE_RESEARCH_ARMS.map((p) => p.id);

    const defaultRun = await runEval(
      { label: 'shape', modelIds: ['m'], promptIds: armIds },
      baseDeps({ generate: recordingGenerate([]) }),
    );
    // promptIds that only name arms select nothing from the default pool.
    expect(defaultRun.results).toHaveLength(0);

    const armsRun = await runEval(
      { label: 'shape', modelIds: ['m'], promptIds: armIds, includeResearchArms: true },
      baseDeps({ generate: recordingGenerate([]) }),
    );
    expect(armsRun.results.map((r) => r.promptId)).toEqual(armIds);
  });

  it("hintPlacement 'system' arms reproduce the pre-Stage-1 composition (counterfactual)", async () => {
    const seen: ChatMessage[][] = [];
    await runEval(
      {
        label: 'shape',
        modelIds: ['m'],
        promptIds: ['as4-syshint'],
        includeResearchArms: true,
      },
      baseDeps({ generate: recordingGenerate(seen) }),
    );
    expect(seen).toHaveLength(1);
    const [system, user] = [seen[0]![0]!, seen[0]!.at(-1)!];
    const deepHint = buildTurnQualityInstruction('deep', true, 'm');
    // The retired composition: hint joined into the system front…
    expect(system.content).toBe(composeQualitySystemPrompt('system for m', 'deep', true, 'm'));
    expect(system.content).toContain(deepHint);
    // …and the user turn stays raw.
    expect(user).toEqual({ role: 'user', content: 'give me some tips on negotiating a raise' });
  });

  it('can run the system-front topology counterfactual without prompt-level arms', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'shape-system-front',
        modelIds: ['m'],
        promptIds: ['as1'],
        messageTopology: 'system-front-hints',
      },
      baseDeps({ generate: recordingGenerate(seen) }),
    );
    expect(seen).toHaveLength(1);
    const [system, user] = [seen[0]![0]!, seen[0]!.at(-1)!];
    const deepHint = buildTurnQualityInstruction('deep', true, 'm');
    expect(system.content).toBe(composeQualitySystemPrompt('system for m', 'deep', true, 'm'));
    expect(system.content).toContain(deepHint);
    expect(user).toEqual({ role: 'user', content: 'please teach me how to invest' });
    expect(run.config?.messageTopology).toBe('system-front-hints');
  });

  it('can run the Gemma-native user-contract topology without a system role', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'gemma-native',
        modelIds: ['candidate/gemma-4-e2b-litert'],
        promptIds: ['as1'],
        messageTopology: 'gemma-native-user-contract',
      },
      baseDeps({
        generate: recordingGenerate(seen),
        getModel: (id) => fakeModel(id, 'litert'),
      }),
    );

    expect(EVAL_MESSAGE_TOPOLOGIES).toContain('gemma-native-user-contract');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.some((m) => m.role === 'system')).toBe(false);
    const firstUser = seen[0]![0]!;
    expect(firstUser.role).toBe('user');
    expect(firstUser.content).toContain('You are Eco, a private on-device assistant.');
    expect(firstUser.content).toContain('User task:');
    expect(firstUser.content).toContain('please teach me how to invest');
    expect(firstUser.content).not.toContain(buildTurnQualityInstruction('deep', true, 'candidate/gemma-4-e2b-litert'));
    expect(run.config?.messageTopology).toBe('gemma-native-user-contract');
  });

  it('folds the Gemma-native contract into the first history user turn', async () => {
    const seen: ChatMessage[][] = [];
    await runEval(
      {
        label: 'gemma-native-history',
        modelIds: ['candidate/gemma-4-e2b-litert'],
        promptIds: ['cap-t1'],
        messageTopology: 'gemma-native-user-contract',
        extraPrompts: [CAPTURED_PROBE],
      },
      baseDeps({
        generate: recordingGenerate(seen),
        getModel: (id) => fakeModel(id, 'litert'),
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(seen[0]![0]!.content).toContain('You are Eco, a private on-device assistant.');
    expect(seen[0]![0]!.content).toContain('compare rust and go');
    expect(seen[0]![1]).toEqual({ role: 'assistant', content: 'Rust favors safety; Go favors simplicity.' });
    expect(seen[0]![2]).toEqual({ role: 'user', content: 'so which one should i actually use' });
  });

  it('records a privacy-safe prompt trace for every result', async () => {
    const run = await runEval(
      {
        label: 'trace',
        modelIds: ['candidate/gemma-4-e2b-litert'],
        promptIds: ['as1'],
        messageTopology: 'gemma-native-user-contract',
      },
      baseDeps({
        generate: recordingGenerate([]),
        getModel: (id) => fakeModel(id, 'litert'),
      }),
    );

    expect(run.results[0]!.promptTrace).toEqual({
      roleSequence: ['user'],
      systemMessageCount: 0,
      firstUserContract: 'gemma-native-eco-contract',
      qualityHintPlacement: 'first-user-contract',
      promptContractId: 'gemma-native-eco-contract-v1',
      messageTextHash: expect.stringMatching(/^[0-9a-f]{8}$/),
    });
  });

  it('keeps prompt trace hashes stable across different raw user text with the same topology contract', async () => {
    const first = await runEval(
      {
        label: 'trace-private',
        modelIds: ['candidate/gemma-4-e2b-litert'],
        promptIds: ['trace-private'],
        messageTopology: 'gemma-native-user-contract',
        extraPrompts: [
          {
            id: 'trace-private',
            category: 'captured',
            intent: 'explain',
            prompt: 'private captured prompt alpha',
          },
        ],
      },
      baseDeps({ generate: recordingGenerate([]), getModel: (id) => fakeModel(id, 'litert') }),
    );
    const second = await runEval(
      {
        label: 'trace-b',
        modelIds: ['candidate/gemma-4-e2b-litert'],
        promptIds: ['trace-private'],
        messageTopology: 'gemma-native-user-contract',
        extraPrompts: [
          {
            id: 'trace-private',
            category: 'captured',
            intent: 'explain',
            prompt: 'completely different private captured prompt beta',
          },
        ],
      },
      baseDeps({ generate: recordingGenerate([]), getModel: (id) => fakeModel(id, 'litert') }),
    );

    expect(first.results[0]!.promptTrace?.messageTextHash).toBe(second.results[0]!.promptTrace?.messageTextHash);
  });

  it('arm options come from spec.intent (deep treatment on both arm kinds)', async () => {
    const seenIntents: string[] = [];
    await runEval(
      {
        label: 'shape',
        modelIds: ['m'],
        promptIds: ['as4-explicit', 'as4-syshint'],
        includeResearchArms: true,
      },
      baseDeps({
        generate: recordingGenerate([]),
        buildOptions: (_modelId, intent) => {
          seenIntents.push(intent);
          return { temperature: 0.5, maxTokens: 64 };
        },
      }),
    );
    expect(seenIntents).toEqual(['deep', 'deep']);
  });
});

// ─── Decode mode + run fingerprint ────────────────────────────────────────────

describe('runEval — decode mode + config fingerprint', () => {
  /** A `generate` that records the options it was handed, then yields one token. */
  function optionRecordingGenerate(seen: GenerateOptions[]): EvalGenerationFn {
    return (_model, _messages, options) => {
      seen.push(options);
      return (async function* () {
        yield { kind: 'token', text: 'x' } satisfies TokenEvent;
        yield { kind: 'done', completionTokens: 1 } satisfies TokenEvent;
      })();
    };
  }

  it('greedy mode collapses to temperature 0, drops sampling knobs, stamps fingerprint', async () => {
    const seen: GenerateOptions[] = [];
    const run = await runEval(
      { label: 'greedy', modelIds: ['m'], promptIds: ['fk1'], samplingMode: 'greedy' },
      // baseDeps.buildOptions returns { temperature: 0.5, maxTokens: 64, topP: 0.9 }.
      baseDeps({ generate: optionRecordingGenerate(seen) }),
    );
    // The runtime saw deterministic argmax: temperature 0, no nucleus knob.
    expect(seen[0]!.temperature).toBe(0);
    expect(seen[0]!.topP).toBeUndefined();
    expect(seen[0]!.maxTokens).toBe(64);
    // Recorded options stripped to the greedy pair (no misleading topP).
    expect(run.results[0]!.generationOptions).toEqual({ temperature: 0, maxTokens: 64 });
    // Fingerprint records the arm so a greedy run is never silently diffed against a sampled one.
    expect(run.config?.messageTopology).toBe('production-user-turn-hints');
    expect(run.config?.samplingMode).toBe('greedy');
    expect(run.config?.promptCount).toBe(1);
    expect(run.config?.harnessVersion).toBe(1);
    expect(run.config?.includeResearchArms).toBe(false);
    expect(run.config?.samplesPerProbe).toBe(1);
    expect(run.config?.compositionEra).toBe('wave2.6-stage1-user-turn-hints');
    expect(run.config?.promptSetHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('defaults to sampled — keeps the full profile and fingerprints it', async () => {
    const seen: GenerateOptions[] = [];
    const run = await runEval(
      { label: 'sampled', modelIds: ['m'], promptIds: ['fk1'] },
      baseDeps({ generate: optionRecordingGenerate(seen) }),
    );
    expect(seen[0]!.temperature).toBe(0.5);
    expect(seen[0]!.topP).toBe(0.9);
    expect(run.results[0]!.generationOptions).toEqual({ temperature: 0.5, maxTokens: 64, topP: 0.9 });
    expect(run.config?.messageTopology).toBe('production-user-turn-hints');
    expect(run.config?.samplingMode).toBe('sampled');
  });

  it('keeps promptSetHash stable when raw prompt and history content change under the same metadata', async () => {
    const generate = optionRecordingGenerate([]);
    const deps = baseDeps({ generate });
    const first = await runEval(
      {
        label: 'hash-content-a',
        modelIds: ['m'],
        promptIds: ['hash-probe'],
        messageTopology: 'gemma-native-user-contract',
        extraPrompts: [
          {
            id: 'hash-probe',
            category: 'captured',
            intent: 'quick',
            prompt: 'private captured prompt alpha',
            history: [
              { role: 'user', content: 'private history alpha' },
              { role: 'assistant', content: 'private answer alpha' },
            ],
            requireLineCount: 3,
          },
        ],
      },
      deps,
    );
    const second = await runEval(
      {
        label: 'hash-content-b',
        modelIds: ['m'],
        promptIds: ['hash-probe'],
        messageTopology: 'gemma-native-user-contract',
        extraPrompts: [
          {
            id: 'hash-probe',
            category: 'captured',
            intent: 'quick',
            prompt: 'completely different private captured prompt beta',
            history: [
              { role: 'user', content: 'private history beta' },
              { role: 'assistant', content: 'private answer beta' },
            ],
            requireLineCount: 3,
          },
        ],
      },
      deps,
    );

    expect(first.config?.promptSetHash).toMatch(/^[0-9a-f]{8}$/);
    expect(second.config?.promptSetHash).toMatch(/^[0-9a-f]{8}$/);
    expect(second.config?.promptSetHash).toBe(first.config?.promptSetHash);
  });

  async function promptSetHashForJsonKeys(requireJsonKeys: string[]): Promise<string> {
    const run = await runEval(
      {
        label: 'hash-json',
        modelIds: ['m'],
        promptIds: ['hash-json-probe'],
        extraPrompts: [
          {
            id: 'hash-json-probe',
            category: 'format-json',
            intent: 'quick',
            prompt: 'private raw prompt text is not part of the hash',
            requireJsonKeys,
          },
        ],
      },
      baseDeps({ generate: optionRecordingGenerate([]) }),
    );
    return run.config?.promptSetHash ?? '';
  }

  it('changes promptSetHash when same-count JSON scoring key names change', async () => {
    const nameAge = await promptSetHashForJsonKeys(['name', 'age']);
    const cityCountry = await promptSetHashForJsonKeys(['city', 'country']);

    expect(nameAge).toMatch(/^[0-9a-f]{8}$/);
    expect(cityCountry).toMatch(/^[0-9a-f]{8}$/);
    expect(cityCountry).not.toBe(nameAge);
  });

  it('keeps promptSetHash stable when JSON scoring key order changes', async () => {
    const nameAge = await promptSetHashForJsonKeys(['name', 'age']);
    const ageName = await promptSetHashForJsonKeys(['age', 'name']);

    expect(nameAge).toMatch(/^[0-9a-f]{8}$/);
    expect(ageName).toMatch(/^[0-9a-f]{8}$/);
    expect(ageName).toBe(nameAge);
  });

  it('changes promptSetHash when scoring semantics change for the same prompt metadata', async () => {
    const generate = optionRecordingGenerate([]);
    const deps = baseDeps({ generate });
    const withoutConstraint = await runEval(
      {
        label: 'hash-a',
        modelIds: ['m'],
        promptIds: ['hash-probe'],
        extraPrompts: [
          {
            id: 'hash-probe',
            category: 'instruction-following',
            intent: 'quick',
            prompt: 'return three short lines',
            requireLineCount: 3,
          },
        ],
      },
      deps,
    );
    const withConstraint = await runEval(
      {
        label: 'hash-b',
        modelIds: ['m'],
        promptIds: ['hash-probe'],
        extraPrompts: [
          {
            id: 'hash-probe',
            category: 'instruction-following',
            intent: 'quick',
            prompt: 'different private raw prompt text is not part of the hash',
            requireLineCount: 3,
            requireBulletLines: true,
            forbidBullets: true,
          },
        ],
      },
      deps,
    );

    expect(withoutConstraint.config?.promptSetHash).toMatch(/^[0-9a-f]{8}$/);
    expect(withConstraint.config?.promptSetHash).toMatch(/^[0-9a-f]{8}$/);
    expect(withConstraint.config?.promptSetHash).not.toBe(withoutConstraint.config?.promptSetHash);
  });

  it('runs multiple samples per prompt and records sample indexes', async () => {
    let calls = 0;
    const run = await runEval(
      { label: 'sampled-n3', modelIds: ['m'], promptIds: ['fk1'], samplesPerProbe: 3 },
      baseDeps({
        generate: () => {
          calls++;
          return (async function* () {
            yield { kind: 'token', text: `Paris ${String(calls)}` } satisfies TokenEvent;
            yield { kind: 'done', completionTokens: 1 } satisfies TokenEvent;
          })();
        },
      }),
    );

    expect(calls).toBe(3);
    expect(run.results).toHaveLength(3);
    expect(run.results.map((r) => r.sampleIndex)).toEqual([1, 2, 3]);
    expect(run.results.map((r) => r.output)).toEqual(['Paris 1', 'Paris 2', 'Paris 3']);
    expect(run.config?.samplesPerProbe).toBe(3);
  });

  it('records the judge dims a probe requested (and omits the field otherwise)', async () => {
    const run = await runEval(
      { label: 'judge', modelIds: ['m'], promptIds: ['r1', 'fk1'] },
      baseDeps({
        generate: scriptedGenerate([
          { kind: 'token', text: 'x' },
          { kind: 'done', completionTokens: 1 },
        ]),
      }),
    );
    const r1 = run.results.find((r) => r.promptId === 'r1')!;
    const fk1 = run.results.find((r) => r.promptId === 'fk1')!;
    expect(r1.judge).toEqual(['taskFit']);
    expect(fk1.judge).toBeUndefined();
  });
});
