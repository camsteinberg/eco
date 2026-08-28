// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for {@link deriveMoneyMatchContext} (s20).
 *
 * Pure scan over a chat message list — no store, no mocks. The load-bearing rules
 * are: USER turns only (an assistant-stated APR may be fabricated), most-recent
 * wins, and a bounded lookback.
 */

import { describe, it, expect } from "vitest";
import { deriveMoneyMatchContext, RECENT_APR_LOOKBACK } from "../money-context";
import type { ChatMessage } from "../../../stores/chatStore";

let seq = 0;

/** Minimal ChatMessage factory — only the fields the scan reads matter. */
function msg(role: ChatMessage["role"], content: string, id?: string): ChatMessage {
  seq += 1;
  return { id: id ?? `m${seq}`, role, content, createdAt: seq };
}

describe("deriveMoneyMatchContext", () => {
  it("finds an APR the user stated two messages back", () => {
    const messages = [
      msg("user", "My credit card says 24% APR. What does that actually mean for me?"),
      msg("assistant", "It is a yearly rate."),
      msg("user", "If I owe $600 on it and pay $100 a month, how long until it's paid off?"),
    ];
    expect(deriveMoneyMatchContext(messages)).toEqual({ recentAprPercent: 24 });
  });

  it("takes the most recent of two user APR mentions", () => {
    const messages = [
      msg("user", "my old card was 29.99% APR"),
      msg("assistant", "Noted."),
      msg("user", "the new one is 12% APR"),
      msg("assistant", "Noted."),
      msg("user", "how long until it's paid off?"),
    ];
    expect(deriveMoneyMatchContext(messages)).toEqual({ recentAprPercent: 12 });
  });

  it("ignores an APR that only ever appeared in an ASSISTANT turn", () => {
    const messages = [
      msg("user", "what do you think my rate is?"),
      msg("assistant", "Cards like that are usually around 24% APR."),
      msg("user", "if I owe $600 on it and pay $100 a month, how long until it's paid off?"),
    ];
    expect(deriveMoneyMatchContext(messages)).toEqual({});
  });

  it("ignores an APR stated beyond the lookback window", () => {
    const messages: ChatMessage[] = [msg("user", "my card says 24% APR")];
    for (let i = 0; i < RECENT_APR_LOOKBACK; i++) {
      messages.push(msg(i % 2 === 0 ? "assistant" : "user", `filler ${String(i)}`));
    }
    expect(messages).toHaveLength(RECENT_APR_LOOKBACK + 1);
    expect(deriveMoneyMatchContext(messages)).toEqual({});
  });

  it("returns {} for an empty conversation", () => {
    expect(deriveMoneyMatchContext([])).toEqual({});
  });

  it("reads 'APR of N%' and 'APR is N%' phrasings", () => {
    expect(deriveMoneyMatchContext([msg("user", "the APR of 18% is brutal")])).toEqual({
      recentAprPercent: 18,
    });
    expect(deriveMoneyMatchContext([msg("user", "the APR is 21.5%")])).toEqual({
      recentAprPercent: 21.5,
    });
  });

  it("rejects out-of-range rates", () => {
    expect(deriveMoneyMatchContext([msg("user", "my card says 0% APR")])).toEqual({});
    expect(deriveMoneyMatchContext([msg("user", "my card says 400% APR")])).toEqual({});
  });

  it("excludes a specified message id outright (the in-flight reply)", () => {
    const messages = [
      msg("user", "my card says 24% APR", "u1"),
      msg("assistant", "", "streaming"),
    ];
    expect(deriveMoneyMatchContext(messages, { excludeId: "u1" })).toEqual({});
  });
});
