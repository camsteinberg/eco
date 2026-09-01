// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * What the client still owns about the context window after R5a.
 *
 * Selection itself moved to `local-ai/runtime/window.ts` and is tested there,
 * with real token counts. What remains here is branch hygiene (which depends on
 * stored-message identity the runtime never sees) and the divider lookup.
 */

import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../../stores/chatStore";
import {
  CONTEXT_WINDOW_REFUSAL_MESSAGE,
  coalesceConsecutiveUsers,
  findContextDividerIndex,
  prepareBranchForPrompt,
} from "../context-window";

/** Helper to create a ChatMessage with minimal fields. */
function msg(
  role: "user" | "assistant" | "system",
  content: string,
  id?: string,
): ChatMessage {
  return {
    id: id ?? crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    parentId: null,
  } as ChatMessage;
}

describe("prepareBranchForPrompt", () => {
  it("passes a clean alternating branch straight through", () => {
    const branch = [
      msg("user", "Q1", "u1"),
      msg("assistant", "A1", "a1"),
      msg("user", "Q2", "u2"),
    ];
    const prepared = prepareBranchForPrompt(branch);
    expect(prepared.messages).toEqual(branch);
    expect(prepared.sourceIds).toEqual(["u1", "a1", "u2"]);
  });

  it("drops an assistant turn that produced no text (CS-3)", () => {
    const branch = [
      msg("user", "Q1", "u1"),
      msg("assistant", "", "a1"),
      msg("user", "Q2", "u2"),
      msg("assistant", "A2", "a2"),
    ];
    branch[1]!.status = "error";

    const prepared = prepareBranchForPrompt(branch);
    expect(prepared.messages.map((m) => m.content)).toEqual(["Q1\n\nQ2", "A2"]);
  });

  it("drops a whitespace-only assistant turn too", () => {
    const branch = [msg("user", "Q1", "u1"), msg("assistant", "   \n ", "a1")];
    expect(prepareBranchForPrompt(branch).messages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("coalesces the adjacent user turns that removal creates", () => {
    const branch = [
      msg("user", "First question", "u1"),
      msg("assistant", "", "a1"),
      msg("user", "Second question", "u2"),
      msg("assistant", "Real answer", "a2"),
    ];
    const prepared = prepareBranchForPrompt(branch);
    expect(prepared.messages).toHaveLength(2);
    expect(prepared.messages[0]!.content).toBe("First question\n\nSecond question");
    // The merged turn adopts the LATER id for branch navigation…
    expect(prepared.messages[0]!.id).toBe("u2");
    // …but the window start is the EARLIER one, which is what the divider needs.
    expect(prepared.sourceIds[0]).toBe("u1");
  });

  it("keeps sourceIds parallel to messages through several merges", () => {
    const branch = [
      msg("user", "A", "u1"),
      msg("assistant", "", "x1"),
      msg("user", "B", "u2"),
      msg("assistant", "reply", "a1"),
      msg("user", "C", "u3"),
      msg("assistant", "", "x2"),
      msg("user", "D", "u4"),
    ];
    const prepared = prepareBranchForPrompt(branch);
    expect(prepared.messages).toHaveLength(prepared.sourceIds.length);
    expect(prepared.sourceIds).toEqual(["u1", "a1", "u3"]);
  });

  it("returns an empty result for an empty branch", () => {
    expect(prepareBranchForPrompt([])).toEqual({ messages: [], sourceIds: [] });
  });
});

describe("findContextDividerIndex", () => {
  const branch = [
    msg("user", "Q1", "u1"),
    msg("assistant", "A1", "a1"),
    msg("user", "Q2", "u2"),
    msg("assistant", "A2", "a2"),
  ];

  it("returns -1 when nothing was evicted", () => {
    expect(findContextDividerIndex(branch, null)).toBe(-1);
  });

  it("returns the index of the first in-context message", () => {
    expect(findContextDividerIndex(branch, "u2")).toBe(2);
  });

  it("returns -1 when the window starts at the head of the branch", () => {
    expect(findContextDividerIndex(branch, "u1")).toBe(-1);
  });

  it("returns -1 for an empty branch", () => {
    expect(findContextDividerIndex([], "u1")).toBe(-1);
  });

  it("returns -1 when the reported start is no longer in the branch", () => {
    // The branch changed under a completed generation (a switch, an edit).
    // A stale id draws no divider rather than one in the wrong place.
    expect(findContextDividerIndex(branch, "gone")).toBe(-1);
  });
});

// ─── The divider must mean "history fell out of context", nothing else ───────
// Two hygiene transforms shrink the branch and rewrite its head identity WITHOUT
// anything having been evicted: the CS-3 empty-assistant filter, and coalescing
// (which keeps the LATER id). Neither an array-length comparison nor
// `prepared.messages[0].id` can tell those apart from real truncation, which is
// why the runtime reports an index and `sourceIds` resolves it.

describe("context divider: no phantom truncation", () => {
  it("an errored (empty) assistant turn alone does NOT show the divider", () => {
    const branch = [msg("user", "Q1", "u1"), msg("assistant", "", "a1")];
    branch[1]!.status = "error";

    const prepared = prepareBranchForPrompt(branch);
    // The empty turn is filtered out of the prompt — but nothing was evicted,
    // so the runtime reports a window starting at conversation index 0.
    expect(prepared.messages).toHaveLength(1);
    expect(prepared.messages.length).toBeLessThan(branch.length);
    expect(findContextDividerIndex(branch, null)).toBe(-1);
  });

  it("a coalesced head without eviction does NOT show the divider", () => {
    const branch = [
      msg("user", "First question", "u1"),
      msg("assistant", "", "a1"),
      msg("user", "Second question", "u2"),
      msg("assistant", "Real answer", "a2"),
    ];
    const prepared = prepareBranchForPrompt(branch);
    // The trap: the merged turn's own id is "u2", which sits at index 2 of the
    // branch and would draw a divider over history that is still in context.
    expect(prepared.messages[0]!.id).toBe("u2");
    // `sourceIds` says the window really starts at "u1" — index 0, no divider.
    expect(findContextDividerIndex(branch, prepared.sourceIds[0]!)).toBe(-1);
  });

  it("places the divider at the FIRST message of a coalesced pair at the window head", () => {
    const branch: ChatMessage[] = [];
    for (let k = 0; k < 6; k++) {
      branch.push(msg("user", `question ${k}a`, `u${k}a`));
      branch.push(msg("assistant", "", `x${k}`)); // errored -> filtered, merges the users
      branch.push(msg("user", `question ${k}b`, `u${k}b`));
      branch.push(msg("assistant", `answer ${k}`, `a${k}`));
    }
    for (const m of branch) {
      if (m.role === "assistant" && m.content === "") m.status = "error";
    }

    const prepared = prepareBranchForPrompt(branch);
    // The runtime evicted the first prepared pair; the window opens on the
    // merged user turn at prepared index 2.
    const dividerIndex = findContextDividerIndex(branch, prepared.sourceIds[2]!);
    // The divider lands on the FIRST user of the merged pair, not the second,
    // so no in-context turn is drawn as evicted.
    expect(branch[dividerIndex]!.id).toBe("u1a");
  });
});

describe("coalesceConsecutiveUsers", () => {
  it("is a no-op when no consecutive users exist", () => {
    const messages = [
      msg("user", "Q1", "u1"),
      msg("assistant", "A1", "a1"),
      msg("user", "Q2", "u2"),
    ];
    const result = coalesceConsecutiveUsers(messages);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("merges two consecutive user turns", () => {
    const messages = [
      msg("user", "First", "u1"),
      msg("user", "Second", "u2"),
      msg("assistant", "answer", "a1"),
    ];
    const result = coalesceConsecutiveUsers(messages);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[0]!.content).toBe("First\n\nSecond");
    // Keeps the later message's id
    expect(result[0]!.id).toBe("u2");
  });

  it("merges three consecutive user turns", () => {
    const messages = [
      msg("user", "A", "u1"),
      msg("user", "B", "u2"),
      msg("user", "C", "u3"),
      msg("assistant", "answer", "a1"),
    ];
    const result = coalesceConsecutiveUsers(messages);
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe("A\n\nB\n\nC");
  });

  it("returns empty/singleton arrays unchanged", () => {
    expect(coalesceConsecutiveUsers([])).toEqual([]);
    const single = [msg("user", "Q", "u1")];
    expect(coalesceConsecutiveUsers(single)).toHaveLength(1);
  });
});

describe("the refusal copy", () => {
  it("is actionable (suggests starting a new chat)", () => {
    expect(CONTEXT_WINDOW_REFUSAL_MESSAGE).toMatch(/start a new chat/i);
  });
});
