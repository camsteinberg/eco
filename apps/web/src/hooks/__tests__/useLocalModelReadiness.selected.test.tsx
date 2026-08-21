// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * `localModelReady` must answer for the model the chat's SELECTION resolves
 * to — not be hard-wired to eco-fast. With eco-smart selected and ready, the
 * chat error surfaces read "not ready" while Settings showed the same model
 * running (one of the three contradictory stories, 2026-08-05).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { ModelConfig } from "../../local-ai/types";

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

vi.mock("../../local-ai/lifecycle/setup-runner", () => ({
  executeSetup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../local-ai/runtime/lifecycle", () => ({
  getActiveModel: () => mockGetActiveModel(),
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

const FAST_MODEL = {
  id: "candidate/lfm2.5-1.2b-instruct-onnx",
  friendlyName: "Eco Fast",
} as unknown as ModelConfig;
const SMART_MODEL = {
  id: "candidate/qwen3.5-2b-onnx",
  friendlyName: "Eco Smart",
} as unknown as ModelConfig;

function fastSlot(overrides: Partial<SlotState>): SlotState {
  return {
    slot: "eco-fast",
    modelId: FAST_MODEL.id,
    model: FAST_MODEL,
    status: "ready",
    ...overrides,
  } as SlotState;
}

function smartSlot(overrides: Partial<SlotState>): SlotState {
  return {
    slot: "eco-smart",
    modelId: SMART_MODEL.id,
    model: SMART_MODEL,
    status: "ready",
    ...overrides,
  } as SlotState;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useLocalModelReadiness — selection-aware readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedModel = "eco-fast";
    mockGetActiveModel.mockReturnValue(SMART_MODEL);
    mockAcquireLocalHeavyWork.mockReturnValue({
      ok: true as const,
      lease: { ownerId: "readiness:test" },
      release: mockRelease,
    });
    mockRunSmoke.mockResolvedValue({ passed: true, firstTokenMs: 1, durationMs: 2, tokensReceived: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports ready when the SELECTED slot (eco-smart) is ready and eco-fast is empty", async () => {
    selectedModel = "eco-smart";
    mockGetSlot.mockImplementation((slot: unknown) =>
      slot === "eco-smart"
        ? smartSlot({ status: "ready" })
        : fastSlot({ modelId: null, model: null, status: "empty" }),
    );

    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();

    expect(result.current.localModelReady).toBe(true);
  });

  it("resolves 'auto' to the only bound slot (eco-smart) instead of an empty eco-fast", async () => {
    // A first-run "deeper" pick binds eco-smart and leaves eco-fast empty. The
    // store's fresh-device selection is 'auto', which dispatch resolves to the
    // best ready slot — readiness has to resolve it the same way, or it reports
    // not-ready and warms a slot with nothing in it.
    selectedModel = "auto";
    mockGetSlotForModel.mockReturnValue(null);
    mockGetSlot.mockImplementation((slot: unknown) =>
      slot === "eco-smart"
        ? smartSlot({ status: "ready" })
        : fastSlot({ modelId: null, model: null, status: "empty" }),
    );

    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();

    expect(result.current.localModelReady).toBe(true);
  });

  it("reports not ready when the selected slot is still preparing, whatever the other slot says", async () => {
    selectedModel = "eco-fast";
    mockGetSlot.mockImplementation((slot: unknown) =>
      slot === "eco-fast"
        ? fastSlot({ status: "preparing" })
        : smartSlot({ status: "ready" }),
    );

    const { result } = renderHook(() => useLocalModelReadiness());
    await settle();

    expect(result.current.localModelReady).toBe(false);
  });
});
