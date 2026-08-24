// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The shrunk-context note is one shot PER CONVERSATION: raised once, closable
 * once, and reset wherever the conversation itself changes.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { useChatStore } from "../chatStore";

const originalPathAndQuery = `${window.location.pathname}${window.location.search}`;

beforeEach(() => {
  useChatStore.setState({ contextWindowNotice: "none", messages: [] });
});

afterEach(() => {
  window.history.replaceState({}, "", originalPathAndQuery);
  vi.unstubAllEnvs();
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

/**
 * The capture lane's seam. It has to survive a conversation load — the note only
 * makes sense above a transcript — and it has to be inert in production.
 */
describe("chatStore — contextWindowNotice under the capture harness", () => {
  it("stays raised when the harness forces it and a conversation loads", () => {
    window.history.replaceState({}, "", "/chat?eco-force-context-notice=visible");

    useChatStore.getState().setMessages([]);
    expect(useChatStore.getState().contextWindowNotice).toBe("visible");

    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().contextWindowNotice).toBe("visible");
  });

  it("is still dismissable while forced", () => {
    window.history.replaceState({}, "", "/chat?eco-force-context-notice=visible");

    useChatStore.getState().setMessages([]);
    useChatStore.getState().dismissContextWindowNotice();
    expect(useChatStore.getState().contextWindowNotice).toBe("dismissed");
  });

  it("is inert in production even with the param set", () => {
    vi.stubEnv("NEXT_PUBLIC_ECO_VALIDATION_HARNESS", "false");
    vi.stubEnv("NODE_ENV", "production");
    window.history.replaceState({}, "", "/chat?eco-force-context-notice=visible");

    useChatStore.getState().setMessages([]);
    expect(useChatStore.getState().contextWindowNotice).toBe("none");
  });
});
