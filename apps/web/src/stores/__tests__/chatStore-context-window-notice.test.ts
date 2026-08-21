// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The shrunk-context note is one shot PER CONVERSATION: raised once, closable
 * once, and reset wherever the conversation itself changes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../chatStore";

beforeEach(() => {
  useChatStore.setState({ contextWindowNotice: "none", messages: [] });
});

describe("chatStore — contextWindowNotice", () => {
  it("starts silent", () => {
    expect(useChatStore.getState().contextWindowNotice).toBe("none");
  });

  it("raises once and does not re-raise while visible", () => {
    useChatStore.getState().showContextWindowNotice();
    expect(useChatStore.getState().contextWindowNotice).toBe("visible");

    useChatStore.getState().showContextWindowNotice();
    expect(useChatStore.getState().contextWindowNotice).toBe("visible");
  });

  it("does not come back after a dismissal", () => {
    useChatStore.getState().showContextWindowNotice();
    useChatStore.getState().dismissContextWindowNotice();
    useChatStore.getState().showContextWindowNotice();

    expect(useChatStore.getState().contextWindowNotice).toBe("dismissed");
  });

  it("resets when the conversation is replaced", () => {
    useChatStore.getState().showContextWindowNotice();
    useChatStore.getState().setMessages([]);

    expect(useChatStore.getState().contextWindowNotice).toBe("none");
  });

  it("resets when the conversation is cleared", () => {
    useChatStore.getState().showContextWindowNotice();
    useChatStore.getState().clearMessages();

    expect(useChatStore.getState().contextWindowNotice).toBe("none");
  });

  it("resets with the rest of the session state", () => {
    useChatStore.getState().showContextWindowNotice();
    useChatStore.getState().clearSessionState();

    expect(useChatStore.getState().contextWindowNotice).toBe("none");
  });
});
