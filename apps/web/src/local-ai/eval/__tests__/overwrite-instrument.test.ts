// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The over-writing instrument (M2 mechanism 1) — INTENTIONALLY RED.
 *
 * The M2 baseline (two independent batches, 2026-08-06) measured the dominant
 * answer-layer failure as artifact asks answered as essays: 105/105 depth
 * failures over-shoot, placeholders ride along on 12–14 items, invented
 * time-words on 4–7. Three structural facts keep the rubric from seeing it:
 * depthMatch has no ceiling on 24 of 49 items (a deliberate refusal to invent
 * defaults — respected here), nothing anywhere penalizes a placeholder, and
 * no invented-time detector exists.
 *
 * This suite names the three dims the rubric does not yet compute and holds
 * them to hand labels on 35 frozen captures from the shipping model
 * (fixtures/captured-overwrite-replies.ts — labels assigned by a reader
 * before any scorer existed). It ships red per the findings-ship-as-failing-
 * tests rule; a dim goes green only by scoring the real captures the way the
 * reader did, never by loosening a label. Labels are statements about what a
 * person would accept and do not change because our code changed.
 *
 *   - noUnfilledSlots     — bracket-slots where the ask made one unnecessary
 *                           (fact was given / inserted into the user's own
 *                           text / template-many / invites authoring).
 *   - noInventedTime      — commits to a time or day the ask never gave. The
 *                           detector MUST be differential against the ask:
 *                           summarise-01's "tonight" is sourced and clean.
 *   - deliversUnburied    — the asked-for artifact/answer IS the reply. A
 *                           one-line preamble is clean; Option-multiplicity,
 *                           "Changes Made & Rationale"/"Trade-offs" apparatus,
 *                           bold-field outlines, or replacing the artifact
 *                           with analysis are the defect. Orthogonal to
 *                           fidelity (preservesUserText/preservesFacts) and
 *                           to correctness.
 */

import { describe, it, expect } from "vitest";

import { scoreResult } from "../rubric";
import { EVERYDAY_USE_PROBES, everydayProbeId } from "../everyday-probes";
import {
  CAPTURED_OVERWRITE_REPLIES,
  type CapturedOverwriteReply,
} from "../../../__tests__/fixtures/captured-overwrite-replies";

/** New-dim key → the fixture's hand-label key it must reproduce. */
const DIMS = {
  noUnfilledSlots: "unfilledSlots",
  noInventedTime: "inventedTime",
  deliversUnburied: "artifactBurial",
} as const;

/**
 * Agreement tolerance: the scorer may differ from the reader by at most 0.25
 * — enough to allow a partial (0.5) to land as 0.4 or 0.7, never enough to
 * call a defect (0) clean (1). A dim that is absent or null on these specs
 * counts as full disagreement: every capture here is an artifact-class ask
 * the instrument exists to cover.
 */
const TOLERANCE = 0.25;

function scoresFor(capture: CapturedOverwriteReply): Record<string, unknown> {
  const spec = EVERYDAY_USE_PROBES.find(
    (p) => p.id === everydayProbeId(capture.itemId),
  );
  if (!spec) throw new Error(`no probe for corpus item ${capture.itemId}`);
  // Cast: the dims under test are not on RubricScores yet — that absence is
  // the red this suite exists to hold open.
  return scoreResult(spec, {
    output: capture.output,
    endedCleanly: true,
    hitTokenCap: false,
  }) as unknown as Record<string, unknown>;
}

function disagreementsOn(dim: keyof typeof DIMS): string[] {
  const labelKey = DIMS[dim];
  const out: string[] = [];
  for (const capture of CAPTURED_OVERWRITE_REPLIES) {
    const scored = scoresFor(capture)[dim];
    const label = capture.handLabels[labelKey];
    if (typeof scored !== "number" || Math.abs(scored - label) > TOLERANCE) {
      out.push(
        `${capture.id}: hand=${label} scored=${String(scored)} — ${capture.why}`,
      );
    }
  }
  return out;
}

describe("over-writing instrument vs hand labels (35 frozen captures)", () => {
  // Pinned as LISTS, never counts — a count survives a scorer quietly
  // degenerating into something else; a list does not.
  for (const dim of Object.keys(DIMS) as (keyof typeof DIMS)[]) {
    it(`${dim} agrees with every hand label within ${TOLERANCE}`, () => {
      expect(disagreementsOn(dim)).toEqual([]);
    });
  }
});

describe("anchor cases the implementation must not trade away", () => {
  const byId = new Map(CAPTURED_OVERWRITE_REPLIES.map((c) => [c.id, c]));
  const anchor = (id: string): CapturedOverwriteReply => {
    const c = byId.get(id);
    if (!c) throw new Error(`anchor capture ${id} missing from fixture`);
    return c;
  };

  it("a slot inserted INTO the user's own corrected text is a hard defect", () => {
    // sw-15 b1/s1: literal "[answer]" appears mid-quote inside the text the
    // user asked to have proofread.
    const scored = scoresFor(anchor("b1/sw-15/s1")).noUnfilledSlots;
    expect(typeof scored).toBe("number");
    expect(scored as number).toBeLessThanOrEqual(0.25);
  });

  it("a time-word SOURCED from the ask is clean — the detector is differential, not a word list", () => {
    // summarise-01 b1/s3: "tonight" appears in the pasted thread ("will send
    // tonight"). A bare word list would false-positive here.
    const scored = scoresFor(anchor("b1/summarise-01/s3")).noInventedTime;
    expect(typeof scored).toBe("number");
    expect(scored as number).toBeGreaterThanOrEqual(0.75);
  });

  it("a one-line preamble before the whole artifact is NOT burial", () => {
    // proofread-marketplace-ad b1/s1: "Here's the cleaned-up version…" then
    // the complete ad. The dim measures burial, not fidelity.
    const scored = scoresFor(anchor("b1/proofread-marketplace-ad/s1")).deliversUnburied;
    expect(typeof scored).toBe("number");
    expect(scored as number).toBeGreaterThanOrEqual(0.75);
  });

  it("an artifact replaced by analysis of the artifact is a hard defect", () => {
    // school-essay-not-ai b1/s1: no rewritten essay at all — meta-analysis,
    // robotic-phrasing tips and a table.
    const scored = scoresFor(anchor("b1/school-essay-not-ai/s1")).deliversUnburied;
    expect(typeof scored).toBe("number");
    expect(scored as number).toBeLessThanOrEqual(0.25);
  });
});
