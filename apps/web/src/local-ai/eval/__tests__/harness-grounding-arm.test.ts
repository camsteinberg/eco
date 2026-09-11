// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * ★ THE ARM TEST: with `groundingArm: 'fixture'`, does the checked-in web
 * snippet actually reach the model — and ONLY on the probes it is meant to?
 *
 * Every assertion reads the messages the generate seam was handed, so what is
 * pinned is the prompt a model would see, not an intention recorded in a
 * comment. Non-vacuity runs both ways: the fence must be present in the
 * `fixture` arm and absent in the `none` arm and absent on a control category
 * within the SAME `fixture` run.
 */

import { describe, expect, it } from 'vitest';

import { FENCE_OPEN } from '../../../lib/grounding/fence';
import { runEval } from '../harness';
import type { EvalGenerationFn, EvalRunnerDeps } from '../harness';
import { KNOWN_ANSWER_PROBES } from '../known-answer-probes';
import { REAL_TIME_PROBES } from '../real-time-probes';
import { buildWebSnippetNote, getFixtureEntry } from '../real-time-fixture';
import type { EvalPromptSpec } from '../types';
import type { ChatMessage, TokenEvent } from '../../runtime/types';

/** A real, shipping catalog id — the arm must survive real prompt composition. */
const REAL_MODEL_ID = 'candidate/qwen3.5-2b-onnx';

/** The one probe the checked-in fixture has a capture for. */
const GROUNDED_PROBE_ID = 'rt-live-1';

/** A control probe from another category, run in the same pass. */
const CONTROL_PROBE = KNOWN_ANSWER_PROBES[0]!;

/**
 * A real-time spec whose id no capture pass will ever add — so the
 * missing-entry case stays testable after the fixture is filled in for all 24
 * shipping probes.
 */
const UNCAPTURED_PROBE: EvalPromptSpec = {
  ...REAL_TIME_PROBES.find((p) => p.id === GROUNDED_PROBE_ID)!,
  id: 'rt-uncaptured-test-only',
};

function recordingGenerate(seen: ChatMessage[][]): EvalGenerationFn {
  return (_model, messages) => {
    seen.push(messages);
    return (async function* () {
      yield { kind: 'token', text: 'ok' } satisfies TokenEvent;
      yield { kind: 'done', completionTokens: 1 } satisfies TokenEvent;
    })();
  };
}

/** Offline deps that leave `buildSystemPrompt` and `getModel` at production defaults. */
function armDeps(seen: ChatMessage[][]): EvalRunnerDeps {
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
    generateRunId: () => 'run-arm',
    now: () => 0,
  };
}

function systemOf(messages: ChatMessage[]): string {
  return messages.find((m) => m.role === 'system')?.content ?? '';
}

describe('★ harness grounding arm', () => {
  it('puts the fixture snippets in the system message of a real-time probe', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'arm-fixture',
        modelIds: [REAL_MODEL_ID],
        promptIds: [GROUNDED_PROBE_ID],
        extraPrompts: REAL_TIME_PROBES,
        groundingArm: 'fixture',
      },
      armDeps(seen),
    );

    expect(seen).toHaveLength(1);
    const system = systemOf(seen[0]!);
    expect(system).toContain(FENCE_OPEN);
    // Byte-identical to the note the fixture module builds — the prompt is not
    // a second, harness-local rendering of the same snippets.
    expect(system).toContain(buildWebSnippetNote(getFixtureEntry(GROUNDED_PROBE_ID)!));
    expect(system).toContain('Lincoln Tunnel');

    expect(run.results[0]!.groundingArm).toBe('fixture');
    expect(run.results[0]!.error).toBeNull();
    expect(run.config?.groundingArm).toBe('fixture');
  });

  it('leaves a control category un-grounded inside the SAME fixture run', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'arm-fixture-control',
        modelIds: [REAL_MODEL_ID],
        promptIds: [GROUNDED_PROBE_ID, CONTROL_PROBE.id],
        extraPrompts: [...REAL_TIME_PROBES, ...KNOWN_ANSWER_PROBES],
        groundingArm: 'fixture',
      },
      armDeps(seen),
    );

    expect(seen).toHaveLength(2);
    const byPromptId = new Map(
      run.results.map((r, i) => [r.promptId, systemOf(seen[i]!)] as const),
    );
    expect(byPromptId.get(GROUNDED_PROBE_ID)).toContain(FENCE_OPEN);
    expect(byPromptId.get(CONTROL_PROBE.id)).not.toContain(FENCE_OPEN);
    // Both rows still record the arm — a control row says which run it came from.
    for (const result of run.results) expect(result.groundingArm).toBe('fixture');
  });

  it('sends NO fence at all in the default `none` arm', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'arm-none',
        modelIds: [REAL_MODEL_ID],
        promptIds: [GROUNDED_PROBE_ID],
        extraPrompts: REAL_TIME_PROBES,
      },
      armDeps(seen),
    );

    const messages = seen[0]!;
    for (const message of messages) expect(message.content).not.toContain(FENCE_OPEN);
    expect(messages.some((m) => m.content.includes('Lincoln Tunnel'))).toBe(false);
    expect(run.results[0]!.groundingArm).toBe('none');
    expect(run.config?.groundingArm).toBe('none');
  });

  it('errors the row when a real-time probe has no fixture entry', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'arm-missing',
        modelIds: [REAL_MODEL_ID],
        promptIds: [UNCAPTURED_PROBE.id],
        extraPrompts: [UNCAPTURED_PROBE],
        groundingArm: 'fixture',
      },
      armDeps(seen),
    );

    // No generation happened: a silent un-grounded run is exactly what the
    // error exists to prevent.
    expect(seen).toHaveLength(0);
    expect(run.results).toHaveLength(1);
    const result = run.results[0]!;
    expect(result.error).toContain('fixture missing');
    expect(result.error).toContain(UNCAPTURED_PROBE.id);
    expect(result.groundingArm).toBe('fixture');
    expect(result.output).toBe('');
  });

  it('still runs that probe in the `none` arm', async () => {
    const seen: ChatMessage[][] = [];
    const run = await runEval(
      {
        label: 'arm-missing-none',
        modelIds: [REAL_MODEL_ID],
        promptIds: [UNCAPTURED_PROBE.id],
        extraPrompts: [UNCAPTURED_PROBE],
      },
      armDeps(seen),
    );

    expect(seen).toHaveLength(1);
    expect(run.results[0]!.error).toBeNull();
  });
});
