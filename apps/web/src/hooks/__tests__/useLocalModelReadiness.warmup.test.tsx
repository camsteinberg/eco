// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Mount-time warmup gate (#4 W3a).
 *
 * The hook loads the selected slot's model into the runtime on chat mount so
 * the first message skips the cold weight-load. These tests lock the GATE
 * decision and the silent-on-failure contract at the loadModel/lease boundary,
 * plus the cache check that keeps an invisible warm from ever starting a
 * download — they do NOT assert on the whole hook's render output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { ModelConfig } from "../../local-ai/types";

// ── Boundary mocks ─────────────────────────────────────────────────────────

const mockRunSmoke = vi.fn();
const mockLoadModel = vi.fn();
const mockIsModelDownloaded = vi.fn();
const mockAcquireLocalHeavyWork = vi.fn();
const mockRelease = vi.fn();
const mockGetActiveModel = vi.fn();
const mockGetSlot = vi.fn();
const mockGetSlotForModel = vi.fn();

let selectedModel = "eco-fast";

vi.mock("../../local-ai/lifecycle/smoke", () => ({
  runSmoke: (...args: unknown[]) => mockRunSmoke(...args),
}));

vi.mock("../../local-ai/download/download", () => ({
  isModelDownloaded: (...args: unknown[]) => mockIsModelDownloaded(...args),
}));

vi.mock("../../lib/local-heavy-work-owner", () => ({
  acquireLocalHeavyWork: (...args: unknown[]) => mockAcquireLocalHeavyWork(...args),
  describeLocalHeavyWorkBusy: () => "busy",
}));

vi.mock("../../local-ai/runtime/lifecycle", () => ({
  getActiveModel: () => mockGetActiveModel(),
  loadModel: (...args: unknown[]) => mockLoadModel(...args),
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

let stagedUpgrade = false;
vi.mock("../../local-ai/lifecycle/upgrade", () => ({
  hasStagedUpgrade: () => stagedUpgrade,
}));

vi.mock("../../local-ai/util", async () => {
  const actual = await vi.importActual<typeof import("../../local-ai/util")>(
    "../../local-ai/util",
  );
  return actual;
});

import { useLocalModelReadiness } from "../useLocalModelReadiness";

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
    stagedUpgrade = false;
    mockGetActiveModel.mockReturnValue(null);
    mockRunSmoke.mockResolvedValue({
      passed: true,
      firstTokenMs: 10,
      durationMs: 20,
      tokensReceived: 1,
    });
    mockIsModelDownloaded.mockResolvedValue(true);
    mockLoadModel.mockResolvedValue({});
    mockAcquireLocalHeavyWork.mockReturnValue(passingLease());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warms the selected slot's model by LOADING it — never by generating", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    renderHook(() => useLocalModelReadiness());

    await waitFor(() => expect(mockLoadModel).toHaveBeenCalledTimes(1));

    // Loads the correct model bound to the selected slot, under the readiness lease.
    expect(mockLoadModel).toHaveBeenCalledWith(FAST_MODEL, expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(mockAcquireLocalHeavyWork).toHaveBeenCalledWith("readiness");
    // The discarded 8-token proof generation is gone: the warm must not smoke.
    expect(mockRunSmoke).not.toHaveBeenCalled();
    // Lease is released after the warm completes (no leak).
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
  });

  it("checks the cache before loading and skips when the bytes are gone — a warm must never start a download", async () => {
    // Replaces the early-exit that used to live inside runSmoke: if the cache
    // was cleared between the 'ready' gate and here, loading would fetch
    // hundreds of MB inside an invisible background task.
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));
    mockIsModelDownloaded.mockResolvedValue(false);

    renderHook(() => useLocalModelReadiness());

    await waitFor(() => expect(mockIsModelDownloaded).toHaveBeenCalledWith(FAST_MODEL));
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
    expect(mockLoadModel).not.toHaveBeenCalled();
  });

  it("releases the lease when the cache probe itself throws", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));
    mockIsModelDownloaded.mockRejectedValue(new Error("storage unavailable"));

    const { result } = renderHook(() => useLocalModelReadiness());

    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
    expect(mockLoadModel).not.toHaveBeenCalled();
    expect(result.current.getLocalPrepareState(FAST_MODEL.id).status).not.toBe("error");
  });

  it("does NOT warm (and never risks a download) when the slot is not ready", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "preparing" }));

    renderHook(() => useLocalModelReadiness());

    // Give any async path a chance to (incorrectly) fire.
    await settle();

    expect(mockLoadModel).not.toHaveBeenCalled();
    expect(mockRunSmoke).not.toHaveBeenCalled();
    expect(mockAcquireLocalHeavyWork).not.toHaveBeenCalled();
  });

  it("does NOT warm when the slot has no model assigned (empty)", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "empty", model: null, modelId: null }));

    renderHook(() => useLocalModelReadiness());
    await settle();

    expect(mockLoadModel).not.toHaveBeenCalled();
    expect(mockRunSmoke).not.toHaveBeenCalled();
  });

  it("does NOT warm when the slot is in an error state", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "error" }));

    renderHook(() => useLocalModelReadiness());
    await settle();

    expect(mockLoadModel).not.toHaveBeenCalled();
    expect(mockRunSmoke).not.toHaveBeenCalled();
  });

  it("skips the smoke when the model is already resident in the runtime", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));
    mockGetActiveModel.mockReturnValue(FAST_MODEL);

    renderHook(() => useLocalModelReadiness());
    await settle();

    expect(mockLoadModel).not.toHaveBeenCalled();
    expect(mockRunSmoke).not.toHaveBeenCalled();
    expect(mockAcquireLocalHeavyWork).not.toHaveBeenCalled();
  });

  it("does NOT warm the starter when an upgrade is staged (boot swap owns the load)", async () => {
    // Slice 2b: a staged upgrade means the boot path is about to swap to the
    // stronger model — warming the starter would spend the expensive load +
    // shader compile on a model that is about to be unloaded, and the held
    // readiness lease would make the swap wait out its retry budget.
    stagedUpgrade = true;
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    renderHook(() => useLocalModelReadiness());
    await settle();

    expect(mockLoadModel).not.toHaveBeenCalled();
    expect(mockRunSmoke).not.toHaveBeenCalled();
    expect(mockAcquireLocalHeavyWork).not.toHaveBeenCalled();
  });

  it("warms at most once per mount (ref-guarded across re-renders)", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    const { rerender } = renderHook(() => useLocalModelReadiness());
    await waitFor(() => expect(mockLoadModel).toHaveBeenCalledTimes(1));

    rerender();
    rerender();
    await settle();

    expect(mockLoadModel).toHaveBeenCalledTimes(1);
  });

  it("resolves the slot a concrete selected model id is bound to", async () => {
    selectedModel = FAST_MODEL.id; // concrete id, not a slot name
    mockGetSlotForModel.mockReturnValue("eco-fast");
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    renderHook(() => useLocalModelReadiness());
    await waitFor(() => expect(mockLoadModel).toHaveBeenCalledTimes(1));

    expect(mockGetSlotForModel).toHaveBeenCalledWith(FAST_MODEL.id);
    expect(mockLoadModel).toHaveBeenCalledWith(FAST_MODEL, expect.any(Object));
  });

  it("falls back to eco-fast when a concrete model id has no owning slot", async () => {
    selectedModel = "candidate/some-unslotted-model";
    mockGetSlotForModel.mockReturnValue(null);
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    renderHook(() => useLocalModelReadiness());
    await waitFor(() => expect(mockLoadModel).toHaveBeenCalledTimes(1));

    // getSlotForModel was queried with the concrete id and returned null
    expect(mockGetSlotForModel).toHaveBeenCalledWith("candidate/some-unslotted-model");
    // Warmup fell back to eco-fast (the ?? "eco-fast" branch)
    expect(mockGetSlot).toHaveBeenCalledWith("eco-fast");
    expect(mockLoadModel).toHaveBeenCalledWith(FAST_MODEL, expect.any(Object));
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
    expect(mockLoadModel).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("swallows a loadModel rejection — no error surfaced, lease released", async () => {
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));
    mockLoadModel.mockRejectedValue(new Error("cold load exploded"));

    const { result } = renderHook(() => useLocalModelReadiness());

    await waitFor(() => expect(mockLoadModel).toHaveBeenCalledTimes(1));
    // Lease still released despite the throw (finally block).
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));

    // The hook stays stable: no prepare error leaks into the warming surface.
    expect(result.current.getLocalPrepareState(FAST_MODEL.id).status).not.toBe("error");
  });

  it("passes an unaborted signal so a hung load can be bounded", async () => {
    // The warm holds the heavy-work lease, so an unbounded load would block
    // user-driven prepares indefinitely. The signal is the bound.
    mockGetSlot.mockReturnValue(slotState({ status: "ready" }));

    renderHook(() => useLocalModelReadiness());

    await waitFor(() => expect(mockLoadModel).toHaveBeenCalledTimes(1));
    const opts = mockLoadModel.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal?.aborted).toBe(false);
  });
});
