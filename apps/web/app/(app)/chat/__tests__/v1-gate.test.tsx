// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Verifies the chat page always wraps in <LocalAiSetupGate>. The legacy
 * runtime feature flag was deleted in PR-A-11; the gate now runs
 * unconditionally and ChatWorkspace renders through it.
 */

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedState = vi.hoisted(() => ({
  hasCompletedOnboarding: false,
  hasHydrated: true,
  activeConversationId: null as string | null,
  conversations: [] as Array<{ id: string }>,
  searchParams: new URLSearchParams(),
}));

/* ── Navigation ───────────────────────────────────────────────────── */

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockedState.searchParams,
}));

/* ── Gate (passthrough mock) ──────────────────────────────────────── */

vi.mock("../../../../src/components/local-ai/LocalAiSetupGate", () => ({
  LocalAiSetupGate: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="local-ai-setup-gate">{children}</div>
  ),
}));

/* ── Stores ────────────────────────────────────────────────────────── */

vi.mock("../../../../src/stores/onboardingStore", () => ({
  useOnboardingStore: (
    selector?: (state: { hasCompletedOnboarding: boolean }) => unknown,
  ) => {
    const state = { hasCompletedOnboarding: mockedState.hasCompletedOnboarding };
    return selector ? selector(state) : state;
  },
}));

const conversationStoreState = vi.hoisted(() => {
  const state = {
    hasHydrated: true,
    activeConversationId: null as string | null,
    conversations: [] as Array<{ id: string }>,
    setActive: vi.fn(),
    restorePersistedActiveConversation: vi.fn(),
    addConversation: vi.fn(),
    loadConversationMessages: vi.fn(async () => []),
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

vi.mock("../../../../src/stores/conversationStore", () => ({
  useConversationStore: conversationStoreState.hook,
}));

const chatStoreState = vi.hoisted(() => {
  const state = {
    messages: [] as Array<{ id: string; role: "user" | "assistant"; content: string }>,
    composerDraft: "",
    isStreaming: false,
    rateLimitInfo: null,
    privacyTier: "encrypted",
    selectedModel: "auto",
    localToolNoticeShown: false,
    setError: vi.fn(),
    setComposerDraft: vi.fn(),
    restorePersistedComposerDraft: vi.fn(),
    clearComposerDraft: vi.fn(),
    clearMessages: vi.fn(),
    setMessages: vi.fn(),
    setSelectedModel: vi.fn(),
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
  hook.setState = (updates) => { Object.assign(state, updates); };
  return { state, hook };
});

vi.mock("../../../../src/stores/chatStore", () => ({
  useChatStore: chatStoreState.hook,
}));

vi.mock("../../../../src/stores/settingsStore", () => {
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
  return { useSettingsStore: hook };
});

/* ── Hooks ─────────────────────────────────────────────────────────── */

vi.mock("../../../../src/hooks/useChat", () => ({
  useChat: () => ({
    messages: [],
    isStreaming: false,
    streamPhase: "idle",
    error: null,
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    regenerateMessage: vi.fn(),
    retryMessage: vi.fn(),
    continueLatestTurnLocally: vi.fn(),
    contextDividerIndex: null,
    activeToolCalls: [],
    stopGeneration: vi.fn(),
  }),
  interruptActiveGeneration: vi.fn(),
}));

vi.mock("../../../../src/hooks/useBatteryAwareness", () => ({
  useBatteryAwareness: () => ({ level: null, charging: null, restriction: "none", preferredModel: "full" }),
  computeRestriction: () => "none",
}));

/* ── Components (stubs) ───────────────────────────────────────────── */

vi.mock("../../../../src/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));
vi.mock("../../../../src/components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));
vi.mock("../../../../src/components/chat/ChatInput", () => ({
  ChatInput: () => <input aria-label="Message eco" />,
}));
vi.mock("../../../../src/components/chat/ImpactFooter", () => ({ ImpactFooter: () => null }));
vi.mock("../../../../src/components/impact/ImpactShareCardCanvas", () => ({ ImpactShareCardCanvas: () => null }));
vi.mock("../../../../src/components/chat/InConversationSearch", () => ({ InConversationSearch: () => null }));
vi.mock("../../../../src/components/onboarding/OnboardingTour", () => ({ OnboardingTour: () => null }));
vi.mock("../../../../src/components/onboarding/WhyEcoCard", () => ({ WhyEcoCard: () => null }));
vi.mock("../../../../src/components/chat/WaterCounter", () => ({ WaterCounter: () => null }));
vi.mock("../../../../src/components/chat/LocalInferenceErrorBoundary", () => ({
  LocalInferenceErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

/* ── Utilities / side-effect-free modules ─────────────────────────── */

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
  calculateImpact: () => ({ waterSavedLiters: 0 }),
}));
vi.mock("../../../../src/lib/local-models", () => ({
  isLocalModel: () => false,
  getFullModel: vi.fn(),
  getDownloadableModels: () => [{ id: "local/qwen3-0.6b" }],
  DEFAULT_LOCAL_MODEL: { id: "local/qwen3-0.6b" },
}));
vi.mock("../../../../src/lib/guest-local-context", () => ({
  consumeGuestLocalContext: () => null,
  readGuestLocalContext: () => null,
}));

import ChatPage from "../page";

describe("ChatPage — local-AI gate", () => {
  beforeEach(() => {
    mockedState.hasCompletedOnboarding = false;
    mockedState.hasHydrated = true;
    mockedState.activeConversationId = null;
    mockedState.conversations = [];
    mockedState.searchParams = new URLSearchParams();
    conversationStoreState.state.hasHydrated = true;
    conversationStoreState.state.activeConversationId = null;
    conversationStoreState.state.conversations = [];
    chatStoreState.state.messages = [];
    chatStoreState.state.isStreaming = false;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("always wraps in LocalAiSetupGate", async () => {
    render(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByTestId("local-ai-setup-gate")).toBeInTheDocument();
    });
  });

  it("renders ChatWorkspace through the gate when onboarding is incomplete", async () => {
    mockedState.hasCompletedOnboarding = false;
    render(<ChatPage />);

    await waitFor(() => {
      // FirstRunChatBackdrop was deleted; the gate now wraps ChatWorkspace
      // directly. WelcomeSetup vs ChatWorkspace decision lives inside the
      // real LocalAiSetupGate (mocked as a passthrough here).
      expect(screen.getByTestId("local-ai-setup-gate")).toBeInTheDocument();
    });
    // The old first-run-chat-backdrop no longer exists.
    expect(screen.queryByTestId("first-run-chat-backdrop")).not.toBeInTheDocument();
  });
});
