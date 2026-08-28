// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Spec contract test 3 — useChat-level demotion notice.
 *
 * Asserts:
 *   - generation on a demoted slot → assistant message carries `demotionNotice`
 *     with both user-facing display labels (no raw ids, no vendor parenthetical)
 *   - the same message carries `resolvedModel` = the actually-serving model id
 *   - a SECOND reply in the same conversation gets NO new notice
 *   - a reply after the original model is restored and re-demoted gets a fresh notice
 *
 * Follows the useChat.evicted-model-presence.test.tsx mock pattern: scripted
 * stream shim, controllable slot state, real catalog for display lookup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { DemotedFrom } from "../../local-ai/lifecycle/slots";
import type { Slot } from "../../local-ai/types";

type GenerateCall = { modelId: string };

const shared = vi.hoisted(() => {
  const FAST_1_2B = "candidate/lfm2.5-1.2b-instruct-onnx";
  const FAST_350M = "candidate/lfm2.5-350m-onnx";

  return {
    FAST_1_2B,
    FAST_350M,
    generateCalls: [] as GenerateCall[],
    fastSlotState: undefined as SlotState | undefined,
    smartSlotState: undefined as SlotState | undefined,
    demotedFromValue: undefined as DemotedFrom | undefined,
    activeModelId: null as string | null,
  };
});

// ─── Scripted-stream shim ──────────────────────────────────────────────────

vi.mock("../../local-ai/adapters/useChatLegacyShim", () => ({
  createLocalAiLegacyInference: () => ({
    generate: (
      _messages: Array<{ role: string; content: string }>,
      modelId: string,
    ): ReadableStream<string> => {
      shared.generateCalls.push({ modelId });
      return new ReadableStream<string>({
        start(controller) {
          controller.enqueue("ok");
          controller.close();
        },
      });
    },
  }),
}));

vi.mock("../../local-ai/lifecycle/slots", () => ({
  SLOTS: ["eco-fast", "eco-smart"] as ReadonlyArray<Slot>,
  getSlot: (slot: Slot): SlotState =>
    slot === "eco-fast" ? shared.fastSlotState! : shared.smartSlotState!,
  getSlotForModel: (modelId: string): Slot | null => {
    if (shared.fastSlotState?.modelId === modelId) return "eco-fast" as Slot;
    if (shared.smartSlotState?.modelId === modelId) return "eco-smart" as Slot;
    return null;
  },
  hasReadySlot: () =>
    shared.fastSlotState?.status === "ready" || shared.smartSlotState?.status === "ready",
  getDemotedFrom: (_slot: Slot): DemotedFrom | undefined => shared.demotedFromValue,
  setSlotStorage: () => {},
  setSlot: () => {},
  setSlotStatus: () => {},
  subscribe: () => () => {},
}));

vi.mock("../../local-ai/lifecycle/self-heal", () => ({
  reconcileReadySlots: async () => {},
}));

vi.mock("../../local-ai/bootstrap", () => ({
  resolveReconcileFilePlan: async () => null,
}));

vi.mock("../../local-ai/runtime/lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../local-ai/runtime/lifecycle")>();
  return {
    ...actual,
    getActiveModel: () =>
      shared.activeModelId
        ? ({ id: shared.activeModelId } as ReturnType<typeof actual.getActiveModel>)
        : null,
  };
});

vi.mock("../../local-ai/runtime/usage-store", () => ({
  getLastUsage: () => null,
  getLastTemplateName: () => null,
  setLastUsage: () => {},
  setLastTemplateName: () => {},
  ranToCapFromUsage: () => false,
}));

vi.mock("../../local-ai/lifecycle/generation-receipt", () => ({
  recordGenerationReceipt: () => {},
  recordGenerationReceiptAsync: () => {},
  hashSystemPrompt: async () => "deadbeef",
}));

// Imports AFTER mocks.
import { useChat } from "../useChat";
import { useChatStore } from "../../stores/chatStore";
import { getModel } from "../../local-ai/catalog/catalog";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeSlot(slot: Slot, modelId: string | null, status: SlotState["status"]): SlotState {
  return {
    slot,
    modelId,
    model: modelId ? getModel(modelId) : null,
    status,
  };
}

function resetChatStore(selectedModel: string): void {
  useChatStore.setState({
    messages: [],
    composerDraft: "",
    streamPhase: "idle",
    isStreaming: false,
    error: null,
    selectedModel,
    fileAttachments: [],
    approvedTools: [],
    activeToolCalls: [],
    localToolNoticeShown: false,
    routeRecommendationSnapshot: null,
  });
}

async function send(): Promise<void> {
  const { result } = renderHook(() => useChat());
  await act(async () => {
    await result.current.sendMessage("hello");
  });
}

function lastAssistant() {
  return [...useChatStore.getState().messages].reverse().find((m) => m.role === "assistant");
}

function assistantMessages() {
  return useChatStore.getState().messages.filter((m) => m.role === "assistant");
}

beforeEach(() => {
  shared.generateCalls.length = 0;
  shared.fastSlotState = makeSlot("eco-fast", shared.FAST_350M, "ready");
  shared.smartSlotState = makeSlot("eco-smart", null, "empty");
  shared.demotedFromValue = undefined;
  shared.activeModelId = null;
  localStorage.clear();
  resetChatStore(shared.FAST_350M);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("demotion notice on a demoted slot", () => {
  it("stamps the assistant message with demotionNotice carrying display labels and resolvedModel", async () => {
    shared.demotedFromValue = { modelId: shared.FAST_1_2B, at: 1000 };

    await send();

    const assistant = lastAssistant();
    expect(assistant).toBeDefined();
    expect(assistant?.demotionNotice).toBeDefined();
    expect(assistant?.demotionNotice?.fromLabel).toBe("Eco Fast");
    expect(assistant?.demotionNotice?.toLabel).toBe("Eco Light");
    expect(assistant?.demotionNotice?.demotedAt).toBe(1000);
    expect(assistant?.resolvedModel).toBe(shared.FAST_350M);
  });

  it("does not include raw model ids or vendor parentheticals in the labels", async () => {
    shared.demotedFromValue = { modelId: shared.FAST_1_2B, at: 1000 };

    await send();

    const notice = lastAssistant()?.demotionNotice;
    expect(notice?.fromLabel).not.toContain("candidate/");
    expect(notice?.fromLabel).not.toContain("(Liquid)");
    expect(notice?.toLabel).not.toContain("candidate/");
    expect(notice?.toLabel).not.toContain("(Liquid)");
  });

  it("a SECOND reply in the same conversation gets NO new notice", async () => {
    shared.demotedFromValue = { modelId: shared.FAST_1_2B, at: 1000 };

    await send();
    await send();

    const assistants = assistantMessages();
    const withNotice = assistants.filter((m) => m.demotionNotice !== undefined);
    expect(withNotice).toHaveLength(1);
  });

  it("a reply after re-demotion (new timestamp) gets a fresh notice", async () => {
    shared.demotedFromValue = { modelId: shared.FAST_1_2B, at: 1000 };
    await send();

    shared.demotedFromValue = { modelId: shared.FAST_1_2B, at: 2000 };
    await send();

    const assistants = assistantMessages();
    const withNotice = assistants.filter((m) => m.demotionNotice !== undefined);
    expect(withNotice).toHaveLength(2);
    expect(withNotice[0]?.demotionNotice?.demotedAt).toBe(1000);
    expect(withNotice[1]?.demotionNotice?.demotedAt).toBe(2000);
  });

  it("no notice when demotedFrom is not set", async () => {
    shared.demotedFromValue = undefined;

    await send();

    expect(lastAssistant()?.demotionNotice).toBeUndefined();
  });
});
