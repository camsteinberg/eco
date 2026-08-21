// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The floating help disc and the bottom sheet want the same corner. The disc is
 * 44px and the model sheet leaves about 38px plus the safe area under its list,
 * so on a touch layout the disc landed on the last tile's state line. It stands
 * down while any sheet is open.
 */

import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ChatSurface, type ChatSurfaceProps } from "../ChatSurface";
import {
  _resetBottomSheetOpenStateForTesting,
  registerOpenBottomSheet,
} from "../../../lib/bottom-sheet-open";
import type { ChatMessage } from "../../../stores/chatStore";

vi.mock("../EmptyChatBackdrop", () => ({
  EmptyChatBackdrop: () => <div data-testid="empty-chat-backdrop" />,
}));
vi.mock("../SuggestedPrompts", () => ({
  SuggestedPrompts: () => <div data-testid="suggested-prompts" />,
}));
vi.mock("../ChatInput", () => ({
  ChatInput: () => <textarea aria-label="Ask Eco anything" />,
}));
vi.mock("../ImpactFooter", () => ({ ImpactFooter: () => null }));
vi.mock("../InConversationSearch", () => ({ InConversationSearch: () => null }));
vi.mock("../MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));
vi.mock("../../onboarding/WhyEcoCard", () => ({ WhyEcoCard: () => null }));

const MESSAGES: ChatMessage[] = [
  { id: "u1", role: "user", content: "hi", createdAt: 1, parentId: null },
];

function makeProps(overrides: Partial<ChatSurfaceProps> = {}): ChatSurfaceProps {
  return {
    messages: MESSAGES,
    isStreaming: false,
    streamPhase: "idle",
    error: null,
    contextDividerIndex: -1,
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

function helpDisc() {
  return screen.queryByRole("button", { name: "Open Eco guide" });
}

beforeEach(() => {
  _resetBottomSheetOpenStateForTesting();
});

describe("ChatSurface — the help disc and an open bottom sheet", () => {
  it("offers the guide when nothing is covering the bottom of the screen", () => {
    render(<ChatSurface {...makeProps()} />);

    expect(helpDisc()).toBeInTheDocument();
  });

  it("stands down while a sheet is open", () => {
    registerOpenBottomSheet();

    render(<ChatSurface {...makeProps()} />);

    expect(helpDisc()).not.toBeInTheDocument();
  });

  it("comes back on its own when the sheet closes", () => {
    const release = registerOpenBottomSheet();
    render(<ChatSurface {...makeProps()} />);
    expect(helpDisc()).not.toBeInTheDocument();

    // No re-render from the parent: the disc subscribes to the signal itself.
    act(() => {
      release();
    });

    expect(helpDisc()).toBeInTheDocument();
  });
});
