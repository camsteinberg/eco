// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Recovery-card prepare driver.
 *
 * Pins the fix for the ready-state wedge (verified live 2026-08-05): a slot
 * stuck 'preparing' with nothing driving it must render an ACTIONABLE prepare
 * state (not a permanently disabled "Checking..."), and pressing the button
 * must run the real setup pipeline (executeSetup: resume → download missing →
 * smoke → slot 'ready'), not a bare smoke that can never flip the slot.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { ModelConfig } from "../../local-ai/types";
import type { SetupRunnerActions } from "../../local-ai/lifecycle/setup-runner";

// ── Boundary mocks ─────────────────────────────────────────────────────────

const mockExecuteSetup = vi.fn();
const mockAcquireLocalHeavyWork = vi.fn();
const mockRelease = vi.fn();
const mockGetSlot = vi.fn();
const mockGetSlotForModel = vi.fn();

let activeLease: { owner: string } | null = null;
let selectedModel = "eco-smart";

vi.mock("../../local-ai/lifecycle/setup-runner", () => ({
  executeSetup: (...args: unknown[]) => mockExecuteSetup(...args),
}));

vi.mock("../../local-ai/lifecycle/smoke", () => ({
  runSmoke: vi.fn().mockResolvedValue({ passed: true }),
}));

vi.mock("../../lib/local-heavy-work-owner", () => ({
  acquireLocalHeavyWork: (...args: unknown[]) => mockAcquireLocalHeavyWork(...args),
  describeLocalHeavyWorkBusy: () => "Eco is busy with another local task.",
  getActiveLocalHeavyWorkLease: () => activeLease,
}));

vi.mock("../../local-ai/runtime/lifecycle", () => ({
  getActiveModel: () => null,
}));

vi.mock("../../local-ai/lifecycle/slots", () => ({
  getSlot: (...args: unknown[]) => mockGetSlot(...args),
  getSlotForModel: (...args: unknown[]) => mockGetSlotForModel(...args),
  subscribe: () => () => {},
}));

vi.mock("../../stores/chatStore", () => ({
  useChatStore: Object.assign(
    (selector: (s: { selectedModel: string }) => unknown) =>
      selector({ selectedModel }),
    { getState: () => ({ selectedModel }) },
  ),
}));

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

import { useLocalModelReadiness } from "../useLocalModelReadiness";

// ── Fixtures ───────────────────────────────────────────────────────────────

const SMART_MODEL = {
  id: "candidate/qwen3.5-2b-onnx",
  friendlyName: "Eco (Qwen)",
} as unknown as ModelConfig;

function smartSlot(overrides: Partial<SlotState>): SlotState {
  return {
    slot: "eco-smart",
    modelId: SMART_MODEL.id,
    model: SMART_MODEL,
    status: "preparing",
    ...overrides,
  } as SlotState;
}

function passingLease() {
  return { ok: true as const, lease: { ownerId: "readiness:test" }, release: mockRelease };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  activeLease = null;
  selectedModel = "eco-smart";
  mockGetSlotForModel.mockReturnValue("eco-smart");
  mockGetSlot.mockReturnValue(smartSlot({}));
  mockAcquireLocalHeavyWork.mockReturnValue(passingLease());
  mockExecuteSetup.mockResolvedValue(undefined);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("useLocalModelReadiness — stale 'preparing' is actionable", () => {
  it("reports idle (button enabled) for a preparing slot with no active work", async () => {
    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();
    expect(result.current.getLocalPrepareState(SMART_MODEL.id)).toEqual({ status: "idle" });
  });

  it("reports checking only while real work holds the heavy-work lease", async () => {
    activeLease = { owner: "switch" };
    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();
    expect(result.current.getLocalPrepareState(SMART_MODEL.id)).toEqual({ status: "checking" });
  });
});

describe("useLocalModelReadiness — prepare drives the real setup pipeline", () => {
  it("runs executeSetup for the slot, holding and releasing the lease", async () => {
    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();

    act(() => {
      result.current.handlePrepareLocalModel(SMART_MODEL.id);
    });
    await settle();

    expect(mockAcquireLocalHeavyWork).toHaveBeenCalledWith("readiness");
    expect(mockExecuteSetup).toHaveBeenCalledTimes(1);
    const [, options] = mockExecuteSetup.mock.calls[0] as [SetupRunnerActions, { slot: string }];
    expect(options.slot).toBe("eco-smart");
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
  });

  it("surfaces download progress and the warm-up phase while running", async () => {
    let capturedActions: SetupRunnerActions | null = null;
    let finish: () => void = () => {};
    mockExecuteSetup.mockImplementation((actions: SetupRunnerActions) => {
      capturedActions = actions;
      return new Promise<void>((resolve) => { finish = resolve; });
    });

    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();

    act(() => {
      result.current.handlePrepareLocalModel(SMART_MODEL.id);
    });
    await settle();

    act(() => {
      capturedActions!.onProgressEvent({
        kind: "progress",
        phase: "downloading",
        percent: 0.4,
        loaded: 4,
        total: 10,
        speedBytesPerSec: 1,
        etaSeconds: 1,
      });
    });
    expect(result.current.getLocalPrepareState(SMART_MODEL.id)).toEqual({
      status: "downloading",
      progress: 0.4,
    });

    act(() => {
      capturedActions!.onProgressEvent({
        kind: "progress",
        phase: "smoke",
        stage: "starting",
      });
    });
    expect(result.current.getLocalPrepareState(SMART_MODEL.id)).toEqual({ status: "warming" });

    act(() => finish());
    await waitFor(() => expect(mockRelease).toHaveBeenCalled());
  });

  it("reports the pipeline's error and still releases the lease", async () => {
    mockExecuteSetup.mockImplementation(async (actions: SetupRunnerActions) => {
      actions.setError("The readiness check failed on this device.");
    });

    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();

    act(() => {
      result.current.handlePrepareLocalModel(SMART_MODEL.id);
    });
    await settle();

    expect(result.current.getLocalPrepareState(SMART_MODEL.id)).toEqual({
      status: "error",
      error: "The readiness check failed on this device.",
    });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a slot that is already ready", async () => {
    mockGetSlot.mockReturnValue(smartSlot({ status: "ready" }));
    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();

    act(() => {
      result.current.handlePrepareLocalModel(SMART_MODEL.id);
    });
    await settle();

    // (The mount-time warmup may acquire the lease for a READY slot — that
    // path is pinned by the warmup test file. Only the prepare driver must
    // stay quiet here.)
    expect(mockExecuteSetup).not.toHaveBeenCalled();
  });

  it("reports an honest error when no slot owns the model", async () => {
    mockGetSlotForModel.mockReturnValue(null);
    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();

    act(() => {
      result.current.handlePrepareLocalModel("candidate/unknown");
    });

    expect(result.current.getLocalPrepareState("candidate/unknown").status).toBe("error");
    expect(mockExecuteSetup).not.toHaveBeenCalled();
  });
});
