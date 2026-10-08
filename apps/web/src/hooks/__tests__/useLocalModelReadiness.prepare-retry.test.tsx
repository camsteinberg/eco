// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The readiness card's Prepare button retries a model that already failed on
 * this device — behaviour through the REAL setup runner, with only its seams
 * (slot store, attempt) injected. Prepare is a click, so unlike a landing it
 * must attempt the model rather than stop on the exhausted surface.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AttemptResult } from "../../local-ai/lifecycle/setup-cascade";
import type { SetupRunnerOptions } from "../../local-ai/lifecycle/setup-runner";
import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { DeviceProfile, ModelConfig, Slot } from "../../local-ai/types";

const IPHONE: DeviceProfile = {
  browserClass: "safari", webgpuSupport: "webgpu", deviceMemoryGB: 0, isMobile: true, override: "auto", webgpuShaderF16: true,
};
const MOBILE_MLC = "candidate/qwen2.5-0.5b-mlc";

const harness = vi.hoisted(() => ({
  seams: {} as Record<string, unknown>,
  slotState: null as unknown,
}));

vi.mock("../../local-ai/lifecycle/setup-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../local-ai/lifecycle/setup-runner")>();
  return {
    ...actual,
    executeSetup: (actions: Parameters<typeof actual.executeSetup>[0], options?: SetupRunnerOptions) =>
      actual.executeSetup(actions, { ...options, seams: { ...harness.seams, ...options?.seams } }),
  };
});
vi.mock("../../local-ai/lifecycle/slots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../local-ai/lifecycle/slots")>();
  return {
    ...actual,
    getSlot: () => harness.slotState,
    getSlotForModel: () => "eco-fast",
    subscribe: () => () => {},
  };
});
vi.mock("../../lib/local-heavy-work-owner", () => ({
  acquireLocalHeavyWork: () => ({ ok: true as const, lease: { ownerId: "readiness:test" }, release: () => {} }),
  describeLocalHeavyWorkBusy: () => "busy",
  getActiveLocalHeavyWorkLease: () => null,
}));
vi.mock("../../local-ai/runtime/lifecycle", () => ({ getActiveModel: () => null }));
vi.mock("../../stores/chatStore", () => ({
  useChatStore: Object.assign(
    (selector: (s: { selectedModel: string }) => unknown) => selector({ selectedModel: "eco-fast" }),
    { getState: () => ({ selectedModel: "eco-fast" }) },
  ),
}));
vi.mock("../useBatteryAwareness", () => ({
  useBatteryAwareness: () => ({ level: null, charging: null }),
  computeRestriction: () => "none",
}));
vi.mock("../../stores/conversationStore", () => ({
  useConversationStore: Object.assign(() => undefined, {
    getState: () => ({ activeConversationId: null, removeConversation: vi.fn(), setActive: vi.fn() }),
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
import { getModel } from "../../local-ai/catalog/catalog";
import { clearEvidence, recordEvidence } from "../../local-ai/evidence/ledger";

const runAttempt = vi.fn(async (_slot: Slot, _model: ModelConfig): Promise<AttemptResult> => ({ ok: true }));

beforeEach(() => {
  localStorage.clear();
  clearEvidence();
  runAttempt.mockClear();
  const mobile = getModel(MOBILE_MLC)!;
  harness.slotState = { slot: "eco-fast", modelId: mobile.id, status: "error", model: mobile } as unknown as SlotState;
  harness.seams = {
    bootstrap: vi.fn(async () => {}),
    resolveProfile: vi.fn(async () => IPHONE),
    getSlot: vi.fn(() => harness.slotState),
    setSlot: vi.fn(),
    setSlotStatus: vi.fn(),
    runAttempt,
    isModelCached: vi.fn(async () => false),
    waitForNetwork: vi.fn(async () => false),
  };
  recordEvidence({ modelId: MOBILE_MLC, profile: IPHONE, outcome: "smoke-fail" });
});

describe("useLocalModelReadiness — Prepare after the last model failed", () => {
  it("attempts the failed model, once", async () => {
    const { result } = renderHook(() => useLocalModelReadiness());

    await act(async () => {
      result.current.handlePrepareLocalModel(MOBILE_MLC);
    });

    await waitFor(() => expect(runAttempt).toHaveBeenCalledTimes(1));
    expect(runAttempt.mock.calls[0]?.[1].id).toBe(MOBILE_MLC);
  });
});
