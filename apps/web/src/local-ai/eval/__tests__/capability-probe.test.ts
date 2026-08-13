// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { inferChatIntent } from '../../../lib/chat-intent';
import { CAPABILITY_PROBE_PROBES } from '../capability-probe';

const VALID_INTENTS = new Set(['quick', 'explain', 'deep', 'code', 'writing', 'file', 'research']);

describe('capability probe set', () => {
  it('carries exactly the 28 tasks from the frozen spec', () => {
    expect(CAPABILITY_PROBE_PROBES).toHaveLength(28);
  });

  it('has unique, stably-prefixed ids grouped A/B/C/D/E', () => {
    const ids = CAPABILITY_PROBE_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^cap-[abcde]\d+$/);
    const count = (letter: string) => ids.filter((id) => id.startsWith(`cap-${letter}`)).length;
    expect(count('a')).toBe(9);
    expect(count('b')).toBe(5);
    expect(count('c')).toBe(5);
    expect(count('d')).toBe(4);
    expect(count('e')).toBe(5);
  });

  it('every task is the capability-probe category with a non-empty prompt', () => {
    for (const spec of CAPABILITY_PROBE_PROBES) {
      expect(spec.category).toBe('capability-probe');
      expect(spec.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('assigns each task the PRODUCTION intent classification of its prompt', () => {
    // Fidelity guard: the harness composes hints + generation profile off
    // spec.intent, so the probe must carry exactly what a live /chat turn would.
    for (const spec of CAPABILITY_PROBE_PROBES) {
      expect(VALID_INTENTS.has(spec.intent)).toBe(true);
      expect(spec.intent).toBe(inferChatIntent(spec.prompt));
    }
  });

  it('is BLIND: carries no automated answer-key fields (scored by hand vs the key)', () => {
    // The whole point of the probe is that answer quality is judged against the
    // vetted eco-notes key, never the self-blind auto-rubric. Baking expected/
    // forbidden answers here would re-open the self-graded trap.
    for (const spec of CAPABILITY_PROBE_PROBES) {
      expect(spec.expectedAnswers).toBeUndefined();
      expect(spec.forbiddenAnswers).toBeUndefined();
      expect(spec.exactReply).toBeUndefined();
      expect(spec.judge).toBeUndefined();
      expect(spec.history).toBeUndefined();
    }
  });

  it('carries the seed study-guide task verbatim (A1)', () => {
    const a1 = CAPABILITY_PROBE_PROBES.find((p) => p.id === 'cap-a1');
    expect(a1?.prompt).toBe(
      'please make a study guide for an upcoming final exam i have on calc 1',
    );
  });
});
