// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The evicted-cache presence invariant: a slot whose localStorage still reads
 * `status: "ready"` but whose weight BYTES were evicted (storage pressure,
 * Safari ITP, a manual clear) must never dispatch straight into the worker —
 * which would silently refetch gigabytes through the proxy with no progress and
 * no consent (`allowRemoteModels` fall-through).
 *
 * `reconcileSlotCachePresence` runs the SAME boot mechanism
 * (`reconcileReadySlots`) before the synchronous dispatch. On PROVEN absence it
 * demotes the slot to `preparing`; the existing not-ready branch then writes the
 * honest prepare-local-model card and holds the message for the readiness retry.
 * These tests assert what actually reaches the inference shim (`modelId`) and the
 * card the person sees — the real symptoms, not an internal call shape:
 *
 *   - ready + present   → dispatches the bound model normally.
 *   - ready but evicted → routes to the prepare-local-model card, dispatches
 *                         NOTHING (no silent refetch).
 *   - probe throws      → dispatches (fail-open — never block a legitimate send).
 *   - target resident   → the probe is skipped entirely (zero added latency).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { Slot } from "../../local-ai/types";
import type { TokenStream } from "../../local-ai/runtime/stream";
import { scriptedTokenStream } from "../../__tests__/helpers/token-stream";

type GenerateCall = { modelId: string };

const shared = vi.hoisted(() => {
  // Real catalog ids — the bug is a returning person whose genuine model's bytes
  // were evicted, not a corrupt id.
  const FAST_MODEL_ID = "candidate/lfm2.5-1.2b-instruct-onnx";
  const SMART_MODEL_ID = "candidate/lfm2-2.6b-onnx";

  return {
    FAST_MODEL_ID,
    SMART_MODEL_ID,
    generateCalls: [] as GenerateCall[],
    fastSlotState: undefined as SlotState | undefined,
    smartSlotState: undefined as SlotState | undefined,
    // Times `reconcileReadySlots` was invoked this test.
    reconcileCalls: 0,
    // Per-test behavior for the mocked reconcile: no-op (present), demote
    // (evicted), or throw (fail-open).
    reconcileImpl: (async () => {}) as () => Promise<void>,
    // What `getActiveModel()` reports resident. null ⇒ nothing loaded (cold).
    activeModelId: null as string | null,
  };
});

const { SMART_MODEL_ID } = shared;

// ─── Scripted-stream shim seam (mirrors the unbound-selection net) ─────────────

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
    if (shared.fastSlotState?.modelId === modelId) return "eco-fast" as Slot;
    if (shared.smartSlotState?.modelId === modelId) return "eco-smart" as Slot;
    return null;
  },
  hasReadySlot: () =>
    shared.fastSlotState?.status === "ready" || shared.smartSlotState?.status === "ready",
  getDemotedFrom: () => undefined,
  setSlotStorage: () => {},
  setSlot: () => {},
  setSlotStatus: () => {},
  subscribe: () => () => {},
}));

// The presence guard reaches these two seams via dynamic import; the mocks let a
// test drive the reconcile outcome (present / demote / throw) directly.
vi.mock("../../local-ai/lifecycle/self-heal", () => ({
  reconcileReadySlots: async () => {
    shared.reconcileCalls += 1;
    return shared.reconcileImpl();
  },
}));

vi.mock("../../local-ai/bootstrap", () => ({
  resolveReconcileFilePlan: async () => null,
}));

// getActiveModel drives the residency short-circuit; every other lifecycle
// export stays real so the full send path runs.
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

vi.mock("../../local-ai/lifecycle/generation-receipt", () => ({
  recordGenerationReceipt: () => {},
  recordGenerationReceiptAsync: () => {},
  hashSystemPrompt: async () => "deadbeef",
}));

// Imports AFTER the mocks so the hook picks up the mocked seams.
import { useChat, reconcileSlotCachePresence } from "../useChat";
import { useChatStore } from "../../stores/chatStore";
import { getModel } from "../../local-ai/catalog/catalog";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build a slot state whose `model` is the REAL catalog config, so the
 *  prepare-local-model card's display lookup (needs sizeGB/vendor) never throws. */
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

function dispatchedModelIds(): string[] {
  return shared.generateCalls.map((call) => call.modelId);
}

function lastAssistant() {
  return [...useChatStore.getState().messages].reverse().find((m) => m.role === "assistant");
}

beforeEach(() => {
  shared.generateCalls.length = 0;
  // eco-smart holds a genuine, "ready" model; eco-fast is empty. The person's
  // selection is that concrete model id (returning-user shape).
  shared.smartSlotState = makeSlot("eco-smart", SMART_MODEL_ID, "ready");
  shared.fastSlotState = makeSlot("eco-fast", null, "empty");
  shared.reconcileCalls = 0;
  shared.reconcileImpl = async () => {};
  shared.activeModelId = null;
  localStorage.clear();
  resetChatStore(SMART_MODEL_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the fixture measures something real", () => {
  it("uses a model id that exists in the shipping catalog", () => {
    expect(getModel(SMART_MODEL_ID)).not.toBeNull();
  });
});

describe("ready + present dispatches normally", () => {
  it("serves the bound model when the presence probe finds no eviction", async () => {
    // reconcile is a no-op (nothing demoted) — the healthy returning-user path.
    await send();

    expect(shared.reconcileCalls).toBe(1);
    expect(dispatchedModelIds()).toEqual([SMART_MODEL_ID]);
    expect(lastAssistant()?.status).not.toBe("error");
  });
});

describe("ready but evicted routes to prepare-local-model (no silent refetch)", () => {
  it("demotes the slot and holds the message instead of dispatching", async () => {
    // The probe proves the bytes are gone and demotes the slot to 'preparing' —
    // exactly what reconcileReadySlots does on a manifest-verified-missing model.
    shared.reconcileImpl = async () => {
      shared.smartSlotState = makeSlot("eco-smart", SMART_MODEL_ID, "preparing");
    };

    await send();

    expect(shared.reconcileCalls).toBe(1);
    // The whole point: NOTHING reached the worker, so no silent multi-GB refetch.
    expect(dispatchedModelIds()).toEqual([]);
    const assistant = lastAssistant();
    expect(assistant?.status).toBe("error");
    expect(assistant?.localReadiness?.kind).toBe("prepare-local-model");
    expect(assistant?.localReadiness?.slotId).toBe("eco-smart");
  });
});

describe("an indeterminate probe fails open", () => {
  it("dispatches today's model when the presence probe throws", async () => {
    shared.reconcileImpl = async () => {
      throw new Error("manifest unreachable");
    };

    await send();

    expect(shared.reconcileCalls).toBe(1);
    // Fail-open: a probe failure must never block a legitimate send.
    expect(dispatchedModelIds()).toEqual([SMART_MODEL_ID]);
    expect(lastAssistant()?.status).not.toBe("error");
  });
});

describe("the warm path pays nothing", () => {
  it("skips the presence probe entirely when the target is already resident", async () => {
    // The model is loaded in the runtime — its bytes are resident, so no disk
    // eviction can affect this dispatch and the probe must not run.
    shared.activeModelId = SMART_MODEL_ID;

    await send();

    expect(shared.reconcileCalls).toBe(0);
    expect(dispatchedModelIds()).toEqual([SMART_MODEL_ID]);
  });
});

describe("reconcileSlotCachePresence (unit)", () => {
  it("short-circuits without probing when the resolved target is resident", async () => {
    shared.activeModelId = SMART_MODEL_ID;

    await reconcileSlotCachePresence(SMART_MODEL_ID);

    expect(shared.reconcileCalls).toBe(0);
  });

  it("runs the probe when the target is not resident", async () => {
    shared.activeModelId = null;

    await reconcileSlotCachePresence(SMART_MODEL_ID);

    expect(shared.reconcileCalls).toBe(1);
  });

  it("never rejects even when the probe throws (fail-open)", async () => {
    shared.activeModelId = null;
    shared.reconcileImpl = async () => {
      throw new Error("boom");
    };

    await expect(reconcileSlotCachePresence(SMART_MODEL_ID)).resolves.toBeUndefined();
    expect(shared.reconcileCalls).toBe(1);
  });
});
