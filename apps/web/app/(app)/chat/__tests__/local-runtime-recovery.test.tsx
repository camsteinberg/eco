// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The local-AI gate now runs unconditionally (PR-A-11 deleted the runtime
// feature flag). LocalAiSetupGate is mocked as a passthrough below so the
// chat tree still renders end-to-end in this suite.
vi.mock("../../../../src/components/local-ai/LocalAiSetupGate", () => ({
  LocalAiSetupGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const navigationState = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

const originalValidationHarness = process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS;

const chatHookState = vi.hoisted(() => ({
  messages: [
    { id: "user-1", role: "user" as const, content: "Keep this local" },
    { id: "assistant-1", role: "assistant" as const, content: "" },
  ],
  isStreaming: false,
  error: null as string | null,
  continueLatestTurnLocally: vi.fn(),
  retryMessage: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  regenerateMessage: vi.fn(),
  stopGeneration: vi.fn(),
}));

const chatStoreMock = vi.hoisted(() => {
  const state = {
    messages: chatHookState.messages,
    composerDraft: "",
    selectedModel: "local/qwen3-0.6b",
    localToolNoticeShown: false,
    setError: vi.fn(),
    setComposerDraft: vi.fn(),
    restorePersistedComposerDraft: vi.fn(),
    clearComposerDraft: vi.fn(),
    clearMessages: vi.fn(),
    setMessages: vi.fn(),
    setSelectedModel: vi.fn(),
  };

  const hook = ((selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state) as typeof state & {
    (selector?: (value: typeof state) => unknown): unknown;
    getState: () => typeof state;
  };

  hook.getState = () => state;
  return { state, hook };
});

const conversationStoreMock = vi.hoisted(() => {
  const state = {
    hasHydrated: true,
    activeConversationId: null as string | null,
    setActive: vi.fn(),
    restorePersistedActiveConversation: vi.fn(),
    conversations: [] as Array<{ id: string }>,
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

const onboardingStoreMock = vi.hoisted(() => ({
  hook: (selector?: (value: { hasCompletedOnboarding: true }) => unknown) =>
    selector ? selector({ hasCompletedOnboarding: true }) : { hasCompletedOnboarding: true },
}));

const slotsMock = vi.hoisted(() => ({
  slot: "eco-fast" as string,
  modelId: "local/qwen3-0.6b" as string | null,
  model: { id: "local/qwen3-0.6b" } as { id: string } | null,
  status: "ready" as "empty" | "preparing" | "ready" | "error",
}));

const smokeMock = vi.hoisted(() => ({
  runSmoke: vi.fn(async () => ({ passed: false, reason: "mock" })),
}));

const recoveryMock = vi.hoisted(() => ({
  resolveReadyLocalRecoveryModelId: vi.fn(async () => null as string | null),
  getLocalRecoveryCandidateIds: vi.fn(() => [] as readonly string[]),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigationState.searchParams,
}));

vi.mock("../../../../src/local-ai/lifecycle/recovery", () => recoveryMock);

vi.mock("../../../../src/hooks/useChat", () => ({
  useChat: () => ({
    messages: chatHookState.messages,
    isStreaming: chatHookState.isStreaming,
    streamPhase: chatHookState.isStreaming ? "queued" : "idle",
    error: chatHookState.error,
    sendMessage: chatHookState.sendMessage,
    editMessage: chatHookState.editMessage,
    regenerateMessage: chatHookState.regenerateMessage,
    retryMessage: chatHookState.retryMessage,
    continueLatestTurnLocally: chatHookState.continueLatestTurnLocally,
    contextDividerIndex: null,
    activeToolCalls: [],
    stopGeneration: chatHookState.stopGeneration,
  }),
}));

vi.mock("../../../../src/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
  LocalInferenceErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../../../../src/stores/chatStore", () => ({
  useChatStore: chatStoreMock.hook,
}));

vi.mock("../../../../src/stores/conversationStore", () => ({
  useConversationStore: conversationStoreMock.hook,
}));

vi.mock("../../../../src/stores/settingsStore", () => ({
  useSettingsStore: settingsStoreMock.hook,
}));

vi.mock("../../../../src/stores/onboardingStore", () => ({
  useOnboardingStore: onboardingStoreMock.hook,
}));

vi.mock("../../../../src/hooks/useBatteryAwareness", () => ({
  useBatteryAwareness: () => ({ level: null, charging: null, restriction: "none", preferredModel: "full" }),
  computeRestriction: () => "none",
}));

vi.mock("../../../../src/local-ai/lifecycle/slots", () => ({
  SLOTS: ["eco-fast", "eco-smart"],
  getSlot: () => ({ slot: slotsMock.slot, modelId: slotsMock.modelId, model: slotsMock.model, status: slotsMock.status }),
  getSlotForModel: () => null,
  hasReadySlot: () => false,
  subscribe: () => () => {},
  // Required by lifecycle/switch-model's default seams, which the slice-2b
  // upgrade chain (ChatWorkspace → useModelUpgrade → upgrade.ts) now pulls in.
  setSlot: vi.fn(),
  setSlotStatus: vi.fn(),
}));

vi.mock("../../../../src/local-ai/lifecycle/smoke", () => smokeMock);

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
  isLocalModel: (id: string) => id.startsWith("local/"),
  getFullModel: vi.fn(),
  getLocalModel: (id: string) => (
    id === "local/qwen3-0.6b"
      ? {
          id: "local/qwen3-0.6b",
          hfId: "Qwen/Qwen3-0.6B",
          quantization: "q4f16",
          sizeBytes: 522_000_000,
          shardCount: 1,
          runtime: "transformers",
        }
      : null
  ),
  getDownloadableModels: () => [{ id: "local/qwen3-0.6b" }],
  DEFAULT_LOCAL_MODEL: { id: "local/qwen3-0.6b" },
}));

vi.mock("../../../../src/lib/local-model-routing", () => ({
  getLocalDeviceProfileSnapshot: () => ({
    capability: "webgpu",
    deviceMemoryGB: 8,
    hardwareConcurrency: 8,
    storageQuotaBytes: null,
    storageUsageBytes: null,
    platformClass: "desktop",
    browserClass: "chromium",
    browserVersion: "120",
    gpuMaxBufferSizeBytes: null,
    opfsAvailable: true,
    dataSaverEnabled: null,
    effectiveConnectionType: null,
    meteredConnection: null,
  }),
  getLocalModelProductState: (modelId: string) =>
    modelId === "local/qwen3-0.6b" ? "manual-eligible" : "hidden",
  isLocalModelDefaultEligible: () => false,
  resolveLocalModelSelection: (selection: string) => selection,
}));

vi.mock("../../../../src/lib/local-benchmark-manual-evidence", () => ({
  isPersistedLocalBenchmarkManualEligibleModel: (modelId: string) => modelId === "local/qwen3-0.6b",
}));

vi.mock("../../../../src/lib/local-model-state-matrix", () => ({
  getLocalModelStateMatrixRow: (modelId: string) => ({
    modelId,
    productState: modelId === "local/qwen3-0.6b" ? "manual-eligible" : "hidden",
    eligibilityProof: {
      default: { eligible: false },
    },
  }),
}));

vi.mock("../../../../src/lib/guest-local-context", () => ({
  consumeGuestLocalContext: () => null,
}));

vi.mock("../../../../src/lib/pending-chat-prompt", () => ({
  clearPendingChatPrompt: vi.fn(),
  normalizePendingChatPrompt: (value: string | null) => value?.trim() ?? null,
  readPendingChatPrompt: () => null,
  rememberPendingChatPrompt: vi.fn(),
}));

import ChatPage from "../page";

describe("ChatPage local runtime recovery actions", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS = "true";
    chatHookState.isStreaming = false;
    chatHookState.error = null;
    chatHookState.continueLatestTurnLocally.mockReset();
    chatStoreMock.state.selectedModel = "local/qwen3-0.6b";
    chatStoreMock.state.setSelectedModel.mockReset();
    chatStoreMock.state.setError.mockReset();
    slotsMock.modelId = "local/qwen3-0.6b";
    slotsMock.model = { id: "local/qwen3-0.6b" };
    slotsMock.status = "ready";
    smokeMock.runSmoke.mockReset();
    smokeMock.runSmoke.mockResolvedValue({ passed: false, reason: "mock" });
    recoveryMock.resolveReadyLocalRecoveryModelId.mockReset();
    recoveryMock.resolveReadyLocalRecoveryModelId.mockResolvedValue(null);
    recoveryMock.getLocalRecoveryCandidateIds.mockReset();
    recoveryMock.getLocalRecoveryCandidateIds.mockReturnValue([]);
    localStorage.clear();
    navigationState.searchParams = new URLSearchParams();
    window.history.replaceState({}, "", "/chat");
  });

  afterEach(() => {
    if (originalValidationHarness === undefined) {
      delete process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS;
    } else {
      process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS = originalValidationHarness;
    }
    window.history.replaceState({}, "", "/chat");
  });

  it("does not prewarm a downloaded local recovery model before user intent", async () => {
    chatStoreMock.state.selectedModel = "auto";
    slotsMock.modelId = null;
    slotsMock.model = null;
    slotsMock.status = "empty";
    recoveryMock.resolveReadyLocalRecoveryModelId.mockResolvedValue("local/qwen3-0.6b");

    render(<ChatPage />);

    await waitFor(() => {
      expect(recoveryMock.resolveReadyLocalRecoveryModelId).toHaveBeenCalled();
    });

    expect(smokeMock.runSmoke).not.toHaveBeenCalled();
  });

  it("shows the on-device crash recovery error with no network CTA", () => {
    chatHookState.error =
      "On-device AI needed a moment. Try again on this device to pick up where you left off.";

    render(<ChatPage />);

    expect(
      screen.getByText(/try again on this device to pick up where you left off/i),
    ).toBeInTheDocument();
    // v1.0 is on-device only: there is no "use Eco Network" escape hatch.
    expect(screen.queryByText(/eco network/i)).not.toBeInTheDocument();
    expect(chatStoreMock.state.setSelectedModel).not.toHaveBeenCalled();
  });

  it("shows the mission-owned battery protection pause banner when forced", () => {
    window.history.replaceState({}, "", "/chat?eco-force-protection=battery-disabled");

    render(<ChatPage />);

    expect(screen.getByText("Battery protection pause")).toBeInTheDocument();
    expect(
      screen.getByText(/plug in, then try again to keep chatting locally/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/eco network/i)).not.toBeInTheDocument();
  });

  it("shows the mission-owned thermal degradation banner when forced", () => {
    window.history.replaceState({}, "", "/chat?eco-force-protection=thermal");

    render(<ChatPage />);

    expect(screen.getByText("Keeping this device cool")).toBeInTheDocument();
    expect(screen.getByText(/using a steadier local mode/i)).toBeInTheDocument();
  });

  it("shows the mission-owned protection banner before the first message", () => {
    chatHookState.messages = [];
    window.history.replaceState({}, "", "/chat?eco-force-protection=thermal");

    render(<ChatPage />);

    expect(screen.getByText("Keeping this device cool")).toBeInTheDocument();
    expect(screen.getByText(/using a steadier local mode/i)).toBeInTheDocument();
  });
});
