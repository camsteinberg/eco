// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { analyzeRegisterShift, scorePreservesUserRegister } from "../register-shift";
import { EVERYDAY_USE_PROBES } from "../everyday-probes";
import { pastedBlockOf } from "../rubric";
import { CAPTURED_REGISTER_REPLIES } from "../../../__tests__/fixtures/captured-register-replies";

/**
 * The paste is extracted here, the way `rubric.ts` does it at scoring time —
 * `register-shift.ts` is a leaf and takes the block already extracted, so the
 * production dep graph stays acyclic.
 */
function promptFor(itemId: string): string {
  const spec = EVERYDAY_USE_PROBES.find((p) => p.id === itemId);
  if (!spec) throw new Error(`no probe for ${itemId} — fixture and corpus disagree`);
  return pastedBlockOf(spec.prompt);
}

describe("register shift — calibration against frozen captures", () => {
  // The hand labels are law; the scorer conforms to them. A capture that stops
  // agreeing means the scorer was loosened, not that the label was wrong.
  for (const capture of CAPTURED_REGISTER_REPLIES) {
    it(`${capture.id} — ${capture.why}`, () => {
      const analysis = analyzeRegisterShift(promptFor(capture.itemId), capture.output);
      if (capture.handLabel === 1) {
        expect(
          analysis.shifted,
          `labelled clean but flagged; introduced: ${analysis.introduced.join(", ")}`,
        ).toBe(false);
        expect(analysis.score).toBe(1);
      } else {
        expect(
          analysis.shifted,
          `labelled re-voiced but not flagged; introduced: ${analysis.introduced.join(", ")}`,
        ).toBe(true);
        expect(analysis.score).toBeLessThan(1);
      }
    });
  }
});

describe("register shift — the differential contract", () => {
  it("does NOT count a marker the user's own text already had", () => {
    // The whole design rule: a person who signs off formally is not made
    // formal by the model echoing it. A bare word list fails this.
    const userInput = [
      "please fix the spelling in this:",
      "",
      "Dear Hiring Manager,",
      "I am writing to apply for the role.",
      "Sincerely,",
      "Sam",
    ].join("\n");
    const output = [
      "Dear Hiring Manager,",
      "I am writing to apply for the role.",
      "Sincerely,",
      "Sam",
    ].join("\n");

    const analysis = analyzeRegisterShift(pastedBlockOf(userInput), output);
    expect(analysis.introduced).toEqual([]);
    expect(analysis.sourced.length).toBeGreaterThan(0);
    expect(analysis.score).toBe(1);
  });

  it("counts the same markers when the model introduced them", () => {
    const userInput = [
      "fix the spelling in this:",
      "",
      "hey can i get more time on the poster thing, sorry",
    ].join("\n");
    const output = [
      "Dear Hiring Manager,",
      "I am writing to request an extension.",
      "Sincerely,",
      "Sam",
    ].join("\n");

    const analysis = analyzeRegisterShift(pastedBlockOf(userInput), output);
    expect(analysis.introduced.length).toBeGreaterThanOrEqual(2);
    expect(analysis.shifted).toBe(true);
    expect(analysis.score).toBeLessThan(1);
  });

  it("treats a single introduced marker as a tidy, not a re-voicing", () => {
    // Calibrated, not assumed: proofread-crew-email adds a Subject line and
    // nothing else across all three samples, and a reader calls that clean.
    const userInput = "fix the typos:\n\nlads the job starts at 7 not 8 tommorow";
    const output = "**Subject:** Start time\n\nLads, the job starts at 7 not 8 tomorrow";

    const analysis = analyzeRegisterShift(pastedBlockOf(userInput), output);
    expect(analysis.introduced).toHaveLength(1);
    expect(analysis.shifted).toBe(false);
    expect(analysis.score).toBe(1);
  });

  it("scores a wholly re-voiced reply at 0", () => {
    const userInput = "fix the typos:\n\ni want the job, i work hard";
    const output = [
      "**Subject:** Application",
      "Dear Hiring Team,",
      "I am writing to apply. I hope this message finds you well.",
      "During my tenure I honed my skills and proactively delivered.",
      "Sincerely,",
    ].join("\n");

    expect(analyzeRegisterShift(pastedBlockOf(userInput), output).score).toBe(0);
  });
});

describe("register shift — the dim's gate", () => {
  it("returns null when the caller has not gated the item in", () => {
    expect(scorePreservesUserRegister("fix this:\n\nhello", "Dear Sir,\nSincerely,", false)).toBeNull();
  });

  it("returns a score when gated in", () => {
    expect(
      scorePreservesUserRegister("fix this:\n\nhello", "Dear Sir,\nSincerely,", true),
    ).toBeLessThan(1);
  });
});
