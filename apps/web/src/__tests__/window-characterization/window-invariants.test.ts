// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WINDOWING INVARIANTS across the shipping catalog (R5a).
 *
 * The 192-cell prompt-equivalence baseline records at `stream()`, and every
 * conversation fixture in it is one or two turns long — NOTHING in it triggers
 * eviction. It is a strong guard on prompt content and sampling, and a vacuous
 * guard on windowing. This file is the windowing guard: the same corpus the R5
 * characterization was recorded on, run against the real selector, asserting
 * the structural properties that must hold whatever the counter says.
 *
 * It is deliberately NOT an equality baseline on selected counts. R5a replaced
 * `chars/4` estimates with real tokenizer counts, so those numbers move, and a
 * later `contextTokens` change is meant to move them again. What may not move
 * is the structure: system pinned, whole turns only, window ends at the newest
 * turn, the final user turn always survives, and `windowStartIndex` indexes the
 * message that was actually sent.
 *
 * COUNTER: a real tokenizer is not reachable from a unit test (the weights live
 * in the worker), so the cells run with a deterministic word counter as a
 * stand-in and, separately, with NO counter at all — which exercises the
 * one-token-per-character bound the LiteRT lane really gets. Set
 * `WINDOW_CHARACTERIZATION_PRINT=1` to print the table.
 */

import { describe, it, expect } from 'vitest';
import { getCatalog } from '../../local-ai/catalog/catalog';
import { getOnDeviceSystemPrompt } from '../../lib/system-prompt';
import { selectWindow } from '../../local-ai/runtime/window';
import type { ChatMessage } from '../../local-ai/runtime/types';

/** A realistic long chat: alternating turns of ordinary prose length. */
function buildBranch(turns: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    const role = i % 2 === 0 ? ('user' as const) : ('assistant' as const);
    msgs.push({
      role,
      content:
        role === 'user'
          ? `Turn ${i}: I am trying to work out the monthly figures again, and this time the rent line came to ${300 + i * 7} pounds which does not match what I wrote down earlier in this conversation.`
          : `Turn ${i}: Based on what you have given me so far the total comes to ${1200 + i * 13} pounds a month, which leaves a little under ${200 + i * 3} for everything that is not fixed. ${'Here is some additional supporting detail that a real assistant reply would carry. '.repeat(4)}`,
    });
  }
  return msgs;
}

/** One token per whitespace-delimited word — see `runtime/__tests__/window.test.ts`. */
const wordCounter = async (text: string): Promise<number> =>
  text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;

const SYSTEM: ChatMessage = { role: 'system', content: getOnDeviceSystemPrompt() };

type Cell = {
  modelId: string;
  contextTokens: number;
  reserveName: string;
  reserve: number;
  turns: number;
  selected: number;
  evicted: number;
  windowStartIndex: number;
  firstRole: string;
  fits: boolean;
};

async function runCells(counter: typeof wordCounter | undefined): Promise<Cell[]> {
  const cells: Cell[] = [];
  for (const entry of getCatalog()) {
    const contextTokens = entry.capabilities.contextTokens;
    const budgets = entry.maxNewTokens as unknown as Record<string, number>;
    for (const reserveName of ['default', 'ceiling'] as const) {
      const reserve = budgets[reserveName];
      if (typeof reserve !== 'number') continue;
      for (const turns of [20, 60]) {
        const branch = buildBranch(turns);
        const messages = [SYSTEM, ...branch];
        const selection = await selectWindow(messages, {
          contextTokens,
          maxNewTokens: reserve,
          ...(counter ? { countTokens: counter } : {}),
        });
        const kept = selection.messages.slice(1);

        // ── The invariants ────────────────────────────────────────────────
        // The system turn is pinned, unchanged, and never evicted.
        expect(selection.messages[0]).toEqual(SYSTEM);
        // Only WHOLE turns were dropped, from the front: the retained
        // conversation is a verbatim suffix of the input.
        expect(branch.slice(branch.length - kept.length)).toEqual(kept);
        // The window ends at the newest turn.
        expect(kept[kept.length - 1]).toEqual(branch[branch.length - 1]);
        // The final user turn always survives.
        const lastUser = [...branch].reverse().find((m) => m.role === 'user')!;
        expect(kept).toContainEqual(lastUser);
        // The window opens on a user turn, never an orphaned assistant reply.
        expect(kept[0]!.role).toBe('user');
        // `windowStartIndex` indexes the message that was actually sent.
        expect(messages[selection.windowStartIndex]).toEqual(kept[0]);

        cells.push({
          modelId: entry.id,
          contextTokens,
          reserveName,
          reserve,
          turns,
          selected: kept.length,
          evicted: branch.length - kept.length,
          windowStartIndex: selection.windowStartIndex,
          firstRole: kept[0]!.role,
          fits: selection.fits,
        });
      }
    }
  }
  return cells;
}

function printTable(label: string, cells: Cell[]): void {
  if (process.env.WINDOW_CHARACTERIZATION_PRINT !== '1') return;
  const rows = [
    `### ${label}`,
    '| model | contextTokens | reserve | turns | selected | evicted | windowStartIndex | firstRole | fits |',
    '|---|---|---|---|---|---|---|---|---|',
    ...cells.map(
      (c) =>
        `| ${c.modelId} | ${c.contextTokens} | ${c.reserveName}=${c.reserve} | ${c.turns} | ${c.selected} | ${c.evicted} | ${c.windowStartIndex} | ${c.firstRole} | ${c.fits} |`,
    ),
  ];
  // eslint-disable-next-line no-console
  console.log(rows.join('\n'));
}

describe('window selection invariants across the shipping catalog', () => {
  it('holds them with a real (per-message, async) token counter', async () => {
    const cells = await runCells(wordCounter);
    printTable('counted (word stand-in for a real tokenizer)', cells);
    // Non-vacuity: the corpus must actually evict somewhere, or the invariants
    // above are being asserted about a no-op.
    expect(cells.some((c) => c.evicted > 0)).toBe(true);
    expect(cells.length).toBeGreaterThan(0);
  });

  it('holds them with no counter at all (the one-token-per-character bound)', async () => {
    const cells = await runCells(undefined);
    printTable('uncounted (sound upper bound — the LiteRT lane)', cells);
    // The bound is strictly more conservative than any real count, so every
    // cell that evicted under counting must still evict here. (Not every cell
    // evicts: an entry whose window is wide enough for the whole fixture even
    // in characters — Gemma 4 E2B at 32,768 since 2026-09-02 — legitimately
    // keeps everything under both.)
    const counted = await runCells(wordCounter);
    const key = (c: Cell): string => `${c.modelId}|${c.reserveName}|${c.turns}`;
    const evictedUnderCounting = new Set(counted.filter((c) => c.evicted > 0).map(key));
    expect(evictedUnderCounting.size).toBeGreaterThan(0);
    for (const c of cells) {
      if (evictedUnderCounting.has(key(c))) expect(c.evicted, key(c)).toBeGreaterThan(0);
    }
  });
});
