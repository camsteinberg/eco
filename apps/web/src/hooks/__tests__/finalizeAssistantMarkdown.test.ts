// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for `finalizeAssistantMarkdown` (chat #7 Wave 2.5).
 *
 * The finalize seam reconciles an assistant message's PERSISTED body with the
 * same deterministic markdown normalization the renderer applies live, so copy /
 * export / history match what was displayed. It must:
 *   - rewrite the stored content when normalization changes it,
 *   - skip the store write entirely when the content is already clean (no-op),
 *   - normalize as a COMPLETE message (whole-text pass, no partial-tail rule).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import { finalizeAssistantMarkdown } from "../useChat";

function seedAssistant(content: string): string {
  const id = useChatStore.getState().addMessage({ role: "assistant", content });
  return id;
}

function contentOf(id: string): string | undefined {
  return useChatStore.getState().messages.find((m) => m.id === id)?.content;
}

/** Write-through that forwards to the real store (braces keep the void return clean). */
function applyUpdate(id: string, updates: { content: string }): void {
  useChatStore.getState().updateMessage(id, updates);
}

describe("finalizeAssistantMarkdown", () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
  });

  it("normalizes glued heading hashes in the persisted body", () => {
    const id = seedAssistant("##Summary\n\nbody");
    finalizeAssistantMarkdown(id, applyUpdate);
    expect(contentOf(id)).toBe("## Summary\n\nbody");
  });

  it("normalizes glued list markers and inserts a missing table separator", () => {
    const id = seedAssistant("-one\n-two\n\n| A | B |\n| 1 | 2 |");
    finalizeAssistantMarkdown(id, applyUpdate);
    expect(contentOf(id)).toBe(
      "- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  it("does not write the store when content is already clean", () => {
    const id = seedAssistant("Already clean prose.");
    let writes = 0;
    finalizeAssistantMarkdown(id, (mid, updates) => {
      writes++;
      applyUpdate(mid, updates);
    });
    expect(writes).toBe(0);
    expect(contentOf(id)).toBe("Already clean prose.");
  });

  it("treats the final line as complete (no partial-tail preservation)", () => {
    // The last line IS normalized at finalize time, unlike the streaming path.
    const id = seedAssistant("# Title\n\n#Final");
    finalizeAssistantMarkdown(id, applyUpdate);
    expect(contentOf(id)).toBe("# Title\n\n# Final");
  });

  it("never touches fenced code content", () => {
    const raw = "```\n#NotAHeading\n-notalist\n```";
    const id = seedAssistant(raw);
    finalizeAssistantMarkdown(id, applyUpdate);
    expect(contentOf(id)).toBe(raw);
  });

  it("is a no-op for an unknown message id", () => {
    expect(() => {
      finalizeAssistantMarkdown("does-not-exist", () => {
        throw new Error("should not be called");
      });
    }).not.toThrow();
  });
});
