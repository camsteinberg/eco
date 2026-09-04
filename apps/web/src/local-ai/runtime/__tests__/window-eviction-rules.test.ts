// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The two eviction rules, replayed side by side on realistic sizes.
 *
 * This is the rule-29 replay for PR #348's quantum: a ten-turn conversation
 * with the shapes the production measurement actually saw (a ~140-token system
 * prompt, 15-25-token user turns, 400-800-token replies, a 4,096 window with a
 * 1,536-token reply reserve — a 2,420-token history budget), fed through
 * `selectWindow` under BOTH rules, asserting the window start index turn by
 * turn. The two sequences are the readable artifact: the minimal rule advances
 * the start on essentially every turn past the wall (each advance is a full
 * re-prefill), the quantized rule jumps and then HOLDS STILL.
 */

import { describe, expect, it } from 'vitest';
import { selectWindow } from '../window';
import type { ChatMessage } from '../types';

const CONTEXT_TOKENS = 4096;
const MAX_NEW_TOKENS = 1536;
const SYSTEM_TOKENS = 140;

/** Per-turn token counts: user turns are short, replies are long. */
const USER_TOKENS = [15, 17, 19, 21, 23, 25, 15, 17, 19, 21] as const;
const ASSISTANT_TOKENS = [420, 530, 640, 750, 480, 590, 700, 410, 520, 630] as const;

/**
 * The two sequences, indices into [system, u1, a1, …] so 1 means "evicted
 * nothing". Turn:      1  2  3  4  5  6  7  8  9 10
 *
 *   quantized          1  1  1  1  7  7  7 11 11 15   → 3 moves (turns 5, 8, 10)
 *   minimal            1  1  1  1  3  5  7  9  9 11   → 5 moves (turns 5, 6, 7, 8, 10)
 *
 * Every move is a full re-prefill of the new window, so the move COUNT is the
 * latency story and the gap between the two starts on a held turn (e.g. turn 7:
 * 7 vs 7, turn 9: 11 vs 9) is the history the quantum gives up.
 */
const QUANTIZED_STARTS = [1, 1, 1, 1, 7, 7, 7, 11, 11, 15];
const MINIMAL_STARTS = [1, 1, 1, 1, 3, 5, 7, 9, 9, 11];

/**
 * Build the full ten-turn conversation as [system, u1, a1, … u10, a10], with
 * each message's content a unique marker the counter looks up. Content length
 * is deliberately NOT the token count — the counter is the source of truth,
 * exactly as the real tokenizer is on the chat path.
 */
function buildConversation(): { messages: ChatMessage[]; counts: Map<string, number> } {
  const messages: ChatMessage[] = [{ role: 'system', content: 'system' }];
  const counts = new Map<string, number>([['system', SYSTEM_TOKENS]]);
  for (let turn = 0; turn < USER_TOKENS.length; turn++) {
    const user = `u${turn + 1}`;
    const assistant = `a${turn + 1}`;
    messages.push({ role: 'user', content: user });
    messages.push({ role: 'assistant', content: assistant });
    counts.set(user, USER_TOKENS[turn]!);
    counts.set(assistant, ASSISTANT_TOKENS[turn]!);
  }
  return { messages, counts };
}

/**
 * `windowStartIndex` for each of the ten turns, where turn k is generated from
 * [system, u1, a1, … u(k-1), a(k-1), uk] — the prefix production actually holds
 * when the user sends turn k.
 */
async function replay(evictionQuantumFraction: number | undefined): Promise<number[]> {
  const { messages, counts } = buildConversation();
  const countTokens = async (text: string): Promise<number> => counts.get(text) ?? 0;

  const starts: number[] = [];
  for (let turn = 1; turn <= USER_TOKENS.length; turn++) {
    const prefix = messages.slice(0, 1 + (turn - 1) * 2 + 1);
    const selection = await selectWindow(prefix, {
      contextTokens: CONTEXT_TOKENS,
      maxNewTokens: MAX_NEW_TOKENS,
      countTokens,
      ...(evictionQuantumFraction !== undefined ? { evictionQuantumFraction } : {}),
    });
    starts.push(selection.windowStartIndex);
  }
  return starts;
}

describe('selectWindow — eviction rules replayed on realistic sizes', () => {
  it('holds the window start still between moves under the quantized rule', async () => {
    const quantized = await replay(undefined);
    const minimal = await replay(0);

    // Both sequences ride the assertion message so a failure prints the pair.
    const seen = `quantized=[${quantized.join(',')}] minimal=[${minimal.join(',')}]`;
    expect(quantized, seen).toEqual(QUANTIZED_STARTS);
    expect(minimal, seen).toEqual(MINIMAL_STARTS);

    // The claim under test, stated independently of the pinned numbers.
    const moves = (starts: number[]): number =>
      starts.filter((v, i) => i > 0 && v !== starts[i - 1]).length;
    expect(moves(quantized)).toBeLessThan(moves(minimal));
  });

  it('treats an explicit 0.5 as the shipping default', async () => {
    expect(await replay(0.5)).toEqual(await replay(undefined));
  });

  it('rejects a fraction outside [0, 1] rather than falling back', async () => {
    const { messages, counts } = buildConversation();
    const countTokens = async (text: string): Promise<number> => counts.get(text) ?? 0;
    for (const bad of [-0.1, 1.5, Number.NaN]) {
      await expect(
        selectWindow(messages, {
          contextTokens: CONTEXT_TOKENS,
          maxNewTokens: MAX_NEW_TOKENS,
          countTokens,
          evictionQuantumFraction: bad,
        }),
      ).rejects.toThrow(/evictionQuantumFraction/);
    }
  });
});
