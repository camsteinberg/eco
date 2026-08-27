// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The note that says Eco can no longer see the start of the chat. It names how
 * many messages are out of view, says what to do, and never comes back once
 * dismissed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ContextWindowNotice, contextWindowNoticeCopy } from "../ContextWindowNotice";
import { useChatStore } from "../../../stores/chatStore";

beforeEach(() => {
  useChatStore.setState({ contextWindowNotice: "none" });
});

describe("ContextWindowNotice", () => {
  it("says nothing until the note is raised", () => {
    render(<ContextWindowNotice />);

    expect(screen.queryByTestId("context-window-notice")).not.toBeInTheDocument();
  });

  it("names how many messages are out of view and says what to do", () => {
    useChatStore.setState({ contextWindowNotice: "visible" });

    render(<ContextWindowNotice droppedCount={6} />);

    const note = screen.getByTestId("context-window-notice");
    expect(note).toHaveTextContent(
      "Eco can no longer see the first 6 messages in this chat. Start a new chat, or paste the details that matter into your next message.",
    );
    // Nothing is lost: the messages are still on screen.
    expect(note).not.toHaveTextContent(/lost|deleted|error/i);
    // Product rule: no em dashes in user-facing copy.
    expect(note.textContent ?? "").not.toContain("—");
  });

  it("handles one message and an unknown count", () => {
    expect(contextWindowNoticeCopy(1)).toMatch(/^Eco can no longer see the first message in this chat\./);
    expect(contextWindowNoticeCopy(0)).toMatch(/^Eco can no longer see the earliest messages in this chat\./);
  });

  it("dismisses to a state it cannot return from", async () => {
    useChatStore.setState({ contextWindowNotice: "visible" });
    const user = userEvent.setup();

    render(<ContextWindowNotice />);
    await user.click(screen.getByTestId("context-window-notice-dismiss"));

    expect(useChatStore.getState().contextWindowNotice).toBe("dismissed");
    // Further eviction cannot re-raise it for this conversation.
    useChatStore.getState().showContextWindowNotice();
    expect(useChatStore.getState().contextWindowNotice).toBe("dismissed");
  });
});
