// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../../src/stores/chatStore";

// The local-AI gate now runs unconditionally (PR-A-11 deleted the runtime
// feature flag). LocalAiSetupGate is mocked as a passthrough below so the
// chat tree still renders end-to-end in this suite.
vi.mock("../../../../src/components/local-ai/LocalAiSetupGate", () => ({
  LocalAiSetupGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
import { useChatStore } from "../../../../src/stores/chatStore";

const navigationState = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

const chatHookState = vi.hoisted(() => ({
  interruptActiveGeneration: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  regenerateMessage: vi.fn(),
  retryMessage: vi.fn(),
  continueLatestTurnLocally: vi.fn(),
  stopGeneration: vi.fn(),
}));

const conversationStoreState = vi.hoisted(() => ({
  hasHydrated: true,
  activeConversationId: "conv-1" as string | null,
  conversations: [
    { id: "conv-1", title: "Current thread", activeLeafId: "leaf-1" as string | null },
  ],
  setActive: vi.fn((id: string | null) => {
    conversationStoreState.activeConversationId = id;
  }),
  addConversation: vi.fn(),
  loadConversationMessages: vi.fn<(conversationId: string) => Promise<ChatMessage[]>>(async () => []),
  saveMessage: vi.fn(),
  updateConversation: vi.fn(),
}));

const conversationStoreMock = vi.hoisted(() => ({
  state: conversationStoreState,
}));

const onboardingStoreMock = vi.hoisted(() => ({
  hook: (selector?: (state: { hasCompletedOnboarding: boolean }) => unknown) =>
    selector ? selector({ hasCompletedOnboarding: true }) : { hasCompletedOnboarding: true },
}));

const settingsStoreMock = vi.hoisted(() => ({
  state: {
    hasLoaded: true,
    lifetimeQueryCount: 0,
    loadFromDB: vi.fn(),
    incrementLifetimeQueryCount: vi.fn(),
  },
}));

const chatInputState = vi.hoisted(() => ({
  lastProps: null as { isStreaming?: boolean; disabled?: boolean } | null,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigationState.searchParams,
}));

vi.mock("../../../../src/hooks/useChat", () => ({
  useChat: () => ({
    messages: useChatStore.getState().messages,
    isStreaming: useChatStore.getState().isStreaming,
    streamPhase: useChatStore.getState().streamPhase,
    error: null,
    sendMessage: chatHookState.sendMessage,
    editMessage: chatHookState.editMessage,
    regenerateMessage: chatHookState.regenerateMessage,
    retryMessage: chatHookState.retryMessage,
    continueLatestTurnLocally: chatHookState.continueLatestTurnLocally,
    contextDividerIndex: -1,
    activeToolCalls: [],
    stopGeneration: chatHookState.stopGeneration,
  }),
  interruptActiveGeneration: chatHookState.interruptActiveGeneration,
}));

vi.mock("../../../../src/stores/conversationStore", () => ({
  useConversationStore: Object.assign(
    (selector?: (state: typeof conversationStoreMock.state) => unknown) =>
      selector ? selector(conversationStoreMock.state) : conversationStoreMock.state,
    {
      getState: () => conversationStoreMock.state,
    },
  ),
}));

vi.mock("../../../../src/stores/onboardingStore", () => ({
  useOnboardingStore: onboardingStoreMock.hook,
}));

vi.mock("../../../../src/stores/settingsStore", () => ({
  useSettingsStore: Object.assign(
    (selector?: (state: typeof settingsStoreMock.state) => unknown) =>
      selector ? selector(settingsStoreMock.state) : settingsStoreMock.state,
    {
      getState: () => settingsStoreMock.state,
    },
  ),
}));

vi.mock("../../../../src/hooks/useBatteryAwareness", () => ({
  useBatteryAwareness: () => ({ level: null, charging: null, restriction: "none", preferredModel: "full" }),
  computeRestriction: () => "none",
}));

vi.mock("../../../../src/local-ai/lifecycle/slots", () => ({
  SLOTS: ["eco-fast", "eco-smart"],
  getSlot: () => ({ slot: "eco-fast", modelId: null, model: null, status: "empty" }),
  getSlotForModel: () => null,
  hasReadySlot: () => false,
  subscribe: () => () => {},
  // Required by lifecycle/switch-model's default seams, which the slice-2b
  // upgrade chain (ChatWorkspace → useModelUpgrade → upgrade.ts) now pulls in.
  setSlot: vi.fn(),
  setSlotStatus: vi.fn(),
}));

vi.mock("../../../../src/local-ai/lifecycle/smoke", () => ({
  runSmoke: vi.fn(async () => ({ passed: false, reason: "mock" })),
}));

vi.mock("../../../../src/lib/local-models", () => ({
  LOCAL_MODELS: [{ id: "local/smollm3-3b", displayName: "Eco Fast", tier: "full" }],
  DEFAULT_LOCAL_MODEL: { id: "local/smollm3-3b", displayName: "Eco Fast" },
  getLaunchLocalModels: () => [],
  getRoutableLocalModels: () => [],
  getSettingsOptInDownloadableLocalModels: () => [],
  getDownloadableModels: () => [],
  getFullModel: () => null,
  getLocalModel: () => null,
  getLocalModelContextLength: () => 4096,
  getLocalModelTechnicalName: () => "Eco Fast",
  getLocalModelUserFacingSurfaceBlockers: () => [],
  isLocalModel: () => false,
  isRwkvModel: () => false,
}));

vi.mock("../../../../src/lib/local-model-state-matrix", () => ({
  getLocalModelStateMatrixRow: (modelId: string) => ({
    modelId,
    productState: "hidden",
    runtimeCapability: { contractReady: false },
  }),
}));

vi.mock("../../../../src/lib/impact-calc", () => ({
  calculateImpact: () => ({
    waterSavedLiters: 0,
    energySavedWh: 0,
    co2SavedGrams: 0,
  }),
}));

vi.mock("../../../../src/lib/db", () => ({
  openEcoDB: vi.fn(async () => ({
    getAllFromIndex: vi.fn(async () => []),
  })),
  toDbMessage: vi.fn((message) => message),
  addReactionToMessage: vi.fn(),
  removeReactionFromMessage: vi.fn(),
}));

vi.mock("../../../../src/lib/guest-local-context", () => ({
  consumeGuestLocalContext: vi.fn(() => null),
}));

vi.mock("../../../../src/lib/pending-chat-prompt", () => ({
  clearPendingChatPrompt: vi.fn(),
  normalizePendingChatPrompt: (prompt: string | null) => prompt,
  readPendingChatPrompt: vi.fn(() => null),
  rememberPendingChatPrompt: vi.fn(),
}));

vi.mock("../../../../src/lib/conversation-navigation", () => ({
  consumePendingConversationSearch: vi.fn(() => false),
  consumePendingMessageFocus: vi.fn(),
  readPendingMessageFocus: vi.fn(() => null),
}));

vi.mock("../../../../src/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));

vi.mock("../../../../src/components/chat/MessageList", () => ({
  MessageList: (props: { messages: ChatMessage[] }) => (
    <div data-testid="message-list">
      {props.messages.map((message) => `${message.role}:${message.content}`).join(" | ")}
    </div>
  ),
}));

vi.mock("../../../../src/components/chat/ChatInput", () => ({
  ChatInput: (props: { isStreaming?: boolean; disabled?: boolean }) => {
    chatInputState.lastProps = props;
    return (
      <div data-testid="chat-input-state">
        {props.isStreaming ? "stop" : props.disabled ? "disabled" : "send"}
      </div>
    );
  },
}));

vi.mock("../../../../src/components/chat/ImpactFooter", () => ({
  ImpactFooter: () => null,
}));

vi.mock("../../../../src/components/impact/ImpactShareCardCanvas", () => ({
  ImpactShareCardCanvas: () => null,
}));

vi.mock("../../../../src/components/chat/InConversationSearch", () => ({
  InConversationSearch: () => null,
}));

vi.mock("../../../../src/components/onboarding/OnboardingTour", () => ({
  OnboardingTour: () => null,
}));

vi.mock("../../../../src/components/onboarding/WhyEcoCard", () => ({
  WhyEcoCard: () => null,
}));

vi.mock("../../../../src/components/chat/WaterCounter", () => ({
  WaterCounter: () => null,
}));

vi.mock("../../../../src/components/chat/LocalInferenceErrorBoundary", () => ({
  LocalInferenceErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import ChatPage from "../page";

describe("Chat workspace stream state", () => {
  beforeEach(() => {
    navigationState.searchParams = new URLSearchParams();
    chatHookState.interruptActiveGeneration.mockReset();
    conversationStoreMock.state.hasHydrated = true;
    conversationStoreMock.state.activeConversationId = "conv-1";
    conversationStoreMock.state.conversations = [
      { id: "conv-1", title: "Current thread", activeLeafId: "leaf-1" },
    ];
    conversationStoreMock.state.setActive.mockClear();
    conversationStoreMock.state.addConversation.mockClear();
    conversationStoreMock.state.loadConversationMessages.mockReset();
    conversationStoreMock.state.loadConversationMessages.mockResolvedValue([]);
    conversationStoreMock.state.saveMessage.mockClear();
    conversationStoreMock.state.updateConversation.mockClear();
    settingsStoreMock.state.loadFromDB.mockClear();
    chatInputState.lastProps = null;

    useChatStore.setState({
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Hello",
          createdAt: 1,
          parentId: null,
          status: "complete",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Ready",
          createdAt: 2,
          parentId: "user-1",
          status: "complete",
        },
      ],
      composerDraft: "",
      streamPhase: "idle",
      isStreaming: false,
      error: null,
      selectedModel: "auto",
      localToolNoticeShown: false,
    });
    conversationStoreMock.state.loadConversationMessages.mockResolvedValue(
      useChatStore.getState().messages,
    );
  });

  it("keeps the stop affordance visible when the active leaf changes during streaming", async () => {
    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-input-state")).toHaveTextContent("send");
    });

    conversationStoreMock.state.loadConversationMessages.mockClear();

    const streamingMessages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "Hello",
        createdAt: 1,
        parentId: null,
        status: "complete" as const,
      },
      {
        id: "assistant-2",
        role: "assistant" as const,
        content: "",
        createdAt: 3,
        parentId: "user-1",
        status: "streaming" as const,
      },
    ];

    useChatStore.setState({
      messages: streamingMessages,
      streamPhase: "generating",
      isStreaming: true,
    });
    conversationStoreMock.state.conversations = [
      { id: "conv-1", title: "Current thread", activeLeafId: "assistant-2" },
    ];
    conversationStoreMock.state.loadConversationMessages.mockResolvedValue(streamingMessages);

    rerender(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-input-state")).toHaveTextContent("stop");
    });

    expect(conversationStoreMock.state.loadConversationMessages).not.toHaveBeenCalled();
    expect(chatHookState.interruptActiveGeneration).not.toHaveBeenCalled();
  });

  it("interrupts the origin thread when switching conversations mid-stream", async () => {
    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-input-state")).toHaveTextContent("send");
    });

    const streamingMessages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "Hello",
        createdAt: 1,
        parentId: null,
        status: "complete" as const,
      },
      {
        id: "assistant-2",
        role: "assistant" as const,
        content: "Partial",
        createdAt: 3,
        parentId: "user-1",
        status: "streaming" as const,
      },
    ];

    useChatStore.setState({
      messages: streamingMessages,
      streamPhase: "generating",
      isStreaming: true,
    });
    conversationStoreMock.state.conversations = [
      { id: "conv-1", title: "Current thread", activeLeafId: "assistant-2" },
    ];

    rerender(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-input-state")).toHaveTextContent("stop");
    });

    chatHookState.interruptActiveGeneration.mockClear();
    conversationStoreMock.state.activeConversationId = "conv-2";
    conversationStoreMock.state.conversations = [
      { id: "conv-1", title: "Current thread", activeLeafId: "assistant-2" },
      { id: "conv-2", title: "Other thread", activeLeafId: "leaf-9" },
    ];
    conversationStoreMock.state.loadConversationMessages.mockResolvedValue([]);

    rerender(<ChatPage />);

    await waitFor(() => {
      expect(chatHookState.interruptActiveGeneration).toHaveBeenCalledTimes(1);
    });
  });

  it("restores the interrupted origin thread from the in-memory snapshot when persistence lags", async () => {
    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByTestId("message-list")).toHaveTextContent("assistant:Ready");
    });

    const interruptedMessages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "Hello",
        createdAt: 1,
        parentId: null,
        status: "complete" as const,
      },
      {
        id: "assistant-2",
        role: "assistant" as const,
        content: "Partial answer",
        createdAt: 3,
        parentId: "user-1",
        status: "complete" as const,
        streamInterrupted: true,
      },
    ];

    chatHookState.interruptActiveGeneration.mockImplementation(() => {
      useChatStore.setState({
        messages: interruptedMessages,
        streamPhase: "idle",
        isStreaming: false,
      });
    });

    useChatStore.setState({
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Hello",
          createdAt: 1,
          parentId: null,
          status: "complete",
        },
        {
          id: "assistant-2",
          role: "assistant",
          content: "Partial",
          createdAt: 3,
          parentId: "user-1",
          status: "streaming",
        },
      ],
      streamPhase: "generating",
      isStreaming: true,
    });
    conversationStoreMock.state.activeConversationId = "conv-2";
    conversationStoreMock.state.conversations = [
      { id: "conv-1", title: "Current thread", activeLeafId: "assistant-2" },
      { id: "conv-2", title: "Draft thread", activeLeafId: null },
    ];
    conversationStoreMock.state.loadConversationMessages.mockResolvedValueOnce([]);

    rerender(<ChatPage />);

    await waitFor(() => {
      expect(chatHookState.interruptActiveGeneration).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("message-list")).not.toBeInTheDocument();
    });

    conversationStoreMock.state.activeConversationId = "conv-1";
    conversationStoreMock.state.conversations = [
      { id: "conv-1", title: "Current thread", activeLeafId: "assistant-2" },
      { id: "conv-2", title: "Draft thread", activeLeafId: null },
    ];
    conversationStoreMock.state.loadConversationMessages.mockResolvedValueOnce([]);

    rerender(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByTestId("message-list")).toHaveTextContent("assistant:Partial answer");
    });
    expect(useChatStore.getState().messages).toMatchObject(interruptedMessages);
  });
});
