// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Static answer-shape routing audit — Stage-1 routing, pinned.
 *
 * These assertions document how the live router serves shape-labeled asks.
 * Stage 0 pinned the OLD cascade at 13/19 misroutes (68%, teaching never
 * reaching deep — see git history of this file + the findings doc); Stage 1's
 * shape classifier brings it to 2/19 (both deliberate softs from the
 * asymmetric-cost follow-up policy). A future routing change is EXPECTED to
 * re-derive these pins — that is the test doing its job, not a regression.
 */

import { describe, expect, it } from 'vitest';
import { auditShapeRouting, gradeShapeRoute } from '../shape-audit';
import { SHAPE_PROBES, SHAPE_RESEARCH_ARMS } from '../shape-probes';

describe('gradeShapeRoute', () => {
  it('grades teaching: deep=hit, explain=soft, quick=miss', () => {
    expect(gradeShapeRoute('teaching', 'deep')).toBe('hit');
    expect(gradeShapeRoute('teaching', 'explain')).toBe('soft');
    expect(gradeShapeRoute('teaching', 'quick')).toBe('miss');
  });

  it('grades brief: quick=hit, explain=soft (polite padding), deep=miss (lecture)', () => {
    expect(gradeShapeRoute('brief', 'quick')).toBe('hit');
    expect(gradeShapeRoute('brief', 'explain')).toBe('soft');
    expect(gradeShapeRoute('brief', 'deep')).toBe('miss');
  });

  it('grades focused: explain=hit, quick/deep=soft', () => {
    expect(gradeShapeRoute('focused', 'explain')).toBe('hit');
    expect(gradeShapeRoute('focused', 'quick')).toBe('soft');
    expect(gradeShapeRoute('focused', 'deep')).toBe('soft');
  });
});

describe('auditShapeRouting — Stage-1 routing pins', () => {
  const audit = auditShapeRouting(SHAPE_PROBES);

  /** Row lookup that fails loudly if a probe id vanishes from the audit. */
  function row(promptId: string): { routedIntent: string; grade: string } {
    const found = audit.rows.find((r) => r.promptId === promptId);
    if (!found) throw new Error(`audit has no row for ${promptId}`);
    return found;
  }

  it('excludes research-arm compositions (forced intents / system placement)', () => {
    const armAudit = auditShapeRouting([...SHAPE_PROBES, ...SHAPE_RESEARCH_ARMS]);
    // syshint counterfactuals measure composition, not routing — excluded.
    expect(armAudit.rows.some((r) => r.promptId.endsWith('-syshint'))).toBe(false);
    // Explicit-phrasing arms are real asks that route naturally — the caller
    // decides whether to pass them; the canonical baseline audits SHAPE_PROBES.
    expect(armAudit.rows.some((r) => r.promptId.endsWith('-explicit'))).toBe(true);
  });

  it('pins teaching probes: ALL reach the deep treatment now (was 0/8 at Stage 0)', () => {
    for (const id of ['as1', 'as2', 'as3', 'as4', 'as5', 'as6', 'as7', 'as8']) {
      expect(row(id), id).toMatchObject({ routedIntent: 'deep', grade: 'hit' });
    }
  });

  it('pins brief controls: single facts and explicit instructions stay quick', () => {
    for (const id of ['as12', 'as13', 'as14', 'as15', 'as16']) {
      expect(row(id), id).toMatchObject({ routedIntent: 'quick', grade: 'hit' });
    }
  });

  it('pins the focused middle and the follow-up policy', () => {
    for (const id of ['as9', 'as10', 'as11']) {
      expect(row(id), id).toMatchObject({ routedIntent: 'explain', grade: 'hit' });
    }
    // Register-matched follow-up: brief expected, brief routed.
    expect(row('as17')).toMatchObject({ routedIntent: 'quick', grade: 'hit' });
    // The asymmetric-cost policy working as designed: these two deserve the
    // focused middle but the safe follow-up guard keeps them brief — soft by
    // choice, never a lecture on a guess. Revisit with Stage-2 expansion chips.
    expect(row('as18')).toMatchObject({ routedIntent: 'quick', grade: 'soft' });
    expect(row('as19')).toMatchObject({ routedIntent: 'quick', grade: 'soft' });
  });

  it('pins the Stage-1 misroute numbers (down from 13/19 = 68% at Stage 0)', () => {
    expect(audit.total).toBe(19);
    expect(audit.hits).toBe(17);
    expect(audit.softs).toBe(2);
    expect(audit.misses).toBe(0);
    expect(audit.misrouteRate).toBeCloseTo(2 / 19);
    expect(audit.hardMissRate).toBe(0);
  });
});
