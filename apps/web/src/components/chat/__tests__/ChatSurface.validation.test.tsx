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
