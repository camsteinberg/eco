// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Quantum-trade probes — the prompt set for judging what quantized eviction
 * costs in answer quality.
 *
 * PR #348 made history eviction quantized: once the chat outgrows the window,
 * the start jumps to the next half-budget boundary and then HOLDS STILL until
 * the chat has grown by another half budget. Measured on the production build
 * (2026-09-04, Apple Silicon, LFM2-2.6B, a ten-turn budgeting chat at a 4,096
 * window), that turned five window moves at 8.9-14.0 s to first token into
 * three at 4.5-8.7 s. The price is history: right after a move the model sees
 * between half and a full budget of it instead of a full one.
 *
 * Latency is measured; the quality half of that trade is not. These probes make
 * it measurable. Each one replays the same budgeting conversation up to a given
 * turn and asks that turn's question, so the SAME probe run under
 * `evictionRule: 'quantized'` and under `evictionRule: 'minimal'` produces the
 * two arms the blind pairwise scorer (`pairwise.ts`) compares. Turns 5..10 are
 * the ones worth judging: turn 5 needs a running total over four earlier turns
 * and turn 10 needs a recall from turn 2, so both sit downstream of anything
 * eviction can remove.
 *
 * The user turns are the acceptance lane's own `BUDGET_TURNS`
 * (`e2e-acceptance/acceptance.spec.ts`), deliberately: the chat whose stalls
 * were measured is the chat whose quality is judged.
 */

import { inferChatIntent } from '../../lib/chat-intent';
import type { EvalHistoryTurn, EvalPromptSpec } from './types';

/** One entry of a captured transcript: who spoke, and what they said. */
export type QuantumTradeTurn = { role: 'user' | 'assistant'; content: string };

/** First and last user turn (1-based) that gets a probe. */
const FIRST_PROBE_TURN = 5;
const LAST_PROBE_TURN = 10;

/** A ten-turn conversation is twenty alternating entries. */
const EXPECTED_TURNS = 10;
const EXPECTED_ENTRIES = EXPECTED_TURNS * 2;

/**
 * The ten-turn budgeting conversation, verbatim from the acceptance lane's
 * `BUDGET_TURNS`, with the assistant replies left EMPTY.
 *
 * The replies have to come from a real run of this conversation on the model
 * under test — invented replies would put words in the model's mouth and the
 * scorer would be judging our prose, not the eviction rule. Until they are
 * pasted in, `buildQuantumTradeProbes` contributes ZERO probes, so a run that
 * names this pool early fails loudly by measuring nothing rather than quietly
 * measuring a placeholder.
 */
export const BUDGET_TRANSCRIPT: readonly QuantumTradeTurn[] = [
  { role: 'user', content: 'I want to get my monthly budget under control.' },
  { role: 'assistant', content: '' },
  { role: 'user', content: 'My rent is $1,450 a month and I take home about $3,200.' },
  { role: 'assistant', content: '' },
  { role: 'user', content: 'Groceries run me around $400, and I spend $120 on transit.' },
  { role: 'assistant', content: '' },
  { role: 'user', content: 'My phone and internet come to $95 together.' },
  { role: 'assistant', content: '' },
  { role: 'user', content: 'Adding those up, what am I spending each month so far?' },
  { role: 'assistant', content: '' },
  { role: 'user', content: "I'd like to put $300 into savings every month." },
  { role: 'assistant', content: '' },
  { role: 'user', content: 'Does that still leave me anything?' },
  { role: 'assistant', content: '' },
  { role: 'user', content: 'What would you cut first?' },
  { role: 'assistant', content: '' },
  { role: 'user', content: 'Give me one habit that would help me stick to this.' },
  { role: 'assistant', content: '' },
  { role: 'user', content: 'What was my rent again?' },
  { role: 'assistant', content: '' },
];

/** True when `transcript` is ten user/assistant pairs with no empty reply. */
function isUsableTranscript(transcript: ReadonlyArray<QuantumTradeTurn>): boolean {
  if (transcript.length !== EXPECTED_ENTRIES) return false;
  return transcript.every((turn, i) => {
    const expectedRole = i % 2 === 0 ? 'user' : 'assistant';
    if (turn.role !== expectedRole) return false;
    // A user turn is checked-in text and always present; an assistant turn is
    // the part that has to be filled in from a real run.
    return turn.content.trim().length > 0;
  });
}

/**
 * Build one probe per user turn `FIRST_PROBE_TURN`..`LAST_PROBE_TURN`: its
 * `history` is every turn before it and its `prompt` is that user turn.
 *
 * Returns an EMPTY array for any transcript that is not ten alternating pairs
 * with every reply filled in — see `BUDGET_TRANSCRIPT`.
 */
export function buildQuantumTradeProbes(
  transcript: ReadonlyArray<QuantumTradeTurn>,
): EvalPromptSpec[] {
  if (!isUsableTranscript(transcript)) return [];

  const probes: EvalPromptSpec[] = [];
  for (let turn = FIRST_PROBE_TURN; turn <= LAST_PROBE_TURN; turn++) {
    const userIndex = (turn - 1) * 2;
    const prompt = transcript[userIndex]!.content;
    const history: EvalHistoryTurn[] = transcript
      .slice(0, userIndex)
      .map((t) => ({ role: t.role, content: t.content }));
    probes.push({
      id: `qt-${turn}`,
      // `conversation`, not `everyday-conversation`: that category is derived
      // from its own corpus and its composite must not absorb these.
      category: 'conversation',
      intent: inferChatIntent(prompt),
      prompt,
      history,
    });
  }
  return probes;
}

/**
 * The shipped pool. EMPTY until `BUDGET_TRANSCRIPT` carries real replies.
 */
export const QUANTUM_TRADE_PROBES: readonly EvalPromptSpec[] =
  buildQuantumTradeProbes(BUDGET_TRANSCRIPT);
