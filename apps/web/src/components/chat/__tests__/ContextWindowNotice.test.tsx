// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The quiet note that explains a shrunk context window. It says WHY more of
 * the chat fell out of context and points at the divider that moved; it never
 * restates the divider, demands a new chat, or comes back once dismissed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ContextWindowNotice } from "../ContextWindowNotice";
import { useChatStore } from "../../../stores/chatStore";

beforeEach(() => {
  useChatStore.setState({ contextWindowNotice: "none" });
});

describe("ContextWindowNotice", () => {
  it("says nothing until the note is raised", () => {
    render(<ContextWindowNotice />);

    expect(screen.queryByTestId("context-window-notice")).not.toBeInTheDocument();
  });

  it("explains why earlier messages moved out of context, in one plain sentence", () => {
    useChatStore.setState({ contextWindowNotice: "visible" });

    render(<ContextWindowNotice />);

    const note = screen.getByTestId("context-window-notice");
    expect(note).toHaveTextContent(
      "This model holds less of the conversation, so more of the earlier messages are set aside above the line.",
    );
    // Ambient, not an alert: it never claims anything is lost or broken.
    expect(note).not.toHaveTextContent(/lost|error|start a new chat/i);
    // Product rule: no em dashes in user-facing copy.
    expect(note.textContent ?? "").not.toContain("—");
  });

  it("dismisses to a state it cannot return from", async () => {
    useChatStore.setState({ contextWindowNotice: "visible" });
    const user = userEvent.setup();

    render(<ContextWindowNotice />);
    await user.click(screen.getByTestId("context-window-notice-dismiss"));

    expect(useChatStore.getState().contextWindowNotice).toBe("dismissed");
    // A later shrink cannot re-raise it for this conversation.
    useChatStore.getState().showContextWindowNotice();
    expect(useChatStore.getState().contextWindowNotice).toBe("dismissed");
  });
});
