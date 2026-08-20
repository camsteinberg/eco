// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface, type ChatSurfaceProps } from "../ChatSurface";

vi.mock("../EmptyChatBackdrop", () => ({
  EmptyChatBackdrop: () => <div data-testid="empty-chat-backdrop" />,
}));

vi.mock("../SuggestedPrompts", () => ({
  SuggestedPrompts: () => <div data-testid="suggested-prompts" />,
}));

vi.mock("../ChatInput", () => ({
  ChatInput: () => <textarea aria-label="Ask Eco anything" />,
}));

vi.mock("../ImpactFooter", () => ({
  ImpactFooter: () => null,
}));

vi.mock("../InConversationSearch", () => ({
  InConversationSearch: () => null,
}));

vi.mock("../MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("../../onboarding/WhyEcoCard", () => ({
  WhyEcoCard: () => null,
}));

function makeProps(overrides: Partial<ChatSurfaceProps> = {}): ChatSurfaceProps {
  return {
    messages: [],
    isStreaming: false,
    streamPhase: "idle",
    error: null,
    contextDividerIndex: 0,
    activeToolCalls: [],
    activeConversationId: null,
    allMessages: [],
    editingMessageId: null,
    reactionsMap: new Map(),
    onSendMessage: vi.fn(),
    onSubmitWithFiles: vi.fn(),
    onStopGeneration: vi.fn(),
    onRetry: vi.fn(),
    onStartEdit: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onRegenerate: vi.fn(),
    onAssistantAction: vi.fn(),
    onNavigateBranch: vi.fn(),
    onReact: vi.fn(),
    onRemoveReaction: vi.fn(),
    onPrepareLocalModel: vi.fn(),
    getLocalPrepareState: () => ({ status: "idle" }),
    searchOpen: false,
    onCloseSearch: vi.fn(),
    queryCount: 0,
    onShare: vi.fn(),
    showBatteryReducedNotice: false,
    validationProtectionBanner: null,
    validationSelectedModelBanner: null,
    isDragging: false,
    droppedAttachmentError: null,
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    ...overrides,
  };
}

describe("ChatSurface validation harness banners", () => {
  const validationSelectedModelBanner = {
    tone: "notice" as const,
    title: "Validation model selected",
    body: "Eval-only candidate Gemma 4 E2B (LiteRT) (candidate/gemma-4-e2b-litert) is selected through the local validation harness.",
    modelId: "candidate/gemma-4-e2b-litert",
    modelLabel: "Gemma 4 E2B (LiteRT)",
    profileSummary: "quick temp 0.18 cap 256 top_p 0.72 top_k 64",
  };

  it("renders the validation-selected model and requested profile on the empty chat state", () => {
    render(
      <ChatSurface
        {...makeProps({
          validationSelectedModelBanner,
        })}
      />,
    );

    const banner = screen.getByTestId("validation-selected-model-banner");
    expect(banner).toHaveTextContent("Validation model selected");
    expect(banner).toHaveTextContent("candidate/gemma-4-e2b-litert");
    expect(banner).toHaveTextContent("Requested profile: quick temp 0.18 cap 256 top_p 0.72 top_k 64");
  });

  // Locks the CSS contract for the cookie-banner clearance (F3): globals.css
  // reserves bottom space on [data-eco-chat-trust-footer] while the notice is up
  // so the mobile banner can't clip the "Read the methodology →" link below the
  // trust pills. A refactor dropping the hook would silently reopen the occlusion.
  it("marks the empty-state trust footer so the cookie notice can reserve clearance", () => {
    const { container } = render(<ChatSurface {...makeProps()} />);
    expect(container.querySelector("[data-eco-chat-trust-footer]")).not.toBeNull();
  });

  it("keeps the validation-selected model visible during an active conversation", () => {
    render(
      <ChatSurface
        {...makeProps({
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Use the validation model.",
              createdAt: new Date("2026-06-17T00:00:00.000Z").getTime(),
            },
          ],
          validationSelectedModelBanner,
        })}
      />,
    );

    expect(screen.getByTestId("message-list")).toBeInTheDocument();
    const banner = screen.getByTestId("validation-selected-model-banner");
    expect(banner).toHaveTextContent("candidate/gemma-4-e2b-litert");
    expect(banner).toHaveTextContent("Requested profile: quick temp 0.18 cap 256 top_p 0.72 top_k 64");
  });
});

describe("ChatSurface help guide button", () => {
  const conversation = [
    {
      id: "user-1",
      role: "user" as const,
      content: "Hello.",
      createdAt: new Date("2026-06-17T00:00:00.000Z").getTime(),
    },
  ];

  function helpButton() {
    return screen.getByRole("button", { name: /open eco guide/i });
  }

  it("centres the button on the impact band once the band has height", () => {
    // The band reserves a 68px lane at its right edge for this button. Centring
    // on the band keeps the disc inside the tint; the previous offset from the
    // composer bar left it straddling the band's top border.
    render(<ChatSurface {...makeProps({ messages: conversation, queryCount: 2 })} />);
    expect(helpButton()).toHaveClass("inset-y-0", "my-auto");
  });

  it("hangs the button off the composer bar when there is no impact band", () => {
    // queryCount counts completed replies, so the first turn and the failed
    // ones render without a band to sit on.
    render(<ChatSurface {...makeProps({ messages: conversation, queryCount: 0 })} />);
    expect(helpButton()).toHaveClass("bottom-[calc(100%+0.5rem)]");
  });

  it("keeps the empty state's button out of the viewports where the column reaches the edge", () => {
    // Below lg the empty-state column runs to the right edge, so a surface-pinned
    // disc lands on the send button (upgrade card open) or the attachment-limit line.
    render(<ChatSurface {...makeProps()} />);
    expect(helpButton()).toHaveClass("hidden", "lg:flex");
  });

  it("paints an opaque disc so the glyph never floats without a button under it", () => {
    render(<ChatSurface {...makeProps({ messages: conversation, queryCount: 2 })} />);
    const button = helpButton();
    expect(button).toHaveClass("bg-[var(--eco-surface-elevated)]");
    expect(button).toHaveClass("border", "border-[var(--eco-border)]");
    expect(button.className).not.toContain("bg-[var(--eco-surface-elevated)]/90");
  });

  it("keeps a full-size tap target below md while fitting the band above it", () => {
    render(<ChatSurface {...makeProps({ messages: conversation, queryCount: 2 })} />);
    expect(helpButton()).toHaveClass("h-8", "w-8", "min-h-[44px]", "min-w-[44px]", "md:min-h-0");
  });
});
