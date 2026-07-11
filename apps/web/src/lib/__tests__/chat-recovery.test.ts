// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { markRestoredInterruptions } from "../chat-recovery";
import type { ChatMessage } from "../../stores/chatStore";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m",
    role: "assistant",
    content: "",
    createdAt: 0,
    ...overrides,
  };
}

describe("markRestoredInterruptions", () => {
  it("marks an assistant reply left mid-stream (empty) as interrupted", () => {
    const swept = markRestoredInterruptions([
      message({ id: "a", role: "assistant", content: "", status: "streaming" }),
    ])[0]!;

    expect(swept).toMatchObject({
      status: "complete",
      streamInterrupted: true,
      interruptedReason: "restore-detected",
    });
  });

  it("marks a partial (non-empty) streaming reply as interrupted, keeping its content", () => {
    const swept = markRestoredInterruptions([
      message({ id: "a", content: "half a thought", status: "streaming" }),
    ])[0]!;

    expect(swept.content).toBe("half a thought");
    expect(swept.streamInterrupted).toBe(true);
    expect(swept.interruptedReason).toBe("restore-detected");
  });

  it("marks a reply still stuck at 'sending' as interrupted too", () => {
    const swept = markRestoredInterruptions([
      message({ id: "a", status: "sending" }),
    ])[0]!;

    expect(swept.status).toBe("complete");
    expect(swept.interruptedReason).toBe("restore-detected");
  });

  it("leaves finished, errored, statusless, and user messages untouched (by reference)", () => {
    const complete = message({ id: "c", content: "done", status: "complete" });
    const errored = message({ id: "e", content: "", status: "error" });
    const legacy = message({ id: "l", content: "old reply" }); // no status field
    const user = message({ id: "u", role: "user", content: "hi", status: "streaming" });

    const swept = markRestoredInterruptions([complete, errored, legacy, user]);

    // Untouched entries are passed through by reference (no needless churn).
    expect(swept[0]).toBe(complete);
    expect(swept[1]).toBe(errored);
    expect(swept[2]).toBe(legacy);
    // A user message never gets an assistant-only interruption marker, even if
    // its status is somehow non-terminal.
    expect(swept[3]).toBe(user);
    expect(swept[3]!.streamInterrupted).toBeUndefined();
  });

  it("does not mutate the input array or its messages", () => {
    const original = message({ id: "a", status: "streaming" });
    const input = [original];
    markRestoredInterruptions(input);

    expect(original.status).toBe("streaming");
    expect(original.streamInterrupted).toBeUndefined();
  });
});
