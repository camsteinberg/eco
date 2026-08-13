// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { CONTEXT_STRESS_PROBES } from '../context-stress-probes';

/**
 * No-model characterization of the context-stress headroom probe. It guards the
 * property the probe exists to exercise — a genuinely ~8k-token input sequence
 * with a recoverable planted secret — so the scaffolding can't silently rot
 * into something too short to stress an 8192 window.
 */
describe('context-stress headroom probes', () => {
  const probe = CONTEXT_STRESS_PROBES.find((p) => p.id === 'ctx-stress-8k-recall');

  it('ships the 8k-recall probe', () => {
    expect(probe).toBeDefined();
    expect(probe!.category).toBe('factual-known');
  });

  it('is long enough to stress an 8192-token window', () => {
    // The harness composes [system, ...history, prompt]; the history + prompt
    // are what fill the KV cache. estimateTokens ≈ chars / 4 (context-window.ts).
    const historyChars = probe!.history!.reduce((sum, turn) => sum + turn.content.length, 0);
    const totalChars = historyChars + probe!.prompt.length;
    const estTokens = Math.ceil(totalChars / 4);
    // Target ~8k so a real run pushes past the old 4096 default with margin.
    expect(estTokens).toBeGreaterThan(7500);
  });

  it('plants both secrets in the first turn and asks for them back last', () => {
    const firstTurn = probe!.history![0]!;
    expect(firstTurn.role).toBe('user');
    expect(firstTurn.content).toContain('Brambleworth');
    expect(firstTurn.content).toContain('47-19-83');
    expect(probe!.prompt.toLowerCase()).toContain('read back');
    expect(probe!.expectedAnswers).toEqual(
      expect.arrayContaining(['Brambleworth', '47-19-83']),
    );
  });

  it('does not repeat a distractor turn verbatim (so the KV cache cannot short-circuit)', () => {
    // Skip the two scripted opening turns; the generated distractors start at 2.
    const distractors = probe!.history!.slice(2).map((t) => t.content);
    expect(new Set(distractors).size).toBe(distractors.length);
  });

  it('alternates roles across the replayed history', () => {
    const roles = probe!.history!.map((t) => t.role);
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i]).not.toBe(roles[i - 1]);
    }
  });
});
