// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The local-AI gate now runs unconditionally (PR-A-11 deleted the runtime
// feature flag). LocalAiSetupGate is mocked further below so the chat tree
// still renders end-to-end in this suite.

const navigationState = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

const chatHookState = vi.hoisted(() => ({
  isStreaming: false,
  sendMessage: vi.fn(),
  retryMessage: vi.fn(),
  continueLatestTurnLocally: vi.fn(),
  editMessage: vi.fn(),
  regenerateMessage: vi.fn(),
  stopGeneration: vi.fn(),
  interruptActiveGeneration: vi.fn(),
}));

const chatStoreMock = vi.hoisted(() => {
  const state = {
    messages: [] as Array<{ id: string; role: "user" | "assistant"; content: string }>,
    composerDraft: "",
    isStreaming: false,
    rateLimitInfo: null,
    privacyTier: "encrypted",
    selectedModel: "auto",
    localToolNoticeShown: false,
    setError: vi.fn(),
    setComposerDraft: vi.fn((draft: string) => {
      state.composerDraft = draft;
    }),
    restorePersistedComposerDraft: vi.fn(() => {
      state.composerDraft = localStorage.getItem("eco-composer-draft") ?? "";
    }),
    clearComposerDraft: vi.fn(() => {
      state.composerDraft = "";
    }),
    clearMessages: vi.fn((options?: { preserveComposerDraft?: boolean }) => {
      state.messages = [];
      if (!options?.preserveComposerDraft) {
        localStorage.removeItem("eco-composer-draft");
        state.composerDraft = "";
      }
    }),
    setMessages: vi.fn((messages: Array<{ id: string; role: "user" | "assistant"; content: string }>) => {
      state.messages = messages;
    }),
    setSelectedModel: vi.fn((model: string) => {
      state.selectedModel = model;
    }),
    setRateLimitInfo: vi.fn(),
    incrementLifetimeQueryCount: vi.fn(),
  };

  const hook = ((selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state) as typeof state & {
    (selector?: (value: typeof state) => unknown): unknown;
    getState: () => typeof state;
    setState: (updates: Partial<typeof state>) => void;
  };

  hook.getState = () => state;
  hook.setState = (updates) => {
    Object.assign(state, updates);
  };

  return { state, hook };
});

const conversationStoreMock = vi.hoisted(() => {
  type MockConversationMessage = {
    id: string;
    role: "user" | "assistant";
    content: string;
  };

  const state = {
    hasHydrated: true,
    activeConversationId: null as string | null,
    conversations: [] as Array<{ id: string }>,
    setActive: vi.fn((id: string | null) => {
      state.activeConversationId = id;
    }),
    restorePersistedActiveConversation: vi.fn(() => {
      const storedId = localStorage.getItem("eco-active-conversation");
      if (storedId && state.conversations.some((conversation) => conversation.id === storedId)) {
        state.activeConversationId = storedId;
      }
    }),
    addConversation: vi.fn(({ id }: { id: string }) => {
      state.activeConversationId = id;
      state.conversations = [{ id }];
    }),
    loadConversationMessages: vi.fn<
      (conversationId: string) => Promise<MockConversationMessage[]>
    >(async (_conversationId: string) => []),
    saveMessage: vi.fn(),
    updateConversation: vi.fn(),
  };

  const hook = ((selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state) as typeof state & {
    (selector?: (value: typeof state) => unknown): unknown;
    getState: () => typeof state;
  };

  hook.getState = () => state;

  return { state, hook };
});

const onboardingStoreMock = vi.hoisted(() => {
  const state = {
    hasCompletedOnboarding: true,
  };

  const hook = ((selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state) as typeof state & {
    (selector?: (value: typeof state) => unknown): unknown;
  };

  return { state, hook };
});

const settingsStoreMock = vi.hoisted(() => {
  const state = {
    hasLoaded: true,
    loadFromDB: vi.fn(),
    incrementLifetimeQueryCount: vi.fn(),
  };

  const hook = ((selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state) as typeof state & {
    (selector?: (value: typeof state) => unknown): unknown;
    getState: () => typeof state;
  };

  hook.getState = () => state;

  return { state, hook };
});

const guestContextState = vi.hoisted(() => ({
  value: null as { activeConversationId: string | null; composerDraft: string | null } | null,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigationState.searchParams,
}));

vi.mock("../../../../src/hooks/useChat", () => ({
  useChat: () => ({
    messages: chatStoreMock.state.messages,
    isStreaming: chatHookState.isStreaming,
    streamPhase: "idle",
    error: null,
    sendMessage: chatHookState.sendMessage,
    editMessage: chatHookState.editMessage,
    regenerateMessage: chatHookState.regenerateMessage,
    retryMessage: chatHookState.retryMessage,
    continueLatestTurnLocally: chatHookState.continueLatestTurnLocally,
    contextDividerIndex: null,
    activeToolCalls: [],
    stopGeneration: chatHookState.stopGeneration,
  }),
  interruptActiveGeneration: chatHookState.interruptActiveGeneration,
}));

vi.mock("../../../../src/components/local-ai/LocalAiSetupGate", () => ({
  LocalAiSetupGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../../../../src/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

vi.mock("../../../../src/components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("../../../../src/components/chat/ChatInput", () => ({
  ChatInput: () => <input aria-label="Message eco" />,
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
  LocalInferenceErrorBoundary: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../../../../src/stores/chatStore", () => ({
  useChatStore: chatStoreMock.hook,
}));

vi.mock("../../../../src/stores/conversationStore", () => ({
  useConversationStore: conversationStoreMock.hook,
}));

vi.mock("../../../../src/stores/onboardingStore", () => ({
  useOnboardingStore: onboardingStoreMock.hook,
}));

vi.mock("../../../../src/stores/settingsStore", () => ({
  useSettingsStore: settingsStoreMock.hook,
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

vi.mock("../../../../src/lib/db", () => ({
  openEcoDB: vi.fn(),
  toDbMessage: vi.fn(),
  addReactionToMessage: vi.fn(),
  removeReactionFromMessage: vi.fn(),
}));

vi.mock("../../../../src/lib/file-extract", () => ({
  validateFile: vi.fn(),
  extractText: vi.fn(),
  buildMessageWithFiles: vi.fn((text: string) => text),
}));

vi.mock("../../../../src/lib/impact-calc", () => ({
  calculateImpact: () => ({
    waterSavedLiters: 0,
  }),
}));

vi.mock("../../../../src/lib/local-models", () => ({
  isLocalModel: () => false,
  getFullModel: vi.fn(),
  getDownloadableModels: () => [{ id: "local/qwen3-0.6b" }],
  DEFAULT_LOCAL_MODEL: { id: "local/qwen3-0.6b" },
}));

vi.mock("../../../../src/lib/guest-local-context", () => ({
  consumeGuestLocalContext: () => guestContextState.value,
  readGuestLocalContext: () => guestContextState.value,
}));

import ChatPage from "../page";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockSendMessageAddsMessages() {
  chatHookState.sendMessage.mockImplementation((content: string) => {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return;
    }

    const nextMessageIndex = chatStoreMock.state.messages.length + 1;
    chatStoreMock.state.messages = [
      ...chatStoreMock.state.messages,
      {
        id: `user-${nextMessageIndex}`,
        role: "user",
        content: trimmedContent,
      },
      {
        id: `assistant-${nextMessageIndex}`,
        role: "assistant",
        content: "",
      },
    ];
  });
}

describe("ChatPage prompt deeplinks", () => {
  beforeEach(() => {
    navigationState.searchParams = new URLSearchParams();
    chatHookState.isStreaming = false;
    chatHookState.sendMessage.mockReset();
    chatHookState.retryMessage.mockReset();
    chatHookState.continueLatestTurnLocally.mockReset();
    chatHookState.editMessage.mockReset();
    chatHookState.regenerateMessage.mockReset();
    chatHookState.stopGeneration.mockReset();
    chatHookState.interruptActiveGeneration.mockReset();
    chatStoreMock.state.messages = [];
    chatStoreMock.state.composerDraft = "";
    chatStoreMock.state.isStreaming = false;
    chatStoreMock.state.selectedModel = "auto";
    chatStoreMock.state.setComposerDraft.mockClear();
    chatStoreMock.state.clearComposerDraft.mockClear();
    chatStoreMock.state.clearMessages.mockClear();
    chatStoreMock.state.setMessages.mockClear();
    chatStoreMock.state.setSelectedModel.mockClear();
    chatStoreMock.state.restorePersistedComposerDraft.mockClear();
    settingsStoreMock.state.hasLoaded = true;
    settingsStoreMock.state.loadFromDB.mockClear();
    settingsStoreMock.state.incrementLifetimeQueryCount.mockClear();
    conversationStoreMock.state.hasHydrated = true;
    conversationStoreMock.state.activeConversationId = null;
    conversationStoreMock.state.conversations = [];
    conversationStoreMock.state.setActive.mockClear();
    conversationStoreMock.state.restorePersistedActiveConversation.mockClear();
    conversationStoreMock.state.addConversation.mockClear();
    conversationStoreMock.state.loadConversationMessages.mockClear();
    conversationStoreMock.state.saveMessage.mockClear();
    conversationStoreMock.state.updateConversation.mockClear();
    onboardingStoreMock.state.hasCompletedOnboarding = true;
    guestContextState.value = null;
    mockSendMessageAddsMessages();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/chat");
  });

  it("waits until sending can start before cleaning the prompt URL", async () => {
    navigationState.searchParams = new URLSearchParams({
      prompt: "Keep this local",
    });
    chatHookState.isStreaming = true;

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");
    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(chatStoreMock.state.setComposerDraft).toHaveBeenCalledWith(
        "Keep this local",
      );
    });

    expect(chatHookState.sendMessage).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();

    chatHookState.isStreaming = false;
    rerender(<ChatPage />);

    await waitFor(() => {
      expect(chatHookState.sendMessage).toHaveBeenCalledWith("Keep this local");
    });

    expect(chatHookState.sendMessage).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/chat");

    navigationState.searchParams = new URLSearchParams();
    rerender(<ChatPage />);

    expect(chatHookState.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("waits for settings hydration before auto-submitting a prompt deeplink", async () => {
    navigationState.searchParams = new URLSearchParams({
      prompt: "Keep this local",
    });
    settingsStoreMock.state.hasLoaded = false;
    window.history.replaceState({}, "", "/chat?prompt=Keep+this+local");

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");
    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(chatStoreMock.state.setComposerDraft).toHaveBeenCalledWith(
        "Keep this local",
      );
    });

    expect(chatHookState.sendMessage).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalledWith({}, "", "/chat");
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBe(
      "Keep this local",
    );

    settingsStoreMock.state.hasLoaded = true;
    rerender(<ChatPage />);

    await waitFor(() => {
      expect(chatHookState.sendMessage).toHaveBeenCalledWith("Keep this local");
    });

    expect(chatHookState.sendMessage).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/chat");
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBeNull();
  });

  it("submits a persisted pending prompt after readiness removes the query string", async () => {
    sessionStorage.setItem("eco-pending-chat-prompt", "Resume this prompt");

    render(<ChatPage />);

    await waitFor(() => {
      expect(chatHookState.sendMessage).toHaveBeenCalledWith(
        "Resume this prompt",
      );
    });

    expect(chatHookState.sendMessage).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBeNull();
  });

  it("does not auto-submit stale deeplink text after the user edits the composer during settings hydration", async () => {
    navigationState.searchParams = new URLSearchParams({
      prompt: "Original private prompt",
    });
    settingsStoreMock.state.hasLoaded = false;
    window.history.replaceState({}, "", "/chat?prompt=Original+private+prompt");

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");
    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(chatStoreMock.state.setComposerDraft).toHaveBeenCalledWith(
        "Original private prompt",
      );
    });

    chatStoreMock.state.composerDraft = "Edited visible draft";
    settingsStoreMock.state.hasLoaded = true;
    rerender(<ChatPage />);

    await waitFor(() => {
      expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBeNull();
    });

    expect(chatHookState.sendMessage).not.toHaveBeenCalled();
    expect(chatStoreMock.state.composerDraft).toBe("Edited visible draft");
    expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/chat");
  });

  it("does not restore and auto-submit deeplink text after the user clears the composer during settings hydration", async () => {
    navigationState.searchParams = new URLSearchParams({
      prompt: "Delete this private prompt",
    });
    settingsStoreMock.state.hasLoaded = false;
    window.history.replaceState({}, "", "/chat?prompt=Delete+this+private+prompt");

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");
    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(chatStoreMock.state.setComposerDraft).toHaveBeenCalledWith(
        "Delete this private prompt",
      );
    });

    chatStoreMock.state.setComposerDraft.mockClear();
    chatStoreMock.state.composerDraft = "";
    settingsStoreMock.state.hasLoaded = true;
    rerender(<ChatPage />);

    await waitFor(() => {
      expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBeNull();
    });

    // The mirror effect must not re-insert the prompt once the user clears it.
    expect(chatStoreMock.state.setComposerDraft).not.toHaveBeenCalledWith(
      "Delete this private prompt",
    );
    expect(chatHookState.sendMessage).not.toHaveBeenCalled();
    expect(chatStoreMock.state.composerDraft).toBe("");
    expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/chat");
  });

  it("does not let guest draft restore override a prompt deeplink", async () => {
    guestContextState.value = {
      activeConversationId: null,
      composerDraft: "Resume this protected-route draft",
    };
    navigationState.searchParams = new URLSearchParams({
      prompt: "Use the deeplink prompt",
    });
    window.history.replaceState({}, "", "/chat?prompt=Use+the+deeplink+prompt");

    render(<ChatPage />);

    await waitFor(() => {
      expect(chatHookState.sendMessage).toHaveBeenCalledWith(
        "Use the deeplink prompt",
      );
    });

    expect(chatHookState.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatStoreMock.state.composerDraft).toBe("");
    expect(chatStoreMock.state.setComposerDraft).not.toHaveBeenCalledWith(
      "Resume this protected-route draft",
    );
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBeNull();
  });

  it("restores a saved guest draft into the composer before sending", async () => {
    guestContextState.value = {
      activeConversationId: null,
      composerDraft: "Resume this protected-route draft",
    };

    render(<ChatPage />);

    await waitFor(() => {
      expect(chatStoreMock.state.setComposerDraft).toHaveBeenCalledWith(
        "Resume this protected-route draft",
      );
    });

    expect(chatHookState.sendMessage).not.toHaveBeenCalled();
  });

  it("renders ChatWorkspace even when onboarding is incomplete (gate handles first-run)", async () => {
    onboardingStoreMock.state.hasCompletedOnboarding = false;
    conversationStoreMock.state.activeConversationId = "conv-123";
    conversationStoreMock.state.conversations = [{ id: "conv-123" }];

    render(<ChatPage />);

    // FirstRunChatBackdrop was removed; LocalAiSetupGate (mocked as a
    // passthrough in this suite) now owns the first-run decision.
    // ChatWorkspace renders directly.
    expect(screen.queryByTestId("first-run-chat-backdrop")).not.toBeInTheDocument();
  });

  it("renders ChatWorkspace on a draft-only revisit when onboarding is incomplete", async () => {
    onboardingStoreMock.state.hasCompletedOnboarding = false;
    localStorage.setItem("eco-composer-draft", "Return to my unsent draft");

    render(<ChatPage />);

    // FirstRunChatBackdrop was removed; the gate handles first-run UX.
    // ChatWorkspace renders and the draft restore flow proceeds normally.
    expect(screen.queryByTestId("first-run-chat-backdrop")).not.toBeInTheDocument();
  });

  it("preserves a draft-backed new-chat revisit when the active workspace falls back to null", async () => {
    conversationStoreMock.state.activeConversationId = "conv-123";
    conversationStoreMock.state.conversations = [{ id: "conv-123" }];
    conversationStoreMock.state.loadConversationMessages.mockResolvedValueOnce([
      {
        id: "message-1",
        role: "user",
        content: "Recovered local thread",
      },
    ]);

    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(conversationStoreMock.state.loadConversationMessages).toHaveBeenCalledWith(
        "conv-123",
      );
    });

    localStorage.setItem("eco-composer-draft", "Return to my unsent draft");
    conversationStoreMock.state.activeConversationId = null;

    rerender(<ChatPage />);

    await waitFor(() => {
      expect(chatStoreMock.state.restorePersistedComposerDraft).toHaveBeenCalled();
    });

    expect(chatStoreMock.state.composerDraft).toBe("Return to my unsent draft");
    expect(localStorage.getItem("eco-composer-draft")).toBe("Return to my unsent draft");
  });

  it("loads the restored active conversation on first render", async () => {
    conversationStoreMock.state.activeConversationId = "conv-123";
    conversationStoreMock.state.conversations = [{ id: "conv-123" }];
    conversationStoreMock.state.loadConversationMessages.mockResolvedValueOnce([
      {
        id: "message-1",
        role: "user",
        content: "Recovered local thread",
      },
    ]);

    render(<ChatPage />);

    await waitFor(() => {
      expect(conversationStoreMock.state.loadConversationMessages).toHaveBeenCalledWith(
        "conv-123",
      );
    });

    expect(chatStoreMock.state.setMessages).toHaveBeenCalledWith([
      {
        id: "message-1",
        role: "user",
        content: "Recovered local thread",
      },
    ]);
  });

  it("ignores out-of-order conversation loads after a rapid switch", async () => {
    const loadB = createDeferred<
      Array<{ id: string; role: "user" | "assistant"; content: string }>
    >();
    const loadC = createDeferred<
      Array<{ id: string; role: "user" | "assistant"; content: string }>
    >();

    conversationStoreMock.state.conversations = [{ id: "conv-b" }, { id: "conv-c" }];
    conversationStoreMock.state.activeConversationId = "conv-b";
    conversationStoreMock.state.loadConversationMessages.mockImplementation(async (id) => {
      if (id === "conv-b") {
        return loadB.promise;
      }
      if (id === "conv-c") {
        return loadC.promise;
      }
      return [];
    });

    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(conversationStoreMock.state.loadConversationMessages).toHaveBeenCalledWith(
        "conv-b",
      );
    });

    conversationStoreMock.state.activeConversationId = "conv-c";
    rerender(<ChatPage />);

    await waitFor(() => {
      expect(conversationStoreMock.state.loadConversationMessages).toHaveBeenCalledWith(
        "conv-c",
      );
    });

    chatStoreMock.state.setMessages.mockClear();

    loadB.resolve([
      {
        id: "message-b",
        role: "user",
        content: "Thread B",
      },
    ]);
    await Promise.resolve();

    expect(chatStoreMock.state.setMessages).not.toHaveBeenCalledWith([
      {
        id: "message-b",
        role: "user",
        content: "Thread B",
      },
    ]);

    loadC.resolve([
      {
        id: "message-c",
        role: "user",
        content: "Thread C",
      },
    ]);

    await waitFor(() => {
      expect(chatStoreMock.state.setMessages).toHaveBeenCalledWith([
        {
          id: "message-c",
          role: "user",
          content: "Thread C",
        },
      ]);
    });
  });

  it("interrupts an active stream before switching to another conversation", async () => {
    conversationStoreMock.state.activeConversationId = "conv-123";
    conversationStoreMock.state.conversations = [{ id: "conv-123" }, { id: "conv-456" }];
    chatStoreMock.state.messages = [
      {
        id: "user-1",
        role: "user",
        content: "Keep this thread safe",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Partial reply",
      },
    ];

    const { rerender } = render(<ChatPage />);

    chatHookState.isStreaming = true;
    chatStoreMock.hook.setState({ isStreaming: true });
    conversationStoreMock.state.activeConversationId = "conv-456";
    conversationStoreMock.state.loadConversationMessages.mockResolvedValueOnce([
      {
        id: "message-2",
        role: "user",
        content: "Other thread",
      },
    ]);

    rerender(<ChatPage />);

    await waitFor(() => {
      expect(chatHookState.interruptActiveGeneration).toHaveBeenCalledTimes(1);
      expect(conversationStoreMock.state.loadConversationMessages).toHaveBeenCalledWith(
        "conv-456",
      );
    });
  });

  it("does not persist the previously rendered thread into an intermediate conversation during a rapid switch", async () => {
    const loadB = createDeferred<
      Array<{ id: string; role: "user" | "assistant"; content: string }>
    >();

    conversationStoreMock.state.activeConversationId = "conv-a";
    conversationStoreMock.state.conversations = [
      { id: "conv-a" },
      { id: "conv-b" },
      { id: "conv-c" },
    ];
    conversationStoreMock.state.loadConversationMessages.mockImplementation(async (id) => {
      if (id === "conv-a") {
        return [
          {
            id: "message-a",
            role: "user",
            content: "Thread A",
          },
        ];
      }
      if (id === "conv-b") {
        return loadB.promise;
      }
      return [
        {
          id: "message-c",
          role: "user",
          content: "Thread C",
        },
      ];
    });

    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(chatStoreMock.state.setMessages).toHaveBeenCalledWith([
        {
          id: "message-a",
          role: "user",
          content: "Thread A",
        },
      ]);
    });

    conversationStoreMock.state.activeConversationId = "conv-b";
    rerender(<ChatPage />);

    await waitFor(() => {
      expect(conversationStoreMock.state.loadConversationMessages).toHaveBeenCalledWith(
        "conv-b",
      );
    });

    conversationStoreMock.state.saveMessage.mockClear();
    conversationStoreMock.state.updateConversation.mockClear();

    conversationStoreMock.state.activeConversationId = "conv-c";
    rerender(<ChatPage />);

    await waitFor(() => {
      expect(conversationStoreMock.state.loadConversationMessages).toHaveBeenCalledWith(
        "conv-c",
      );
    });

    expect(conversationStoreMock.state.saveMessage).not.toHaveBeenCalled();
    expect(conversationStoreMock.state.updateConversation).not.toHaveBeenCalled();
  });

  it("keeps the prompt pending until auto-submit creates a new user message", async () => {
    navigationState.searchParams = new URLSearchParams({
      prompt: "Keep this local",
    });
    window.history.replaceState({}, "", "/chat?prompt=Keep+this+local");
    chatHookState.sendMessage.mockImplementation(() => {});

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");
    const { rerender } = render(<ChatPage />);

    await waitFor(() => {
      expect(chatHookState.sendMessage).toHaveBeenCalledWith("Keep this local");
    });

    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBe(
      "Keep this local",
    );

    mockSendMessageAddsMessages();
    chatHookState.isStreaming = true;
    rerender(<ChatPage />);
    chatHookState.isStreaming = false;
    rerender(<ChatPage />);

    await waitFor(() => {
      expect(chatHookState.sendMessage).toHaveBeenCalledTimes(2);
    });

    expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/chat");
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBeNull();
  });
});
