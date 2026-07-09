// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingChatPrompt,
  readPendingChatPrompt,
  rememberPendingChatPrompt,
} from "../lib/pending-chat-prompt";
import { resolveAuthSuccessNavigation } from "../lib/auth-continuation";

describe("chat prompt deeplink continuation", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("keeps a chat-bound auth prompt local while redirecting to setup without the prompt in the URL", () => {
    expect(resolveAuthSuccessNavigation("/chat", "Keep this local")).toEqual({
      redirectTo: "/chat",
      promptToResume: "Keep this local",
    });
  });

  it("stores a prompt handoff locally and clears it after the single restore path consumes it", () => {
    rememberPendingChatPrompt("  Keep this local  ");

    expect(readPendingChatPrompt()).toBe("Keep this local");

    clearPendingChatPrompt();

    expect(readPendingChatPrompt()).toBeNull();
  });
});
