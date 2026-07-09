// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Answer-shape probe set — structural invariants.
 *
 * The load-bearing test here is the ANTI-DRIFT check: every production-faithful
 * probe's `intent` must be exactly what the LIVE router returns for its prompt.
 * If a routing regex changes (including Stage 1's classifier work), this test
 * fails and forces the probe labels — and the documented baseline — to be
 * re-derived rather than silently going stale.
 */

import { describe, expect, it } from 'vitest';
import { inferChatIntent } from '../../../lib/chat-intent';
import { EVAL_PROMPTS } from '../prompts';
import { SHAPE_PROBES, SHAPE_RESEARCH_ARMS } from '../shape-probes';

const ALL_SHAPE_SPECS = [...SHAPE_PROBES, ...SHAPE_RESEARCH_ARMS];

describe('SHAPE_PROBES (production-faithful core)', () => {
  it('every probe intent matches the live router exactly (anti-drift)', () => {
    for (const probe of SHAPE_PROBES) {
      expect(probe.forcedIntent, `${probe.id} must not force intent`).toBeUndefined();
      expect(
        // Multi-turn probes classify with the thread context production sees.
        inferChatIntent(probe.prompt, { hasPriorTurns: (probe.history?.length ?? 0) > 0 }),
        `${probe.id} ("${probe.prompt}") routes differently than its spec.intent — re-derive the label`,
      ).toBe(probe.intent);
    }
  });

  it('every probe is shape-labeled with a depth band and the answer-shape category', () => {
    for (const probe of SHAPE_PROBES) {
      expect(probe.expectedShape, probe.id).toBeDefined();
      expect(probe.depthBand, probe.id).toBeDefined();
      expect(probe.category, probe.id).toBe('answer-shape');
    }
  });

  it('covers all three shapes with controls (the set tests both failure directions)', () => {
    const byShape = (shape: string): number =>
      SHAPE_PROBES.filter((p) => p.expectedShape === shape).length;
    expect(byShape('teaching')).toBeGreaterThanOrEqual(6);
    expect(byShape('brief')).toBeGreaterThanOrEqual(4);
    expect(byShape('focused')).toBeGreaterThanOrEqual(3);
    // Multi-turn register controls exist.
    expect(SHAPE_PROBES.some((p) => p.history && p.history.length > 0)).toBe(true);
  });

  it('probes type like real users (lowercase) except where punctuation is the point', () => {
    for (const probe of SHAPE_PROBES) {
      expect(probe.prompt, probe.id).toBe(probe.prompt.toLowerCase());
    }
  });
});

describe('SHAPE_RESEARCH_ARMS (A/B arms)', () => {
  it('all current arms route naturally to their spec intent (none forced post-Stage-1)', () => {
    for (const arm of SHAPE_RESEARCH_ARMS) {
      expect(arm.forcedIntent, `${arm.id} should not need forcedIntent anymore`).toBeUndefined();
      expect(
        inferChatIntent(arm.prompt, { hasPriorTurns: (arm.history?.length ?? 0) > 0 }),
        `${arm.id} no longer routes to ${arm.intent} — re-derive`,
      ).toBe(arm.intent);
    }
  });

  it('syshint arms are the placement counterfactual: system placement on the deep treatment', () => {
    const syshintArms = SHAPE_RESEARCH_ARMS.filter((a) => a.hintPlacement === 'system');
    expect(syshintArms.length).toBeGreaterThanOrEqual(3);
    for (const arm of syshintArms) {
      expect(arm.intent, arm.id).toBe('deep');
      expect(arm.id, arm.id).toMatch(/-syshint$/);
    }
  });

  it('each base keeps an explicit-phrasing ceiling arm and a syshint counterfactual', () => {
    for (const base of ['as4', 'as2', 'as3']) {
      expect(SHAPE_PROBES.some((p) => p.id === base), `${base} core probe`).toBe(true);
      for (const suffix of ['explicit', 'syshint']) {
        expect(
          SHAPE_RESEARCH_ARMS.some((p) => p.id === `${base}-${suffix}`),
          `${base}-${suffix} arm`,
        ).toBe(true);
      }
    }
  });
});

describe('shape probe pool hygiene', () => {
  it('ids are unique across fixed + shape + arms', () => {
    const ids = [...EVAL_PROMPTS, ...ALL_SHAPE_SPECS].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('depth bands are internally consistent (min <= max when both set)', () => {
    for (const probe of ALL_SHAPE_SPECS) {
      const band = probe.depthBand;
      if (band !== undefined && band.minWords !== undefined && band.maxWords !== undefined) {
        expect(band.minWords, probe.id).toBeLessThanOrEqual(band.maxWords);
      }
    }
  });
});
