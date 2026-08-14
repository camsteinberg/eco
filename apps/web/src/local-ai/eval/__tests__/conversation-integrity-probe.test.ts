// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { inferChatIntent } from '../../../lib/chat-intent';
import { analyzeRuledOut } from '../rubric';
import {
  CONVERSATION_INTEGRITY_PROBES,
  CONVERSATION_INTEGRITY_PROBE_IDS,
} from '../conversation-integrity-probe';

const VALID_INTENTS = new Set(['quick', 'explain', 'deep', 'code', 'writing', 'file', 'research']);

/** The history of a probe, concatenated the way the leak scorer sees a reply. */
function historyText(probe: (typeof CONVERSATION_INTEGRITY_PROBES)[number]): string {
  return (probe.history ?? []).map((turn) => turn.content).join('\n');
}

describe('conversation-integrity probe set (#27 leak fixture)', () => {
  it('is non-empty and every entry is the conversation-integrity category', () => {
    expect(CONVERSATION_INTEGRITY_PROBES.length).toBeGreaterThan(0);
    for (const spec of CONVERSATION_INTEGRITY_PROBES) {
      expect(spec.category).toBe('conversation-integrity');
      expect(spec.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('has unique ci-prefixed ids that match the exported id set', () => {
    const ids = CONVERSATION_INTEGRITY_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^ci-[a-z0-9-]+$/);
    expect(CONVERSATION_INTEGRITY_PROBE_IDS).toEqual(new Set(ids));
  });

  it('is multi-turn: every probe replays a planted history before the probed turn', () => {
    for (const spec of CONVERSATION_INTEGRITY_PROBES) {
      expect(spec.history && spec.history.length).toBeGreaterThan(0);
    }
  });

  it('names at least one forbidden private span per probe', () => {
    for (const spec of CONVERSATION_INTEGRITY_PROBES) {
      expect(spec.historyRuledOut && spec.historyRuledOut.length).toBeGreaterThan(0);
    }
  });

  it('INVARIANT: every forbidden span is actually planted in the history, by the same matcher the leak metric uses', () => {
    // A private span can never be an author-invented ban with no basis in the
    // conversation. Asserting it via analyzeRuledOut — the exact scorer the
    // leak-rate reads — guarantees the planted secret is detectable in the form
    // a leak would reproduce, so the metric can never be grounded in nothing.
    for (const spec of CONVERSATION_INTEGRITY_PROBES) {
      const terms = spec.historyRuledOut ?? [];
      const analysis = analyzeRuledOut(terms, historyText(spec));
      expect(analysis.resurfaced).toEqual([...terms]);
    }
  });

  it("INVARIANT: the probed turn itself does NOT contain the forbidden span (a clean reply is possible)", () => {
    // If the final drafting turn restated the secret, the ask would be
    // self-defeating. The privacy signal lives only in the history.
    for (const spec of CONVERSATION_INTEGRITY_PROBES) {
      const terms = spec.historyRuledOut ?? [];
      const analysis = analyzeRuledOut(terms, spec.prompt);
      expect(analysis.resurfaced).toEqual([]);
    }
  });

  it('assigns each probe the PRODUCTION multi-turn intent of its probed turn', () => {
    // Fidelity guard: the harness composes hints + generation profile off
    // spec.intent, so a probe must carry exactly what a live /chat turn would,
    // and these are multi-turn (hasPriorTurns: true) by construction.
    for (const spec of CONVERSATION_INTEGRITY_PROBES) {
      expect(VALID_INTENTS.has(spec.intent)).toBe(true);
      expect(spec.intent).toBe(inferChatIntent(spec.prompt, { hasPriorTurns: true }));
    }
  });

  it('carries no self-graded answer-key fields — the leak metric is objective absence, not judged quality', () => {
    for (const spec of CONVERSATION_INTEGRITY_PROBES) {
      expect(spec.expectedAnswers).toBeUndefined();
      expect(spec.forbiddenAnswers).toBeUndefined();
      expect(spec.exactReply).toBeUndefined();
    }
  });
});
