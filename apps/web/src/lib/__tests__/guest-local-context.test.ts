// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearGuestLocalContext,
  consumeGuestLocalContext,
  readGuestLocalContext,
  rememberGuestLocalContext,
} from "../guest-local-context";

describe("guest local context", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("remembers and reads the active conversation id from sessionStorage", () => {
    rememberGuestLocalContext("conv-123");

    expect(readGuestLocalContext()).toMatchObject({
      activeConversationId: "conv-123",
      composerDraft: null,
    });
  });

  it("merges composer drafts into the stored snapshot", () => {
    rememberGuestLocalContext("conv-123");
    rememberGuestLocalContext({ composerDraft: "Keep this local" });

    expect(readGuestLocalContext()).toMatchObject({
      activeConversationId: "conv-123",
      composerDraft: "Keep this local",
    });
  });

  it("consumes the stored context exactly once", () => {
    rememberGuestLocalContext({
      activeConversationId: "conv-abc",
      composerDraft: "Resume this draft",
    });

    expect(consumeGuestLocalContext()).toMatchObject({
      activeConversationId: "conv-abc",
      composerDraft: "Resume this draft",
    });
    expect(readGuestLocalContext()).toBeNull();
  });

  it("can clear only the saved conversation while keeping the composer draft", () => {
    rememberGuestLocalContext({
      activeConversationId: "conv-xyz",
      composerDraft: "Still typing",
    });

    rememberGuestLocalContext({ activeConversationId: null });

    expect(readGuestLocalContext()).toMatchObject({
      activeConversationId: null,
      composerDraft: "Still typing",
    });
  });

  it("clears malformed payloads instead of throwing", () => {
    sessionStorage.setItem("eco-auth-chat-context", "{bad json");

    expect(readGuestLocalContext()).toBeNull();
    expect(sessionStorage.getItem("eco-auth-chat-context")).toBeNull();
  });

  it("clearGuestLocalContext removes the stored snapshot", () => {
    rememberGuestLocalContext("conv-xyz");

    clearGuestLocalContext();

    expect(readGuestLocalContext()).toBeNull();
  });
});
