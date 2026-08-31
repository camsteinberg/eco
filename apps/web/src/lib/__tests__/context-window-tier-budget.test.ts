// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Characterizing test for the deeper-tier context-budget regression.
 *
 * PR #148 made the first-run welcome card recommend the "Deeper" tier
 * (LFM2-2.6B) by default, and the capability probe (2026-08-13) validated it as
 * the best of the shipped models. But the 2.6B is pinned at contextTokens 4096
 * (catalog-data.json / catalog.test.ts "pins the measured per-model context
 * windows"), while the everyday fast tier (LFM2.5-1.2B) and Qwen3.5-2B are 8192.
 * `selectMessagesForContext` budgets history at (ctx - maxNewTokens), so the
 * recommended Deeper tier silently gets HALF the multi-turn history budget of
 * the tier it replaces.
 *
 * This test proves that regression as an OBJECTIVE property of the selection
 * function — no model, no browser — so the recall cost is concrete before any
 * catalog change, and so a later window bump (4096 -> 8192, once a real-WebGPU
 * memory-headroom run earns it) has a measurable target. It asserts the
 * *mechanism* (a 4096 window retains strictly less recent history than 8192 and
 * evicts an early stated fact the 8192 window keeps), which stays true
 * regardless of which model carries which window, so it survives the fix.
 */

import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../stores/chatStore';
import { getContextSelectionDiagnostics, selectMessagesForContext } from '../context-window';

// The shipped windows this regression is about (see catalog.test.ts). Local
// literals, not a catalog import: this file tests the SELECTION mechanism, and
// staying value-independent means the fix (bumping the 2.6B) doesn't break it.
const FAST_TIER_CTX = 8192; // LFM2.5-1.2B (everyday default) + Qwen3.5-2B
const DEEPER_TIER_CTX = 4096; // LFM2-2.6B "Deeper" — the recommended first-run pick

function msg(role: 'user' | 'assistant', content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: 0, parentId: null };
}

/**
 * A realistic running conversation long enough to saturate BOTH windows, so each
 * one keeps only a recent suffix. Every user turn carries a unique, verbatim fact
 * marker, so an evicted turn provably drops a stated fact. ~60 pairs at ~40 words
 * each comfortably exceeds even the 8192 history budget.
 */
function buildSaturatingConversation(pairs: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let n = 0; n < pairs; n++) {
    out.push(
      msg(
        'user',
        `Fact-${n}: my confirmation code for booking ${n} is ZX${n}Q. ` +
          'Here is some surrounding detail so the turn is a realistic length, ' +
          'the kind of thing a person actually types when they are working ' +
          'through a multi-step task over many turns of a single conversation.',
      ),
    );
    out.push(
      msg(
        'assistant',
        `Got it — noting booking ${n} and confirmation code ZX${n}Q. ` +
          'Here is a correspondingly realistic reply that restates the ask, ' +
          'adds a couple of practical sentences, and keeps the exchange ' +
          'plausible so the token accounting reflects a real conversation.',
      ),
    );
  }
  return out;
}

const earliestIndex = (branch: ChatMessage[], selected: ChatMessage[]): number => {
  const firstId = selected[0]?.id;
  return branch.findIndex((m) => m.id === firstId);
};

describe('deeper-tier context budget (4096) vs fast-tier (8192)', () => {
  const branch = buildSaturatingConversation(60);

  it('an 8192 window retains strictly more recent turns than 4096', () => {
    const fast = selectMessagesForContext(branch, FAST_TIER_CTX);
    const deeper = selectMessagesForContext(branch, DEEPER_TIER_CTX);
    // Both truncate a saturating branch; the 8192 window keeps a longer suffix.
    expect(fast.length).toBeGreaterThan(deeper.length);
    // Concretely ~2x the history budget -> materially more history, not a rounding
    // difference. (8192-2048=6144 vs 4096-2048=2048.)
    expect(fast.length).toBeGreaterThan(deeper.length * 1.5);
  });

  it('the 4096 window starts later — it evicts earlier turns the 8192 window keeps', () => {
    const fast = selectMessagesForContext(branch, FAST_TIER_CTX);
    const deeper = selectMessagesForContext(branch, DEEPER_TIER_CTX);
    expect(earliestIndex(branch, fast)).toBeLessThan(earliestIndex(branch, deeper));
  });

  it('a fact stated early survives at 8192 but is EVICTED at 4096 (the recall regression)', () => {
    const fast = selectMessagesForContext(branch, FAST_TIER_CTX);
    const deeper = selectMessagesForContext(branch, DEEPER_TIER_CTX);
    // A turn the 8192 window keeps at its start but the 4096 window has already
    // evicted: its verbatim fact marker is recallable at 8192, gone at 4096.
    const boundaryTurn = fast[0]!;
    const factMarker = boundaryTurn.content.match(/Fact-\d+: [^.]+\./)![0];
    const inWindow = (sel: ChatMessage[]): boolean => sel.some((m) => m.content.includes(factMarker));
    expect(inWindow(fast)).toBe(true);
    expect(inWindow(deeper)).toBe(false);
  });

  it('the deeper tier truncates more of the same conversation (diagnostics)', () => {
    const fast = selectMessagesForContext(branch, FAST_TIER_CTX);
    const deeper = selectMessagesForContext(branch, DEEPER_TIER_CTX);
    const fastDiag = getContextSelectionDiagnostics(branch, fast, FAST_TIER_CTX);
    const deeperDiag = getContextSelectionDiagnostics(branch, deeper, DEEPER_TIER_CTX);
    // History budget is roughly halved, so the deeper tier drops strictly more turns.
    // Budget = ctx - 2048 (default maxNewTokens). 8192-2048=6144, 4096-2048=2048.
    expect(deeperDiag.totalBudgetTokens).toBe(DEEPER_TIER_CTX - 2048);
    expect(deeperDiag.truncatedCount).toBeGreaterThan(fastDiag.truncatedCount);
  });
});
