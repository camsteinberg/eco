// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for `resolveInitialStreamPhase` (#4 W3a).
 *
 * The send-time residency decision: when the target on-device model is already
 * resident in the runtime (warmed on mount, or a prior turn left it loaded), the
 * turn opens in "thinking" — today's behavior. When it is NOT resident, the
 * first generation must cold-load the weights (multi-second WebGPU work with no
 * byte progress), so the turn opens in the honest "loading" ("Warming up Eco…")
 * phase instead. `runGeneration` flips either start phase to "generating" on the
 * first token, so no mid-stream transition is needed.
 *
 * These tests drive the two seams the function reads — `getActiveModel()` (what
 * is resident) and `getSlot()` (slot → bound model id) — and assert the phase.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ModelConfig } from "../../local-ai/types";
import type { SlotState } from "../../local-ai/lifecycle/slots";

// ─── Seams ───────────────────────────────────────────────────────────────────
// `getActiveModel` reports the currently resident runtime model (or null).
// `getSlot` resolves a slot name to its bound model. `isLocalAiSlot` is kept
// real (a pure 'eco-fast' | 'eco-smart' string check).

const mockGetActiveModel = vi.fn<() => ModelConfig | null>(() => null);
// Default to an empty slot so module-eval-time reads (chatStore hydration runs
// before beforeEach) get a well-formed SlotState; per-test cases override this.
const mockGetSlot = vi.fn<(slot: string) => SlotState>(
  () => ({ model: null, status: "empty" }) as SlotState,
);

vi.mock("../../local-ai/runtime/lifecycle", () => ({
  getActiveModel: () => mockGetActiveModel(),
}));

// Fully replace the slots seam (chatStore + useChat read getSlot / getSlotForModel
// / hasReadySlot at module-eval). Only getSlot is exercised by the function under
// test; the rest are inert stubs so the modules load.
vi.mock("../../local-ai/lifecycle/slots", () => ({
  SLOTS: ["eco-fast", "eco-smart"],
  getSlot: (slot: string) => mockGetSlot(slot),
  getSlotForModel: () => null,
  hasReadySlot: () => false,
  setSlotStorage: vi.fn(),
  // Inert stubs: switch-model.ts (reached via useChat → upgrade.ts, #230) binds
  // these at module eval; only getSlot is exercised by the function under test.
  setSlot: vi.fn(),
  setSlotStatus: vi.fn(),
}));

// Import AFTER the mocks so the hook module picks up the mocked seams.
import { resolveInitialStreamPhase } from "../useChat";

const FAST_MODEL_ID = "candidate/lfm2.5-1.2b-instruct-onnx";

function modelConfig(id: string): ModelConfig {
  return { id, friendlyName: id } as ModelConfig;
}

function readySlot(modelId: string): SlotState {
  return { model: modelConfig(modelId), status: "ready" } as SlotState;
}

function emptySlot(): SlotState {
  return { model: null, status: "empty" } as SlotState;
}

describe("resolveInitialStreamPhase", () => {
  beforeEach(() => {
    mockGetActiveModel.mockReset().mockReturnValue(null);
    mockGetSlot.mockReset().mockReturnValue(readySlot(FAST_MODEL_ID));
  });

  describe("concrete model selection", () => {
    it("→ 'thinking' when the selected model is already resident", () => {
      mockGetActiveModel.mockReturnValue(modelConfig(FAST_MODEL_ID));
      expect(resolveInitialStreamPhase(FAST_MODEL_ID)).toBe("thinking");
    });

    it("→ 'loading' when no model is resident (cold start)", () => {
      mockGetActiveModel.mockReturnValue(null);
      expect(resolveInitialStreamPhase(FAST_MODEL_ID)).toBe("loading");
    });

    it("→ 'loading' when a DIFFERENT model is resident (model switch)", () => {
      mockGetActiveModel.mockReturnValue(modelConfig("local/some-other-model"));
      expect(resolveInitialStreamPhase(FAST_MODEL_ID)).toBe("loading");
    });
  });

  describe("slot selection (eco-fast / eco-smart)", () => {
    it("→ 'thinking' when the slot's bound model is resident", () => {
      mockGetSlot.mockReturnValue(readySlot(FAST_MODEL_ID));
      mockGetActiveModel.mockReturnValue(modelConfig(FAST_MODEL_ID));
      expect(resolveInitialStreamPhase("eco-fast")).toBe("thinking");
    });

    it("→ 'loading' when the slot's bound model is not resident", () => {
      mockGetSlot.mockReturnValue(readySlot(FAST_MODEL_ID));
      mockGetActiveModel.mockReturnValue(null);
      expect(resolveInitialStreamPhase("eco-fast")).toBe("loading");
    });

    it("→ 'loading' when the slot has no bound model (nothing to be resident)", () => {
      mockGetSlot.mockReturnValue(emptySlot());
      mockGetActiveModel.mockReturnValue(null);
      expect(resolveInitialStreamPhase("eco-smart")).toBe("loading");
    });

    it("resolves the slot through getSlot, not the raw slot name", () => {
      mockGetSlot.mockReturnValue(readySlot(FAST_MODEL_ID));
      mockGetActiveModel.mockReturnValue(modelConfig(FAST_MODEL_ID));
      resolveInitialStreamPhase("eco-fast");
      expect(mockGetSlot).toHaveBeenCalledWith("eco-fast");
    });
  });
});
