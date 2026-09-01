// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The unbound-selection invariant: a concrete on-device model id that NO slot
 * owns must never reach generation.
 *
 * Before this net, dispatch resolution defaulted such an id's readiness check to
 * the eco-fast slot — that slot was ready, the guard passed, and the UNBOUND id
 * was handed to the runtime, which then self-fetched gigabytes mid-turn with no
 * progress and no consent, while Settings kept reporting the first bound slot.
 *
 * These tests assert what actually reaches the inference shim (`modelId`) and
 * what the store's selection is afterwards, so they fail on the real symptom
 * rather than on an internal call shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { Slot } from "../../local-ai/types";
import type { TokenStream } from "../../local-ai/runtime/stream";
import { scriptedTokenStream } from "../../__tests__/helpers/token-stream";

// ─── Scripted-stream shim seam (mirrors the recovery-seam net) ─────────────

type GenerateCall = { modelId: string };

const shared = vi.hoisted(() => {
  // Real catalog ids: the bug is a person picking a genuine model from the
  // composer that no slot has downloaded, not a corrupt id.
  const FAST_MODEL_ID = "candidate/lfm2.5-1.2b-instruct-onnx";
  const SMART_MODEL_ID = "candidate/lfm2-2.6b-onnx";
  const UNBOUND_MODEL_ID = "local/qwen3-0.6b";

  function makeSlot(slot: Slot, modelId: string | null, status: SlotState["status"]): SlotState {
    return {
      slot,
      modelId,
      model: modelId
        ? ({ id: modelId, friendlyName: `Test ${modelId}` } as unknown as SlotState["model"])
        : null,
      status,
    };
  }

  return {
    FAST_MODEL_ID,
    SMART_MODEL_ID,
    UNBOUND_MODEL_ID,
    makeSlot,
    generateCalls: [] as GenerateCall[],
    fastSlotState: undefined as SlotState | undefined,
    smartSlotState: undefined as SlotState | undefined,
    /**
     * Simulates the binding going away UNDER the send: normalization sees the
     * id bound, and the pre-dispatch lookup a moment later finds no owner
     * (another tab cleared the slot, a removal landed mid-send).
     */
    bindingVanishes: false,
  };
});

const { FAST_MODEL_ID, SMART_MODEL_ID, UNBOUND_MODEL_ID, makeSlot } = shared;

vi.mock("../../local-ai/runtime/stream", () => ({
  stream: (
    _messages: Array<{ role: string; content: string }>,
    modelId: string,
  ): TokenStream => {
    shared.generateCalls.push({ modelId });
    return scriptedTokenStream({ tokens: ["ok"] });
  },
}));

vi.mock("../../local-ai/lifecycle/slots", () => ({
  SLOTS: ["eco-fast", "eco-smart"] as ReadonlyArray<Slot>,
  getSlot: (slot: Slot): SlotState =>
    slot === "eco-fast" ? shared.fastSlotState! : shared.smartSlotState!,
  getSlotForModel: (modelId: string): Slot | null => {
    if (shared.bindingVanishes) return null;
    if (shared.fastSlotState?.modelId === modelId) return "eco-fast" as Slot;
    if (shared.smartSlotState?.modelId === modelId) return "eco-smart" as Slot;
    return null;
  },
  hasReadySlot: () =>
    shared.fastSlotState?.status === "ready" || shared.smartSlotState?.status === "ready",
  setSlotStorage: () => {},
  setSlot: () => {},
  setSlotStatus: () => {},
  subscribe: () => () => {},
  getDemotedFrom: () => undefined,
}));

vi.mock("../../local-ai/lifecycle/generation-receipt", () => ({
  recordGenerationReceipt: () => {},
  recordGenerationReceiptAsync: () => {},
  hashSystemPrompt: async () => "deadbeef",
}));

// Imports AFTER the mocks so the hook picks up the mocked seams.
import { useChat, normalizeUnboundModelSelection } from "../useChat";
import {
  useChatStore,
  SELECTED_MODEL_STORAGE_KEY,
  SELECTED_MODEL_EXPLICIT_STORAGE_KEY,
} from "../../stores/chatStore";
import { getCatalog } from "../../local-ai/catalog/catalog";

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function dispatchedModelIds(): string[] {
  return shared.generateCalls.map((call) => call.modelId);
}

function lastAssistant() {
  return [...useChatStore.getState().messages].reverse().find((m) => m.role === "assistant");
}

beforeEach(() => {
  shared.generateCalls.length = 0;
  shared.fastSlotState = makeSlot("eco-fast", FAST_MODEL_ID, "ready");
  shared.smartSlotState = makeSlot("eco-smart", null, "empty");
  shared.bindingVanishes = false;
  localStorage.clear();
  resetChatStore("auto");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the fixture measures something real", () => {
  it("uses ids that exist in the shipping catalog", () => {
    const ids = new Set(getCatalog().map((m) => m.id));
    expect(ids.has(FAST_MODEL_ID)).toBe(true);
    expect(ids.has(UNBOUND_MODEL_ID)).toBe(true);
  });
});

describe("unbound concrete selection never reaches generation", () => {
  it("serves the eco-fast slot's BOUND model, never the unbound id", async () => {
    resetChatStore(UNBOUND_MODEL_ID);

    await send();

    expect(dispatchedModelIds()).toEqual([FAST_MODEL_ID]);
    expect(dispatchedModelIds()).not.toContain(UNBOUND_MODEL_ID);
    expect(lastAssistant()?.status).not.toBe("error");
  });

  it("normalizes the persisted selection to 'auto' and clears the explicit pick", async () => {
    resetChatStore(UNBOUND_MODEL_ID);
    localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, UNBOUND_MODEL_ID);
    localStorage.setItem(SELECTED_MODEL_EXPLICIT_STORAGE_KEY, "true");

    await send();

    expect(useChatStore.getState().selectedModel).toBe("auto");
    expect(localStorage.getItem(SELECTED_MODEL_STORAGE_KEY)).toBe("auto");
    expect(localStorage.getItem(SELECTED_MODEL_EXPLICIT_STORAGE_KEY)).toBe("false");
  });

  // Quiet normalization is the chosen UX: the person never chose this state, so
  // there is no error card to answer — the turn just runs on a real model.
  it("does not surface a mid-turn error card", async () => {
    resetChatStore(UNBOUND_MODEL_ID);

    await send();

    expect(useChatStore.getState().error).toBeNull();
    expect(lastAssistant()?.localReadiness).toBeUndefined();
  });
});

// The pre-dispatch slot lookup used to end in `: "eco-fast"`. That arm is
// unreachable while normalization holds, but it was never a safe default: it
// approved an unowned model on a DIFFERENT model's readiness verdict. A lookup
// that finds no owner now declines out loud instead of guessing.
describe("a binding that vanishes mid-send declines rather than guessing", () => {
  it("dispatches nothing and says so", async () => {
    shared.smartSlotState = makeSlot("eco-smart", SMART_MODEL_ID, "ready");
    resetChatStore(SMART_MODEL_ID);
    shared.bindingVanishes = true;

    await send();

    expect(dispatchedModelIds()).toEqual([]);
    const assistant = lastAssistant();
    expect(assistant?.status).toBe("error");
    expect(assistant?.errorMessage).toMatch(/isn't set up on this device any more/i);
    // Never silently served by whatever eco-fast happened to hold.
    expect(dispatchedModelIds()).not.toContain(FAST_MODEL_ID);
  });
});

describe("bound and slot-shaped selections are untouched", () => {
  it("leaves a slot-BOUND concrete id alone (eco-smart case)", async () => {
    shared.smartSlotState = makeSlot("eco-smart", SMART_MODEL_ID, "ready");
    resetChatStore(SMART_MODEL_ID);

    await send();

    expect(dispatchedModelIds()).toEqual([SMART_MODEL_ID]);
    expect(useChatStore.getState().selectedModel).toBe(SMART_MODEL_ID);
  });

  it("leaves 'auto' alone", async () => {
    resetChatStore("auto");

    await send();

    expect(dispatchedModelIds()).toEqual([FAST_MODEL_ID]);
    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("leaves a slot-name selection alone", async () => {
    resetChatStore("eco-fast");

    await send();

    expect(dispatchedModelIds()).toEqual([FAST_MODEL_ID]);
    expect(useChatStore.getState().selectedModel).toBe("eco-fast");
  });

  // A stale cloud selection keeps its own explicit decline rather than being
  // quietly swallowed into 'auto'.
  it("leaves a non-on-device id alone so the cloud decline still fires", async () => {
    resetChatStore("gpt-4o");

    await send();

    expect(dispatchedModelIds()).toEqual([]);
    expect(useChatStore.getState().selectedModel).toBe("gpt-4o");
    expect(lastAssistant()?.errorMessage).toMatch(/runs in the cloud/i);
  });
});

describe("normalizeUnboundModelSelection", () => {
  it("rewrites only the unbound on-device id", () => {
    shared.smartSlotState = makeSlot("eco-smart", SMART_MODEL_ID, "ready");

    expect(normalizeUnboundModelSelection(UNBOUND_MODEL_ID)).toBe("auto");
    expect(normalizeUnboundModelSelection(FAST_MODEL_ID)).toBe(FAST_MODEL_ID);
    expect(normalizeUnboundModelSelection(SMART_MODEL_ID)).toBe(SMART_MODEL_ID);
    expect(normalizeUnboundModelSelection("auto")).toBe("auto");
    expect(normalizeUnboundModelSelection("eco-fast")).toBe("eco-fast");
    expect(normalizeUnboundModelSelection("eco-smart")).toBe("eco-smart");
    expect(normalizeUnboundModelSelection("gpt-4o")).toBe("gpt-4o");
  });

  // Status is deliberately NOT part of this check: a PREPARING slot still owns
  // its model, and the existing readiness guards are what refuse it. Widening
  // this to "ready-only" would turn every mid-download turn into an 'auto'
  // rewrite and lose the user's pick.
  it("keeps a bound id whose slot is still preparing", () => {
    shared.fastSlotState = makeSlot("eco-fast", FAST_MODEL_ID, "preparing");

    expect(normalizeUnboundModelSelection(FAST_MODEL_ID)).toBe(FAST_MODEL_ID);
  });
});
