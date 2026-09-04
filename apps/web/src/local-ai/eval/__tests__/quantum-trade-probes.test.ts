// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The quantum-trade probe builder: one probe per user turn 5..10, each carrying
 * every turn before it as history — and NOTHING at all until the captured
 * transcript has real assistant replies.
 */

import { describe, expect, it } from 'vitest';
import {
  BUDGET_TRANSCRIPT,
  QUANTUM_TRADE_PROBES,
  buildQuantumTradeProbes,
} from '../quantum-trade-probes';
import type { QuantumTradeTurn } from '../quantum-trade-probes';

/** A ten-turn fixture with every reply filled in. */
const FIXTURE: QuantumTradeTurn[] = Array.from({ length: 20 }, (_, i) =>
  i % 2 === 0
    ? { role: 'user' as const, content: `user turn ${i / 2 + 1}` }
    : { role: 'assistant' as const, content: `assistant reply ${(i - 1) / 2 + 1}` },
);

describe('buildQuantumTradeProbes', () => {
  it('yields one probe per user turn 5..10', () => {
    const probes = buildQuantumTradeProbes(FIXTURE);
    expect(probes.map((p) => p.id)).toEqual(['qt-5', 'qt-6', 'qt-7', 'qt-8', 'qt-9', 'qt-10']);
  });

  it("uses the turn's own text as the prompt and everything before it as history", () => {
    const probes = buildQuantumTradeProbes(FIXTURE);

    const first = probes[0]!;
    expect(first.prompt).toBe('user turn 5');
    expect(first.history).toHaveLength(8);
    expect(first.history?.[0]).toEqual({ role: 'user', content: 'user turn 1' });
    expect(first.history?.at(-1)).toEqual({ role: 'assistant', content: 'assistant reply 4' });

    const last = probes.at(-1)!;
    expect(last.prompt).toBe('user turn 10');
    expect(last.history).toHaveLength(18);
    expect(last.history?.at(-1)).toEqual({ role: 'assistant', content: 'assistant reply 9' });
  });

  it('contributes zero probes while any assistant reply is empty', () => {
    const missing = FIXTURE.map((turn, i) =>
      i === 5 ? { ...turn, content: '' } : turn,
    );
    expect(buildQuantumTradeProbes(missing)).toEqual([]);
  });

  it('rejects a transcript that is not ten alternating pairs', () => {
    expect(buildQuantumTradeProbes(FIXTURE.slice(0, 18))).toEqual([]);
    const swapped = [...FIXTURE];
    swapped[0] = { role: 'assistant', content: 'wrong speaker' };
    expect(buildQuantumTradeProbes(swapped)).toEqual([]);
  });
});

describe('BUDGET_TRANSCRIPT', () => {
  it('carries the lane’s ten user turns with replies still to be captured', () => {
    expect(BUDGET_TRANSCRIPT).toHaveLength(20);
    expect(BUDGET_TRANSCRIPT[0]!.content).toBe('I want to get my monthly budget under control.');
    expect(BUDGET_TRANSCRIPT[18]!.content).toBe('What was my rent again?');
    expect(BUDGET_TRANSCRIPT.filter((t) => t.role === 'assistant').every((t) => t.content === ''))
      .toBe(true);
  });

  it('ships an empty pool until those replies land', () => {
    expect(QUANTUM_TRADE_PROBES).toEqual([]);
  });
});
