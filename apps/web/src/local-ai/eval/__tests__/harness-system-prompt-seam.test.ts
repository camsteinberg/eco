// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * ★ THE SEAM TEST: does a harness generation actually carry the PRODUCTION
 * system prompt?
 *
 * Every other harness test injects `buildSystemPrompt` (`'system for m'`), so
 * none of them can answer that question. These tests run `runEval` with the
 * system-prompt dependency LEFT AT ITS DEFAULT against a REAL catalog model id,
 * so what is asserted is the string the runtime is handed.
 *
 * The remaining arms (`control`, `ngram-off`) only affect generation options,
 * not the system prompt, so the seam test no longer needs prompt-rewriting arm
 * cases (those were retired with `no-add-context` and `posture-direct` on
 * 2026-08-26 when the posture-direct treatment shipped as the production prompt).
 */

import { describe, expect, it } from 'vitest';

import { getOnDeviceSystemPrompt } from '../../../lib/system-prompt';
import { runEval } from '../harness';
import type { EvalGenerationFn, EvalRunnerDeps } from '../harness';
import type { ChatMessage, TokenEvent } from '../../runtime/types';

/** A real, shipping catalog id — so the model `systemDirective` suffix is exercised too. */
const REAL_MODEL_ID = 'candidate/qwen3.5-2b-onnx';

function recordingGenerate(seen: ChatMessage[][]): EvalGenerationFn {
  return (_model, messages) => {
    seen.push(messages);
    return (async function* () {
      yield { kind: 'token', text: 'ok' } satisfies TokenEvent;
      yield { kind: 'done', completionTokens: 1 } satisfies TokenEvent;
    })();
  };
}

/**
 * Offline deps that leave `buildSystemPrompt` and `getModel` at their production
 * defaults — the whole point of this file.
 */
function seamDeps(seen: ChatMessage[][]): EvalRunnerDeps {
  return {
    prepareModel: async () => {},
    generate: recordingGenerate(seen),
    getDevice: () => ({
      profileKey: 'test',
      browserClass: 'chromium',
      webgpuSupport: 'webgpu',
      deviceClass: 'high-memory-laptop',
    }),
    save: () => undefined,
    generateRunId: () => 'run-seam',
    now: () => 0,
  };
}

describe('★ harness system-prompt seam', () => {
  it('sends the REAL production on-device prompt, suffix and all', async () => {
    const seen: ChatMessage[][] = [];
    await runEval(
      { label: 'seam', modelIds: [REAL_MODEL_ID], promptIds: ['fk1'] },
      seamDeps(seen),
    );

    expect(seen).toHaveLength(1);
    const system = seen[0]![0]!;
    expect(system.role).toBe('system');
    // Byte-identical to what `useChat.buildSystemPrompt` pushes for this model.
    expect(system.content).toBe(getOnDeviceSystemPrompt(REAL_MODEL_ID));
    // The shipped prompt carries the open-vs-closed posture, not the old
    // elaboration push.
    expect(system.content).toContain('let the question decide');
  });

  it('★ the gemma-native topology DISCARDS the base prompt', async () => {
    const seen: ChatMessage[][] = [];
    await runEval(
      {
        label: 'seam-gemma',
        modelIds: ['candidate/gemma-4-e2b-litert'],
        promptIds: ['fk1'],
        messageTopology: 'gemma-native-user-contract',
      },
      seamDeps(seen),
    );

    const messages = seen[0]!;
    expect(messages.some((m) => m.role === 'system')).toBe(false);
  });
});
