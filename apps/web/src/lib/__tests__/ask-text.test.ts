// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import { PASTED_TURN_MIN_CHARS, askPrefix, isTextRepairAsk } from "../ask-text";

const PASTE = "x".repeat(PASTED_TURN_MIN_CHARS + 50);

describe("askPrefix — the instruction, not the pasted subject", () => {
  it("returns a short turn whole", () => {
    expect(askPrefix("fix my typos")).toBe("fix my typos");
  });

  it("returns the instruction paragraph when a paste follows", () => {
    expect(askPrefix(`can you fix my spelling in this\n\n${PASTE}`)).toBe(
      "can you fix my spelling in this",
    );
  });

  it("strips file blocks before measuring length", () => {
    expect(askPrefix(`summarise this <file name="a.txt">${PASTE}</file>`)).toBe(
      "summarise this",
    );
  });

  it("is silent when a long turn has no paragraph break — no ask to find", () => {
    expect(askPrefix(PASTE)).toBe("");
  });

  it("is silent when the 'instruction' is itself longer than a paste", () => {
    expect(askPrefix(`${PASTE}\n\nand another thing`)).toBe("");
  });

  it("is deterministic — the KV precondition", () => {
    const turn = `proofread this please\n\n${PASTE}`;
    expect(askPrefix(turn)).toBe(askPrefix(turn));
  });
});

describe("isTextRepairAsk — the user wants text back, not commentary", () => {
  it("fires on a correction verb with a text object", () => {
    expect(isTextRepairAsk("can you fix the typos")).toBe(true);
    expect(isTextRepairAsk("could you correct my spelling")).toBe(true);
  });

  it("fires on a self-qualifying verb with no object", () => {
    expect(isTextRepairAsk("can someone proofread this")).toBe(true);
    expect(isTextRepairAsk("rewrite this for me")).toBe(true);
  });

  it("fires on 'check this for mistakes'", () => {
    expect(isTextRepairAsk("hi can you check this for mistakes please")).toBe(true);
  });

  it("does NOT fire when the repair is not about text", () => {
    expect(isTextRepairAsk("can you fix my wifi")).toBe(false);
    expect(isTextRepairAsk("fix the spacing in the code")).toBe(false);
  });

  it("does NOT fire on a question about text that asks nothing to be repaired", () => {
    expect(isTextRepairAsk("what does this letter mean")).toBe(false);
    expect(isTextRepairAsk("is this rude")).toBe(false);
  });

  it("reads only the ask, never the pasted subject", () => {
    // The paste mentions typos; the instruction does not ask for a repair.
    expect(isTextRepairAsk(`what does this mean\n\nplease fix the typos ${PASTE}`)).toBe(
      false,
    );
  });
});
