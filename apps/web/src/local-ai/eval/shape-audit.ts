// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Static answer-shape routing audit (Wave 2.6 Stage 0).
 *
 * Pure: runs the LIVE router (`inferChatIntent`) over every shape-labeled,
 * production-faithful probe and grades how today's routing serves the shape
 * the ask deserves. No model, no browser — this is the misroute number that
 * turns "magic words get better answers" (Cam's felt finding) into a measured
 * baseline the Stage-1 classifier must move.
 *
 * Grading semantics (today's treatment map — chat-intent.ts):
 *   teaching → deep is the premium treatment (2048 + sections/tradeoffs hint):
 *     deep = hit · explain = soft (1536 + softer hint — serviceable, not the
 *     premium delta) · anything else = miss (quick = empty hint + 1024).
 *   focused → explain = hit · quick/deep = soft (under-/over-treatment, both
 *     survivable) · others = miss.
 *   brief → quick = hit · explain = soft (the "polite padding on single-fact
 *     asks" class) · anything else = miss (deep on a single fact = lecture).
 *
 * Probes with `forcedIntent` are research arms, not routing claims — excluded.
 */

import { inferChatIntent, type ChatIntent } from '../../lib/chat-intent';
import type { AnswerShape, EvalPromptSpec } from './types';

export type ShapeRouteGrade = 'hit' | 'soft' | 'miss';

export type ShapeRouteRow = {
  promptId: string;
  prompt: string;
  expectedShape: AnswerShape;
  /** What the live router returns for this prompt today. */
  routedIntent: ChatIntent;
  grade: ShapeRouteGrade;
};

export type ShapeRouteAudit = {
  rows: ShapeRouteRow[];
  /** Probes graded (labeled, non-forced). */
  total: number;
  hits: number;
  softs: number;
  misses: number;
  /** Fraction of graded probes not fully served (soft + miss) / total. */
  misrouteRate: number;
  /** Fraction outright missed: miss / total. */
  hardMissRate: number;
};

const GRADE_BY_SHAPE: Record<AnswerShape, Partial<Record<ChatIntent, ShapeRouteGrade>>> = {
  teaching: { deep: 'hit', explain: 'soft' },
  focused: { explain: 'hit', quick: 'soft', deep: 'soft' },
  brief: { quick: 'hit', explain: 'soft' },
};

export function gradeShapeRoute(expected: AnswerShape, routed: ChatIntent): ShapeRouteGrade {
  return GRADE_BY_SHAPE[expected][routed] ?? 'miss';
}

/**
 * Audit shape routing over a probe set. Only probes that carry an
 * `expectedShape` AND are not `forcedIntent` research arms participate.
 */
export function auditShapeRouting(specs: readonly EvalPromptSpec[]): ShapeRouteAudit {
  const rows: ShapeRouteRow[] = [];
  for (const spec of specs) {
    // Research arms are routing-audit noise: forced intents and non-default
    // hint placements measure composition, not the router.
    if (!spec.expectedShape || spec.forcedIntent || spec.hintPlacement === 'system') continue;
    // Multi-turn probes route with the thread context production sees.
    const routedIntent = inferChatIntent(spec.prompt, {
      hasPriorTurns: (spec.history?.length ?? 0) > 0,
    });
    rows.push({
      promptId: spec.id,
      prompt: spec.prompt,
      expectedShape: spec.expectedShape,
      routedIntent,
      grade: gradeShapeRoute(spec.expectedShape, routedIntent),
    });
  }

  const total = rows.length;
  const hits = rows.filter((r) => r.grade === 'hit').length;
  const softs = rows.filter((r) => r.grade === 'soft').length;
  const misses = rows.filter((r) => r.grade === 'miss').length;

  return {
    rows,
    total,
    hits,
    softs,
    misses,
    misrouteRate: total === 0 ? 0 : (softs + misses) / total,
    hardMissRate: total === 0 ? 0 : misses / total,
  };
}
