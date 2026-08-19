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
    isFirstGrounded,
  }: {
    content: string;
    onNavigatePrev?: () => void;
    onNavigateNext?: () => void;
    siblingInfo?: { currentIndex: number; total: number };
    isFirstGrounded?: boolean;
  }) => (
    <div>
      <span>{content}</span>
      {/* Surface the once-per-chat grounding-notice anchor decision (computed in
          MessageList) so its high-confidence gating is directly testable without
          the real notice/motion. Only renders on the anchored message. */}
      {isFirstGrounded ? <span data-testid="grounding-anchor">anchor</span> : null}
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

describe("MessageList grounding-notice anchor (provenance honesty)", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A grounded assistant reply carrying a single Wikipedia citation at the given
   * confidence tier — or, when `tier` is omitted, a legacy row (source but no tier)
   * to prove the strict `=== "high"` gate treats "unknown" as non-high.
   */
  function groundedAssistant(
    id: string,
    content: string,
    tier?: "high" | "low" | "followup" | "fulltext",
  ): ChatMessage {
    return {
      id,
      role: "assistant",
      content,
      createdAt: 2,
      parentId: "user-1",
      citations: [
        {
          id: 1,
          title: "Some Title",
          url: "https://en.wikipedia.org/wiki/Some_Title",
          source: "Wikipedia",
          ...(tier ? { groundingConfidence: tier } : {}),
        },
      ],
    };
  }

  /** The message-id of the row that received `isFirstGrounded` (the notice anchor), or null. */
  function anchoredMessageId(): string | null {
    const marker = screen.queryByTestId("grounding-anchor");
    if (marker === null) return null;
    return marker.closest("[data-message-id]")?.getAttribute("data-message-id") ?? null;
  }

  it("anchors the notice on a HIGH-confidence grounded reply", () => {
    const messages: ChatMessage[] = [
      chatMessage("user-1", "user", "what is france"),
      groundedAssistant("assistant-1", "France is a country.", "high"),
    ];
    render(<MessageList messages={messages} isStreaming={false} />);
    expect(anchoredMessageId()).toBe("assistant-1");
  });

  it.each(["fulltext", "low", "followup"] as const)(
    "does NOT anchor the notice on a %s (fuzzy) grounding — it may be off-target",
    (tier) => {
      const messages: ChatMessage[] = [
        chatMessage("user-1", "user", "how do i get a red wine stain out"),
        groundedAssistant("assistant-1", "Blot the stain…", tier),
      ];
      render(<MessageList messages={messages} isStreaming={false} />);
      expect(screen.queryByTestId("grounding-anchor")).not.toBeInTheDocument();
    },
  );

  it("skips a fuzzy first grounding and anchors the first HIGH one instead", () => {
    const messages: ChatMessage[] = [
      chatMessage("user-1", "user", "how do i get a red wine stain out"),
      groundedAssistant("assistant-1", "Blot the stain…", "fulltext"),
      chatMessage("user-2", "user", "what is france"),
      groundedAssistant("assistant-2", "France is a country.", "high"),
    ];
    render(<MessageList messages={messages} isStreaming={false} />);
    // The fuzzy earlier grounding never anchors; the later high-confidence one does.
    expect(anchoredMessageId()).toBe("assistant-2");
  });

  it("does NOT anchor a legacy grounded citation that carries no tier", () => {
    const messages: ChatMessage[] = [
      chatMessage("user-1", "user", "what is france"),
      groundedAssistant("assistant-1", "France is a country.", undefined),
    ];
    render(<MessageList messages={messages} isStreaming={false} />);
    expect(screen.queryByTestId("grounding-anchor")).not.toBeInTheDocument();
  });
});

/**
 * The transcript's bottom was sliced off on every mobile conversation: the
 * messages effect commits `scrollTop = scrollHeight` for the layout of that
 * frame, and the frame after it the geometry moves — the always-visible mobile
 * action row lands, the impact footer rewraps to two rows once the webfont
 * swaps in — leaving the committed scrollTop short of the new bottom.
 */
describe("MessageList re-anchors when the geometry moves after a scroll", () => {
  const resizeCallbacks: ResizeObserverCallback[] = [];
  let originalResizeObserver: typeof ResizeObserver;

  beforeEach(() => {
    resizeCallbacks.length = 0;
    originalResizeObserver = globalThis.ResizeObserver;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = TestResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  function fireResize() {
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
  }

  const messages = [
    chatMessage("user-1", "user", "Original prompt"),
    chatMessage("assistant-1", "assistant", "An answer"),
  ];

  it("scrolls to the new bottom when the content grows after the message effect", () => {
    const { rerender } = render(<MessageList messages={messages} isStreaming={false} />);
    const log = screen.getByRole("log");
    setScrollMetrics(log, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 0 });

    // The messages effect commits the scroll for THIS layout.
    rerender(<MessageList messages={[...messages]} isStreaming={false} />);
    expect(log.scrollTop).toBe(1_000);

    // A beat later the action row lands and the transcript is taller.
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => 1_200 });
    fireResize();

    expect(log.scrollTop).toBe(1_200);
  });

  it("leaves a user who scrolled up alone", () => {
    const { rerender } = render(<MessageList messages={messages} isStreaming={true} />);
    const log = screen.getByRole("log");
    setScrollMetrics(log, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 });

    // Scrolling up mid-stream releases the stick-to-bottom follow.
    fireEvent.wheel(log, { deltaY: -120 });
    rerender(<MessageList messages={[...messages]} isStreaming={true} />);
    expect(log.scrollTop).toBe(600);

    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => 1_200 });
    fireResize();

    expect(log.scrollTop).toBe(600);
  });
});
