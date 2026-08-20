// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { buildMatchIndex, InConversationSearch } from "../InConversationSearch";
import type { ChatMessage } from "../../../stores/chatStore";

function msg(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content, createdAt: Date.now() };
}

describe("buildMatchIndex", () => {
  it("returns empty array for empty query", () => {
    const messages = [msg("1", "user", "hello world")];
    expect(buildMatchIndex(messages, "")).toEqual([]);
    expect(buildMatchIndex(messages, "   ")).toEqual([]);
  });

  it("finds all case-insensitive substring matches across messages", () => {
    const messages = [
      msg("1", "user", "Hello World hello"),
      msg("2", "assistant", "hello back"),
    ];
    const matches = buildMatchIndex(messages, "hello");
    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({ messageId: "1", matchIndex: 0 });
    expect(matches[1]).toEqual({ messageId: "1", matchIndex: 1 });
    expect(matches[2]).toEqual({ messageId: "2", matchIndex: 0 });
  });

  it("skips system messages", () => {
    const messages = [
      msg("1", "system", "You are helpful"),
      msg("2", "user", "hello"),
    ];
    const matches = buildMatchIndex(messages, "helpful");
    expect(matches).toEqual([]);
  });

  it("returns empty array when no matches found", () => {
    const messages = [msg("1", "user", "hello")];
    expect(buildMatchIndex(messages, "xyz")).toEqual([]);
  });
});

describe("InConversationSearch", () => {
  const messages = [
    msg("1", "user", "Hello World hello"),
    msg("2", "assistant", "hello back"),
  ];
  const onClose = vi.fn();

  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <InConversationSearch messages={messages} isOpen={false} onClose={onClose} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders search bar when isOpen is true", () => {
    render(
      <InConversationSearch messages={messages} isOpen={true} onClose={onClose} />
    );
    expect(screen.getByPlaceholderText("Search in conversation...")).toBeInTheDocument();
  });

  it("shows match count display when searching", async () => {
    const user = userEvent.setup();
    render(
      <InConversationSearch messages={messages} isOpen={true} onClose={onClose} />
    );
    const input = screen.getByPlaceholderText("Search in conversation...");
    await user.type(input, "hello");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("shows 'No matches' when query has no results", async () => {
    const user = userEvent.setup();
    render(
      <InConversationSearch messages={messages} isOpen={true} onClose={onClose} />
    );
    const input = screen.getByPlaceholderText("Search in conversation...");
    await user.type(input, "xyz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("navigates to next match and wraps to 0 at end", async () => {
    const user = userEvent.setup();
    render(
      <InConversationSearch messages={messages} isOpen={true} onClose={onClose} />
    );
    const input = screen.getByPlaceholderText("Search in conversation...");
    await user.type(input, "hello");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    // Click next arrow button
    const nextBtn = screen.getByLabelText("Next match");
    await user.click(nextBtn);
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    await user.click(nextBtn);
    expect(screen.getByText("3 of 3")).toBeInTheDocument();

    // Wraps around
    await user.click(nextBtn);
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("navigates to previous match and wraps to last at beginning", async () => {
    const user = userEvent.setup();
    render(
      <InConversationSearch messages={messages} isOpen={true} onClose={onClose} />
    );
    const input = screen.getByPlaceholderText("Search in conversation...");
    await user.type(input, "hello");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    // Click prev arrow button wraps to last
    const prevBtn = screen.getByLabelText("Previous match");
    await user.click(prevBtn);
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });

  it("resets currentMatchIndex to 0 when query changes", async () => {
    const user = userEvent.setup();
    render(
      <InConversationSearch messages={messages} isOpen={true} onClose={onClose} />
    );
    const input = screen.getByPlaceholderText("Search in conversation...");
    await user.type(input, "hello");

    // Navigate to match 2
    const nextBtn = screen.getByLabelText("Next match");
    await user.click(nextBtn);
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    // Clear and type new query -- resets to 1 of N
    await user.clear(input);
    await user.type(input, "world");
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("calls onClose on Escape key", async () => {
    const closeFn = vi.fn();
    const user = userEvent.setup();
    render(
      <InConversationSearch messages={messages} isOpen={true} onClose={closeFn} />
    );
    const input = screen.getByPlaceholderText("Search in conversation...");
    await user.type(input, "{Escape}");
    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("shows a focus indicator on the field", () => {
    // The field sits beside three real buttons (previous, next, close), so a
    // keyboard user can tab back to it. It used to clear the outline without
    // putting anything in its place, leaving focus invisible.
    render(
      <InConversationSearch messages={messages} isOpen={true} onClose={vi.fn()} />
    );
    const input = screen.getByPlaceholderText("Search in conversation...");
    expect(input.className).toContain("focus:border-[var(--eco-primary)]");
    expect(input.className).toContain("focus:ring-2");
    expect(input.className).toContain("focus:ring-[var(--eco-primary)]/20");
    // An inline borderColor would outrank the focus class, so the resting
    // border has to stay in the class list.
    expect(input.getAttribute("style")).not.toContain("border-color");
  });
});
