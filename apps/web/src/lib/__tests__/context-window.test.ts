// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../../stores/chatStore";
import {
  CONTEXT_WINDOW_REFUSAL_MESSAGE,
  MIN_LOCAL_NEW_TOKENS,
  assessLocalContextSafety,
  clampRequestedNewTokensForContext,
  estimateTokens,
  findContextDividerIndex,
  getContextSelectionDiagnostics,
  selectMessagesForContext,
} from "../context-window";

/** Helper to create a ChatMessage with minimal fields. */
function msg(
  role: "user" | "assistant" | "system",
  content: string,
  id?: string,
  parentId?: string | null
): ChatMessage {
  return {
    id: id ?? crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    parentId: parentId ?? null,
  };
}

describe("selectMessagesForContext", () => {
  it("exports the default chars/4 token estimator", () => {
    expect(estimateTokens("x".repeat(9))).toBe(3);
  });

  it("returns all messages when they fit within the 75% budget", () => {
    const messages: ChatMessage[] = [
      msg("user", "Hello"),
      msg("assistant", "Hi there"),
    ];
    // 100000 tokens budget = huge, all fit
    const result = selectMessagesForContext(messages, 100000);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
  });

  it("returns empty array for empty input", () => {
    const result = selectMessagesForContext([], 4096);
    expect(result).toHaveLength(0);
  });

  it("uses chars/4 heuristic for token estimation", () => {
    // 100 chars = 25 tokens. With context_length=40, budget = floor(40*0.75) = 30 tokens
    // One message of 100 chars = 25 tokens, fits within 30
    const messages: ChatMessage[] = [
      msg("user", "a".repeat(100)),
      msg("assistant", "b".repeat(100)),
    ];
    // context_length = 40 => budget = 30 tokens
    // user: 25 tokens, assistant: 25 tokens = 50 total > 30
    // Should only keep the last pair (user+assistant still = 50, but min 1 pair guaranteed)
    const result = selectMessagesForContext(messages, 40);
    // At minimum the last user+assistant pair is returned
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps complete user+assistant pairs only", () => {
    const messages: ChatMessage[] = [
      msg("user", "First question", "u1"),
      msg("assistant", "First answer", "a1"),
      msg("user", "Second question", "u2"),
      msg("assistant", "Second answer", "a2"),
      msg("user", "Third question", "u3"),
      msg("assistant", "Third answer", "a3"),
    ];
    // Set a budget that only fits 2 pairs
    // Each message content ~ 15 chars = ceil(15/4) = 4 tokens
    // 6 messages * 4 tokens = 24 total tokens needed
    // If budget is 20, should fit last 2.5 pairs -> keeps 2 complete pairs (last 4 messages)
    const result = selectMessagesForContext(messages, 28);
    // budget = floor(28 * 0.75) = 21 tokens
    // Walking back: a3(4) + u3(4) = 8, a2(4) + u2(4) = 16, a1(4) + u1(4) = 24 > 21
    // So keeps last 4 messages (2 pairs)
    expect(result).toHaveLength(4);
    expect(result[0]!.content).toBe("Second question");
    expect(result[1]!.content).toBe("Second answer");
    expect(result[2]!.content).toBe("Third question");
    expect(result[3]!.content).toBe("Third answer");
  });

  it("drops orphaned assistant at start of selection", () => {
    // If the backward walk ends mid-pair with an assistant first, drop it
    const messages: ChatMessage[] = [
      msg("user", "Q1", "u1"),
      msg("assistant", "A1 with a very long response ".repeat(10), "a1"),
      msg("user", "Q2", "u2"),
      msg("assistant", "A2", "a2"),
    ];
    // Budget should be tight enough that including A1 would exceed,
    // but the walk back hits A1 as orphaned assistant
    const result = selectMessagesForContext(messages, 40);
    // budget = floor(40*0.75) = 30
    // a2 = ceil(2/4) = 1, u2 = ceil(2/4) = 1, a1 = ceil(300/4) = 75 tokens > budget
    // So A1 alone exceeds remaining. Keep last pair only.
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
  });

  it("always returns at least the last user+assistant pair", () => {
    const messages: ChatMessage[] = [
      msg("user", "a".repeat(1000)),
      msg("assistant", "b".repeat(1000)),
    ];
    // Very small budget: floor(4 * 0.75) = 3 tokens, but messages are 250 tokens each
    const result = selectMessagesForContext(messages, 4);
    // Must return at least the last pair
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
  });

  it("deducts system prompt tokens from budget", () => {
    const messages: ChatMessage[] = [
      msg("user", "Q1", "u1"),
      msg("assistant", "A1", "a1"),
      msg("user", "Q2", "u2"),
      msg("assistant", "A2", "a2"),
    ];
    // Without system prompt: budget = floor(100 * 0.75) = 75 tokens, all fit (4 msgs * ~1 token)
    const withoutSystem = selectMessagesForContext(messages, 100);
    expect(withoutSystem).toHaveLength(4);

    // With large system prompt: budget = 75 - ceil(292/4) = 75 - 73 = 2 tokens
    // Only last pair fits (2 tokens = 2 messages of 1 token each)
    const withSystem = selectMessagesForContext(messages, 100, "x".repeat(292));
    expect(withSystem).toHaveLength(2);
    expect(withSystem[0]!.content).toBe("Q2");
    expect(withSystem[1]!.content).toBe("A2");
  });

  it("handles single user message (no pair)", () => {
    const messages: ChatMessage[] = [msg("user", "Hello")];
    const result = selectMessagesForContext(messages, 4096);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
  });

  it("handles a trailing user message after pairs", () => {
    const messages: ChatMessage[] = [
      msg("user", "Q1", "u1"),
      msg("assistant", "A1", "a1"),
      msg("user", "Q2 just typed", "u2"),
    ];
    const result = selectMessagesForContext(messages, 100000);
    expect(result).toHaveLength(3);
    // The trailing user message should always be included
    expect(result[2]!.content).toBe("Q2 just typed");
  });

  it("returns messages in original order (root-first)", () => {
    const messages: ChatMessage[] = [
      msg("user", "First"),
      msg("assistant", "First reply"),
      msg("user", "Second"),
      msg("assistant", "Second reply"),
    ];
    const result = selectMessagesForContext(messages, 100000);
    expect(result[0]!.content).toBe("First");
    expect(result[3]!.content).toBe("Second reply");
  });

  it("evicts past the minimal cut to the next quantum boundary", () => {
    // 12 messages of 5 tokens (20 chars) each; context 32 → budget 24, quantum
    // max(1, floor(24/8)) = 3. Minimal walk keeps the last 4 messages
    // (20 tokens; a 5th would exceed 24), so s_min = 8 with 40 evicted tokens.
    // 40 is not a multiple of 3 → target 42 → the cut advances one more
    // message (45 ≥ 42), the now-leading assistant is dropped as an orphan,
    // and the final pair remains.
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(msg("user", "u".repeat(20), `u${i}`));
      messages.push(msg("assistant", "a".repeat(20), `a${i}`));
    }
    const result = selectMessagesForContext(messages, 32);
    expect(result.map((m) => m.id)).toEqual(["u5", "a5"]);
  });

  it("keeps the window start stable across appended turns (KV prefix stability)", () => {
    // Turns of 100 tokens (user 100 chars = 25 tok, assistant 300 chars = 75
    // tok); context 4096 → budget 3072, quantum 384. The minimal walk moves
    // the start on nearly every turn once the budget saturates (~31 turns);
    // the quantized cut may only move once per ~384 tokens of growth.
    const conversation: ChatMessage[] = [];
    const starts: string[] = [];
    for (let i = 0; i < 60; i++) {
      conversation.push(msg("user", "u".repeat(100), `u${i}`));
      conversation.push(msg("assistant", "a".repeat(300), `a${i}`));
      const selected = selectMessagesForContext(conversation, 4096);
      expect(selected.length).toBeGreaterThan(0);
      starts.push(selected[0]!.id);
    }
    const changes = starts.filter((s, i) => i > 0 && s !== starts[i - 1]).length;
    // Post-saturation growth ≈ 29 turns × 100 tokens = 2900 tokens; at one
    // move per 384-token quantum that is ~8 changes. The minimal walk made
    // ~29. Allow slack, but require the amortization to be real.
    expect(changes).toBeLessThanOrEqual(10);
    // And the window itself always fits the budget.
    const finalTokens = selectMessagesForContext(conversation, 4096).reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );
    expect(finalTokens).toBeLessThanOrEqual(Math.floor(4096 * 0.75));
  });

  it("quantization never evicts the final user turn", () => {
    // A giant early message puts the next quantum boundary beyond the end of
    // the conversation; the cut must clamp at the last user message.
    const messages: ChatMessage[] = [
      msg("user", "x".repeat(4000), "u1"), // 1000 tokens
      msg("assistant", "y".repeat(4000), "a1"), // 1000 tokens
      msg("user", "short question", "u2"),
      msg("assistant", "short answer", "a2"),
    ];
    // context 128 → budget 96: only the last pair fits minimally.
    const result = selectMessagesForContext(messages, 128);
    expect(result.map((m) => m.id)).toEqual(["u2", "a2"]);
  });

  it("accepts a tokenizer-aware estimator when available", () => {
    const messages: ChatMessage[] = [
      msg("user", "one two three", "u1"),
      msg("assistant", "four five six", "a1"),
      msg("user", "seven eight", "u2"),
    ];
    const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

    const result = selectMessagesForContext(messages, 8, undefined, {
      estimateTokens: countWords,
    });

    expect(result.map((message) => message.id)).toEqual(["u2"]);
  });
});

describe("getContextSelectionDiagnostics", () => {
  it("reports truncation and token pressure", () => {
    const messages: ChatMessage[] = [
      msg("user", "Q1", "u1"),
      msg("assistant", "A1", "a1"),
      msg("user", "Q2", "u2"),
    ];
    const selected = messages.slice(2);
    const diagnostics = getContextSelectionDiagnostics(
      messages,
      selected,
      100,
      "system prompt",
    );

    expect(diagnostics).toMatchObject({
      selectedCount: 1,
      totalCount: 3,
      truncatedCount: 2,
      wasTruncated: true,
      modelContextLength: 100,
    });
    expect(diagnostics.systemPromptTokens).toBeGreaterThan(0);
    expect(diagnostics.selectedMessageTokens).toBeGreaterThan(0);
  });
});

describe("findContextDividerIndex", () => {
  it("returns -1 when all messages are in context", () => {
    const messages: ChatMessage[] = [
      msg("user", "Q1", "u1"),
      msg("assistant", "A1", "a1"),
    ];
    const selected = [...messages]; // all selected
    expect(findContextDividerIndex(messages, selected)).toBe(-1);
  });

  it("returns the index of the first selected message when some are excluded", () => {
    const m1 = msg("user", "Q1", "u1");
    const m2 = msg("assistant", "A1", "a1");
    const m3 = msg("user", "Q2", "u2");
    const m4 = msg("assistant", "A2", "a2");
    const all = [m1, m2, m3, m4];
    const selected = [m3, m4]; // first two excluded
    expect(findContextDividerIndex(all, selected)).toBe(2);
  });

  it("returns -1 for empty arrays", () => {
    expect(findContextDividerIndex([], [])).toBe(-1);
  });

  it("returns 0 when first message is selected but there are no earlier messages to exclude", () => {
    const m1 = msg("user", "Q1", "u1");
    const all = [m1];
    const selected = [m1];
    // All messages are selected, so -1
    expect(findContextDividerIndex(all, selected)).toBe(-1);
  });
});

// ─── clampRequestedNewTokensForContext (chat #7) ────────────────────────────
// Long conversations degrade to a shorter grant instead of tripping the
// context-safety refusal; the refusal remains the terminal guard when even
// the floored grant doesn't fit.

describe("clampRequestedNewTokensForContext", () => {
  // contextLength 4096 → safe budget = floor(4096 * 0.9) = 3686 tokens.

  it("passes the request through untouched when headroom is plentiful", () => {
    // prompt: 400-char system (100 tok) + 400-char message (100 tok) = 200 tok.
    const granted = clampRequestedNewTokensForContext(
      [{ content: "a".repeat(400) }],
      "s".repeat(400),
      4096,
      2048,
    );
    expect(granted).toBe(2048);
  });

  it("clamps the request to the remaining headroom on a long conversation", () => {
    // prompt: 100 tok system + 2000 tok message = 2100 tok → headroom 1586.
    const granted = clampRequestedNewTokensForContext(
      [{ content: "a".repeat(8000) }],
      "s".repeat(400),
      4096,
      2048,
    );
    expect(granted).toBe(3686 - 2100);
  });

  it("never grants below the floor (safety check then refuses, as before)", () => {
    // prompt: 100 tok system + 3500 tok message = 3600 tok → headroom 86 < floor.
    const messages = [{ content: "a".repeat(14000) }];
    const systemPrompt = "s".repeat(400);
    const granted = clampRequestedNewTokensForContext(messages, systemPrompt, 4096, 2048);
    expect(granted).toBe(MIN_LOCAL_NEW_TOKENS);

    const decision = assessLocalContextSafety(messages, systemPrompt, 4096, granted);
    expect(decision.ok).toBe(false);
    // The refusal uses the shared, matchable constant — and states the truth:
    // it does NOT claim to have "kept your draft" (the message posts into the
    // transcript; nothing is preserved in the composer).
    if (!decision.ok) {
      expect(decision.reason).toBe(CONTEXT_WINDOW_REFUSAL_MESSAGE);
      expect(decision.reason).not.toMatch(/kept your draft/i);
    }
  });

  it("never raises a request smaller than the floor", () => {
    const granted = clampRequestedNewTokensForContext(
      [{ content: "a".repeat(400) }],
      "",
      4096,
      128,
    );
    expect(granted).toBe(128);
  });

  it("a granted clamp passes the safety check (no refusal regression)", () => {
    // Same long-conversation case as above: granted budget must fit.
    const messages = [{ content: "a".repeat(8000) }];
    const systemPrompt = "s".repeat(400);
    const granted = clampRequestedNewTokensForContext(messages, systemPrompt, 4096, 2048);
    const decision = assessLocalContextSafety(messages, systemPrompt, 4096, granted);
    expect(decision.ok).toBe(true);
  });

  it("respects a custom token estimator", () => {
    const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;
    // 10-word message + 2-word system = 12 tok; context 100 → safe 90, headroom 78.
    const granted = clampRequestedNewTokensForContext(
      [{ content: "w ".repeat(10).trim() }],
      "system prompt",
      100,
      2048,
      { estimateTokens: countWords, floor: 16 },
    );
    expect(granted).toBe(78);
  });
});
