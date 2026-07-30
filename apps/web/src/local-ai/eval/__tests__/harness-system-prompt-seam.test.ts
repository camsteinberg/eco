// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * ★ THE SEAM TEST: does an everyday-arm generation actually carry the PRODUCTION
 * system prompt?
 *
 * Every other harness test injects `buildSystemPrompt` (`'system for m'`), so
 * none of them can answer that question — and an A/B arm that swaps a prompt the
 * harness never sends would produce a confident, wrong result. These tests run
 * `runEval` with the system-prompt dependency LEFT AT ITS DEFAULT against a REAL
 * catalog model id, so what is asserted is the string the runtime is handed.
 *
 * The third case is the negative one and the reason this file exists: under the
 * `gemma-native-user-contract` topology the base system prompt is DISCARDED, so
 * any arm that works by rewriting that prompt measures nothing there. The arm
 * table's guards read that fact out; this test pins the fact itself.
 */

import { describe, expect, it } from 'vitest';

import { getOnDeviceSystemPrompt } from '../../../lib/system-prompt';
import { runEval } from '../harness';
import type { EvalGenerationFn, EvalRunnerDeps } from '../harness';
import {
  ADD_CONTEXT_CLAUSE_CONDITIONED,
  ADD_CONTEXT_CLAUSE_SHIPPED,
} from '../everyday-arms';
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
    expect(system.content).toContain(ADD_CONTEXT_CLAUSE_SHIPPED);
  });

  it('an everyday arm rewrites THAT prompt, not a stand-in', async () => {
    const seen: ChatMessage[][] = [];
    await runEval(
      {
        label: 'seam-arm',
        modelIds: [REAL_MODEL_ID],
        promptIds: ['fk1'],
        everydayArm: 'no-add-context',
      },
      seamDeps(seen),
    );

    const system = seen[0]![0]!;
    expect(system.content).toContain(ADD_CONTEXT_CLAUSE_CONDITIONED);
    expect(system.content).not.toContain(ADD_CONTEXT_CLAUSE_SHIPPED);
    // Only the clause moved: the rest of the production prompt survives verbatim.
    const shipped = getOnDeviceSystemPrompt(REAL_MODEL_ID);
    const [head, tail] = shipped.split(ADD_CONTEXT_CLAUSE_SHIPPED);
    expect(system.content).toBe(`${head}${ADD_CONTEXT_CLAUSE_CONDITIONED}${tail}`);
  });

  it('★ the gemma-native topology DISCARDS the base prompt — a prompt arm is inert there', async () => {
    const seen: ChatMessage[][] = [];
    await runEval(
      {
        label: 'seam-gemma',
        modelIds: ['candidate/gemma-4-e2b-litert'],
        promptIds: ['fk1'],
        messageTopology: 'gemma-native-user-contract',
        everydayArm: 'no-add-context',
      },
      seamDeps(seen),
    );

    const messages = seen[0]!;
    expect(messages.some((m) => m.role === 'system')).toBe(false);
    // Neither the shipped clause nor the arm's counterfactual reaches the model,
    // so this run would report a clean zero for a change never applied.
    const joined = messages.map((m) => m.content).join('\n');
    expect(joined).not.toContain(ADD_CONTEXT_CLAUSE_SHIPPED);
    expect(joined).not.toContain(ADD_CONTEXT_CLAUSE_CONDITIONED);
  });
});
