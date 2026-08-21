// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Mount-time warmup gate (#4 W3a).
 *
 * The hook loads the selected slot's model into the runtime on chat mount so
 * the first message skips the cold weight-load. These tests lock the GATE
 * decision and the silent-on-failure contract at the runSmoke/lease boundary —
 * they do NOT assert on the whole hook's render output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { ModelConfig } from "../../local-ai/types";

// ── Boundary mocks ─────────────────────────────────────────────────────────

const mockRunSmoke = vi.fn();
const mockAcquireLocalHeavyWork = vi.fn();
const mockRelease = vi.fn();
const mockGetActiveModel = vi.fn();
const mockGetSlot = vi.fn();
const mockGetSlotForModel = vi.fn();

let selectedModel = "eco-fast";

vi.mock("../../local-ai/lifecycle/smoke", () => ({
  runSmoke: (...args: unknown[]) => mockRunSmoke(...args),
}));

vi.mock("../../lib/local-heavy-work-owner", () => ({
  acquireLocalHeavyWork: (...args: unknown[]) => mockAcquireLocalHeavyWork(...args),
  describeLocalHeavyWorkBusy: () => "busy",
  getActiveLocalHeavyWorkLease: () => null,
}));

// The prepare driver (separate test file) pulls in the setup runner; keep it
// inert here so the warmup tests stay about the warmup gate.
vi.mock("../../local-ai/lifecycle/setup-runner", () => ({
  executeSetup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../local-ai/runtime/lifecycle", () => ({
  getActiveModel: () => mockGetActiveModel(),
}));

vi.mock("../../local-ai/lifecycle/slots", () => ({
  getSlot: (...args: unknown[]) => mockGetSlot(...args),
  getSlotForModel: (...args: unknown[]) => mockGetSlotForModel(...args),
  // Subscribe is a no-op for these tests; return an unsubscribe fn.
  subscribe: () => () => {},
}));

vi.mock("../../stores/chatStore", () => ({
  useChatStore: Object.assign(
    (selector: (s: { selectedModel: string }) => unknown) =>
      selector({ selectedModel }),
    { getState: () => ({ selectedModel }) },
  ),
}));

// Inert transitive deps — keep the hook's unrelated effects quiet so the test
// is about the warmup gate, not battery/validation/recovery plumbing.
vi.mock("../useBatteryAwareness", () => ({
  useBatteryAwareness: () => ({ level: null, charging: null }),
  computeRestriction: () => "none",
}));

vi.mock("../../stores/conversationStore", () => ({
  useConversationStore: Object.assign(() => undefined, {
    getState: () => ({
      activeConversationId: null,
      removeConversation: vi.fn(),
      setActive: vi.fn(),
    }),
    setState: vi.fn(),
  }),
}));

vi.mock("../../lib/validation-harness", () => ({
  getValidationHarnessState: () => ({
    enabled: false,
    downloadFailure: "none",
    runtimeMode: "none",
    protectionMode: "none",
    remoteMode: "none",
    heavyWorkDryRun: "none",
  }),
  getValidationConversationHistoryFixture: () => "none",
  getValidationProtectionBanner: () => null,
  getValidationSelectedModelBanner: () => null,
}));

vi.mock("../../lib/validation-conversation-history-fixture", () => ({
  clearValidationConversationHistoryFixture: vi.fn(),
  installValidationConversationHistoryFixture: vi.fn(),
}));

vi.mock("../../local-ai/lifecycle/recovery", () => ({
  resolveReadyLocalRecoveryModelId: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../local-ai/util", async () => {
  const actual = await vi.importActual<typeof import("../../local-ai/util")>(
    "../../local-ai/util",
  );
  return actual;
});

import { useLocalModelReadiness } from "../useLocalModelReadiness";

/** Where a staged pull persists, if one exists. */
const STAGED_PULL_KEY = "eco-local-ai-upgrade-v1";

// ── Fixtures ───────────────────────────────────────────────────────────────

const FAST_MODEL = {
  id: "candidate/lfm2.5-1.2b-instruct-onnx",
  friendlyName: "Eco Fast",
} as unknown as ModelConfig;

function slotState(overrides: Partial<SlotState>): SlotState {
  return {
    slot: "eco-fast",
    modelId: FAST_MODEL.id,
    model: FAST_MODEL,
    status: "ready",
    ...overrides,
  } as SlotState;
}

function passingLease() {
  return { ok: true as const, lease: { ownerId: "readiness:test" }, release: mockRelease };
}

/** Let mount effects (including the unrelated recovery effect) settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("useLocalModelReadiness — mount-time warmup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedModel = "eco-fast";
    localStorage.removeItem(STAGED_PULL_KEY);
    mockGetActiveModel.mockReturnValue(null);
    mockRunSmoke.mockResolvedValue({
      passed: true,
      firstTokenMs: 10,
      durationMs: 20,
      tokensReceived: 1,
    });
    mockAcquireLocalHeavyWork.mockReturnValue(passingLease());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warms the selected slot's model when the slot is ready", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    renderHook(() => useLocalModelReadiness());

    await waitFor(() => expect(mockRunSmoke).toHaveBeenCalledTimes(1));

    // Warms the correct model bound to the selected slot, under the readiness lease.
    expect(mockRunSmoke).toHaveBeenCalledWith("eco-fast", FAST_MODEL, expect.any(Object));
    expect(mockAcquireLocalHeavyWork).toHaveBeenCalledWith("readiness");
    // Lease is released after the warm completes (no leak).
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
  });

  it("does NOT warm (and never risks a download) when the slot is not ready", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "preparing" }));

    renderHook(() => useLocalModelReadiness());

    // Give any async path a chance to (incorrectly) fire.
    await settle();

    expect(mockRunSmoke).not.toHaveBeenCalled();
    expect(mockAcquireLocalHeavyWork).not.toHaveBeenCalled();
  });

  it("does NOT warm when the slot has no model assigned (empty)", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "empty", model: null, modelId: null }));

    renderHook(() => useLocalModelReadiness());
    await settle();

    expect(mockRunSmoke).not.toHaveBeenCalled();
  });

  it("does NOT warm when the slot is in an error state", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "error" }));

    renderHook(() => useLocalModelReadiness());
    await settle();

    expect(mockRunSmoke).not.toHaveBeenCalled();
  });

  it("skips the smoke when the model is already resident in the runtime", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));
    mockGetActiveModel.mockReturnValue(FAST_MODEL);

    renderHook(() => useLocalModelReadiness());
    await settle();

    expect(mockRunSmoke).not.toHaveBeenCalled();
    expect(mockAcquireLocalHeavyWork).not.toHaveBeenCalled();
  });

  it("DOES warm the serving model while another one sits staged", async () => {
    // This used to be skipped: a staged record meant the boot path was about to
    // swap, so warming the current model would have loaded something that was
    // about to be unloaded. Nothing swaps at boot any more — staged weights wait
    // for the user's own "switch now" — so skipping would leave the model they
    // are actually chatting on cold for the entire session.
    // The real persisted record, not a seam: the point of the case is that this
    // hook no longer reads it at all.
    localStorage.setItem(STAGED_PULL_KEY, JSON.stringify({
      version: 1,
      phase: "staged",
      targetModelId: "candidate/lfm2-2.6b-onnx",
      targetSlot: "eco-smart",
      baseModelId: null,
      deferral: null,
      swapAttempts: 0,
      updatedAt: 0,
    }));
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    renderHook(() => useLocalModelReadiness());
    await settle();

    expect(mockRunSmoke).toHaveBeenCalledTimes(1);
    expect(mockAcquireLocalHeavyWork).toHaveBeenCalledWith("readiness");
  });

  it("warms at most once per mount (ref-guarded across re-renders)", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    const { rerender } = renderHook(() => useLocalModelReadiness());
    await waitFor(() => expect(mockRunSmoke).toHaveBeenCalledTimes(1));

    rerender();
    rerender();
    await settle();

    expect(mockRunSmoke).toHaveBeenCalledTimes(1);
  });

  it("resolves the slot a concrete selected model id is bound to", async () => {
    selectedModel = FAST_MODEL.id; // concrete id, not a slot name
    mockGetSlotForModel.mockReturnValue("eco-fast");
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    renderHook(() => useLocalModelReadiness());
    await waitFor(() => expect(mockRunSmoke).toHaveBeenCalledTimes(1));

    expect(mockGetSlotForModel).toHaveBeenCalledWith(FAST_MODEL.id);
    expect(mockRunSmoke).toHaveBeenCalledWith("eco-fast", FAST_MODEL, expect.any(Object));
  });

  it("falls back to eco-fast when a concrete model id has no owning slot", async () => {
    selectedModel = "candidate/some-unslotted-model";
    mockGetSlotForModel.mockReturnValue(null);
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    renderHook(() => useLocalModelReadiness());
    await waitFor(() => expect(mockRunSmoke).toHaveBeenCalledTimes(1));

    // getSlotForModel was queried with the concrete id and returned null
    expect(mockGetSlotForModel).toHaveBeenCalledWith("candidate/some-unslotted-model");
    // Warmup fell back to eco-fast (the ?? "eco-fast" branch)
    expect(mockGetSlot).toHaveBeenCalledWith("eco-fast");
    expect(mockRunSmoke).toHaveBeenCalledWith("eco-fast", FAST_MODEL, expect.any(Object));
  });

  it("does not contend when the heavy-work lease is already held", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));
    mockAcquireLocalHeavyWork.mockReturnValue({
      ok: false,
      active: { kind: "readiness" },
      reason: "busy",
    });

    renderHook(() => useLocalModelReadiness());
    await settle();

    // Tried once, but did not run smoke (let the holder warm it).
    expect(mockAcquireLocalHeavyWork).toHaveBeenCalledTimes(1);
    expect(mockRunSmoke).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("swallows a runSmoke rejection — no error surfaced, lease released", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));
    mockRunSmoke.mockRejectedValue(new Error("cold load exploded"));

    const { result } = renderHook(() => useLocalModelReadiness());

    await waitFor(() => expect(mockRunSmoke).toHaveBeenCalledTimes(1));
    // Lease still released despite the throw (finally block).
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));

    // The hook stays stable: no prepare error leaks into the warming surface.
    expect(result.current.getLocalPrepareState(FAST_MODEL.id).status).not.toBe("error");
  });

  it("ignores a { passed: false } warm result silently (no error surfaced)", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));
    mockRunSmoke.mockResolvedValue({
      passed: false,
      reason: "Model not yet downloaded",
      durationMs: 5,
    });

    const { result } = renderHook(() => useLocalModelReadiness());

    await waitFor(() => expect(mockRunSmoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));

    expect(result.current.getLocalPrepareState(FAST_MODEL.id).status).not.toBe("error");
  });
});
