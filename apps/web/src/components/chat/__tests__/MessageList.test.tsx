// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MessageList } from "../MessageList";
import type { ChatMessage } from "../../../stores/chatStore";

const navigateToBranchMock = vi.fn();

vi.mock("../../../hooks/useBranchNavigation", () => ({
  useBranchNavigation: () => ({
    siblingInfo: new Map([
      [
        "assistant-1",
        {
          siblings: [{ id: "assistant-1" }, { id: "assistant-2" }],
          currentIndex: 0,
          total: 2,
        },
      ],
    ]),
    navigateToBranch: navigateToBranchMock,
  }),
}));

vi.mock("../MessageBubble", () => ({
  MessageBubble: ({
    content,
    onNavigatePrev,
    onNavigateNext,
    siblingInfo,
  }: {
    content: string;
    onNavigatePrev?: () => void;
    onNavigateNext?: () => void;
    siblingInfo?: { currentIndex: number; total: number };
  }) => (
    <div>
      <span>{content}</span>
      {siblingInfo ? (
        <div>
          <button type="button" onClick={onNavigatePrev}>
            Previous version
          </button>
          <button type="button" onClick={onNavigateNext}>
            Next version
          </button>
        </div>
      ) : null}
    </div>
  ),
}));

function chatMessage(id: string, role: "user" | "assistant", content: string): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt: 1,
    parentId: role === "assistant" ? "user-1" : null,
  };
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  let scrollTop = metrics.scrollTop;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = value;
    },
  });
}

describe("MessageList branch navigation", () => {
  beforeEach(() => {
    navigateToBranchMock.mockReset();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates branch state before notifying the parent reload handler", async () => {
    const user = userEvent.setup();
    const onNavigateBranch = vi.fn();

    const messages: ChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "Original prompt",
        createdAt: 1,
        parentId: null,
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "First draft",
        createdAt: 2,
        parentId: "user-1",
      },
    ];

    render(
      <MessageList
        messages={messages}
        isStreaming={false}
        allMessages={[
          {
            id: "user-1",
            conversationId: "conv-1",
            role: "user",
            content: "Original prompt",
            createdAt: 1,
            parentId: null,
          },
          {
            id: "assistant-1",
            conversationId: "conv-1",
            role: "assistant",
            content: "First draft",
            createdAt: 2,
            parentId: "user-1",
          },
          {
            id: "assistant-2",
            conversationId: "conv-1",
            role: "assistant",
            content: "Second draft",
            createdAt: 3,
            parentId: "user-1",
          },
        ]}
        activeBranch={messages}
        onNavigateBranch={onNavigateBranch}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next version" }));

    expect(navigateToBranchMock).toHaveBeenCalledWith("assistant-1", "next");
    expect(onNavigateBranch).toHaveBeenCalledWith("assistant-1", "next");
    expect(navigateToBranchMock.mock.invocationCallOrder[0]!).toBeLessThan(
      onNavigateBranch.mock.invocationCallOrder[0]!,
    );
  });

  it("renders messages in normal document flow so tall answers cannot overlap later turns", () => {
    const messages = [
      chatMessage("user-1", "user", "Original prompt"),
      chatMessage("assistant-1", "assistant", "First draft ".repeat(120)),
      chatMessage("user-2", "user", "Follow-up prompt"),
    ];

    render(<MessageList messages={messages} isStreaming={false} />);

    const log = screen.getByRole("log");
    const rows = Array.from(log.querySelectorAll("[data-message-id]")).map((row) => ({
      id: row.getAttribute("data-message-id"),
      text: row.textContent,
      position: (row as HTMLElement).style.position,
      transform: (row as HTMLElement).style.transform,
    }));
    expect(rows).toEqual([
      expect.objectContaining({ id: "user-1", text: expect.stringContaining("Original prompt") }),
      expect.objectContaining({ id: "assistant-1", text: expect.stringContaining("First draft") }),
      expect.objectContaining({ id: "user-2", text: expect.stringContaining("Follow-up prompt") }),
    ]);
    expect(rows.every((row) => row.position !== "absolute" && !row.transform)).toBe(true);
  });

  it("renders an accessible context boundary before messages still in the model context", () => {
    const messages = [
      chatMessage("user-1", "user", "Older prompt"),
      chatMessage("assistant-1", "assistant", "Older answer"),
      chatMessage("user-2", "user", "Current prompt"),
    ];

    render(
      <MessageList
        messages={messages}
        isStreaming={false}
        contextDividerIndex={2}
      />,
    );

    expect(screen.getByRole("note", { name: /context window boundary/i })).toHaveTextContent(
      "Messages above are no longer in context",
    );
  });

  it("exposes chat log semantics with polite announcements for updates", () => {
    const messages = [
      chatMessage("user-1", "user", "Original prompt"),
      chatMessage("assistant-1", "assistant", "Streaming answer"),
    ];

    render(<MessageList messages={messages} isStreaming={true} streamPhase="generating" />);

    const log = screen.getByRole("log", { name: "Chat messages" });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("aria-relevant", "additions text");
    expect(log).toHaveAttribute("aria-atomic", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Assistant response generating");
  });

  it("keeps following the latest streaming message when the user stays at the bottom", () => {
    const initialMessages = [
      chatMessage("user-1", "user", "Original prompt"),
      chatMessage("assistant-1", "assistant", "Short"),
    ];
    const { rerender } = render(
      <MessageList messages={initialMessages} isStreaming={true} />,
    );
    const log = screen.getByRole("log");
    setScrollMetrics(log, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 });

    rerender(
      <MessageList
        messages={[
          initialMessages[0]!,
          chatMessage("assistant-1", "assistant", "Long answer ".repeat(80)),
        ]}
        isStreaming={true}
      />,
    );

    expect(log.scrollTop).toBe(1_000);
  });

  it("does not force-scroll while a streaming user is scrolling upward", () => {
    const initialMessages = [
      chatMessage("user-1", "user", "Original prompt"),
      chatMessage("assistant-1", "assistant", "Short"),
    ];
    const { rerender } = render(
      <MessageList messages={initialMessages} isStreaming={true} />,
    );
    const log = screen.getByRole("log");
    setScrollMetrics(log, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 });

    fireEvent.wheel(log, { deltaY: -120 });

    rerender(
      <MessageList
        messages={[
          initialMessages[0]!,
          chatMessage("assistant-1", "assistant", "Long answer ".repeat(80)),
        ]}
        isStreaming={true}
      />,
    );

    expect(log.scrollTop).toBe(600);
  });
});
