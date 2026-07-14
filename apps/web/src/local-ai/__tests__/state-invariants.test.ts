// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Value-level state invariants for the local-AI selection/slot surface.
 *
 * These are the runtime counterparts to the seven numbered invariants (I1–I7)
 * in docs/design/local-ai-state-model.md. The sibling `invariants.test.ts`
 * holds the *architectural* invariants (export/ownership greps); this file
 * holds the *behavioral* ones — the guarantees a reader of the state-model doc
 * should be able to trust hold at runtime, across module boundaries, using only
 * the seams the modules already expose (no production code was added for these).
 *
 * Environment note: vitest runs with NODE_ENV=test, which enables the
 * validation harness (`isValidationHarnessEnabledForEnvironment`). That means
 * `getSlot` will resolve eval-candidate ids in addition to catalog ids, and the
 * `eco-validation-*` slot/selection overrides are honored *if set* — these tests
 * never set them, so slots and selection read from the canonical keys. jsdom
 * exposes WebAssembly (Node global) but no `navigator.gpu`, so the inference
 * capability reads as `'wasm'` (supported), not `'unsupported'`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetSlotsForTesting,
  getSlot,
  readRawSlotIdForMigration,
  setSlot,
  setSlotStatus,
  setSlotStorage,
  type SlotStatus,
} from "../lifecycle/slots";
import { resolveSelectedModelId } from "../util";
import {
  _resetUpgradeForTesting,
  applyUpgradeEvent,
  MAX_SWAP_ATTEMPTS,
  performUpgradeSwap,
  readUpgradeRecord,
  transitionUpgrade,
  type UpgradeRecord,
  type UpgradeSwapSeams,
} from "../lifecycle/upgrade";
import {
  reconcileReadySlots,
  runSelfHeal,
  type RetiredModelMigration,
} from "../lifecycle/self-heal";
import type { Storage as DownloadStorage } from "../download/storage";
import type { DeviceProfile } from "../types";

// Real catalog ids — the slot resolver nulls anything the catalog doesn't own,
// so every id a slot is *expected* to resolve must be a live catalog entry.
const CATALOG_STARTER = "candidate/lfm2.5-350m-onnx";
const CATALOG_FAST = "local/qwen3-0.6b";
const CATALOG_SMART = "candidate/qwen3.5-2b-onnx";
// An id that is neither a catalog model nor an eval candidate — a slot bound to
// it reads back empty.
const UNCATALOGED_ID = "local/__not-a-real-model__";

function resetState(): void {
  localStorage.clear();
  setSlotStorage(null);
  _resetSlotsForTesting();
  _resetUpgradeForTesting();
  vi.resetModules();
}

beforeEach(resetState);
afterEach(resetState);

/**
 * I1 — Selection totality.
 *
 * `resolveSelectedModelId` is the single dispatch-time resolver every
 * generation runs through. It must return a non-empty string and never throw,
 * for any legal slot state (empty/preparing/ready/error × bound/unbound) and
 * even when a slot is bound to an id the catalog no longer owns.
 */
describe("I1 — resolveSelectedModelId is total and non-throwing", () => {
  const STATUSES: SlotStatus[] = ["empty", "preparing", "ready", "error"];

  it("returns a non-empty string for a slot choice across every legal slot state", () => {
    for (const status of STATUSES) {
      resetState();
      if (status !== "empty") {
        setSlot("eco-fast", CATALOG_FAST);
        setSlotStatus("eco-fast", status);
      }
      const resolved = resolveSelectedModelId("eco-fast");
      expect(typeof resolved).toBe("string");
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it("passes an empty slot choice through unchanged (no crash on unbound)", () => {
    // eco-smart never bound.
    expect(resolveSelectedModelId("eco-smart")).toBe("eco-smart");
  });

  it("falls back to the slot name when the slot is bound to an uncataloged id", () => {
    setSlot("eco-fast", UNCATALOGED_ID);
    // getSlot nulls the uncataloged id, so resolution has no concrete id to
    // return and passes the choice (the slot name) through.
    expect(getSlot("eco-fast").model).toBeNull();
    expect(resolveSelectedModelId("eco-fast")).toBe("eco-fast");
  });

  it("returns a concrete id unchanged and never throws on unusual input", () => {
    expect(resolveSelectedModelId("auto")).toBe("auto");
    expect(resolveSelectedModelId(CATALOG_SMART)).toBe(CATALOG_SMART);
    expect(() => resolveSelectedModelId("")).not.toThrow();
  });
});

/**
 * I2 — An explicit catalog pick survives rehydration verbatim.
 *
 * The 2026-06-10 "it switched back to Bonsai on its own" reversion bug: an
 * explicit pick of a `candidate/` id fell through every normalize branch into
 * the eco-fast catch-all. The fix made the explicit-pick branch prefix-agnostic.
 * This drives the real chatStore hydration (`loadPersistedSelectedModel`), not a
 * unit of it. No capability mock is needed — jsdom reports `'wasm'` (supported),
 * which is exactly why the neighboring chatStore-persistence suite's explicit
 * cases pass without one.
 */
describe("I2 — explicit catalog pick survives chatStore rehydration verbatim", () => {
  it("hydrates a persisted explicit candidate/ pick as itself", async () => {
    localStorage.setItem("eco-selected-model", CATALOG_SMART);
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../../stores/chatStore");

    expect(useChatStore.getState().selectedModel).toBe(CATALOG_SMART);
  });
});

/**
 * I3 — The upgrade cycle only ever targets and binds eco-smart.
 *
 * The locked product rule: the upgrade carries the device from the eco-fast
 * starter to the class-best model on eco-smart. eco-fast keeps the starter. The
 * swap primitive is a seam here, so "binds eco-smart" is proven by the slot the
 * driver hands it; "never mutates eco-fast" is proven against the real eco-fast
 * slot, seeded before the swap and asserted unchanged after.
 */
describe("I3 — upgrade targets/binds eco-smart only, never eco-fast", () => {
  function driveToStaged(): void {
    applyUpgradeEvent({ type: "offer", targetModelId: CATALOG_SMART, baseModelId: CATALOG_STARTER });
    applyUpgradeEvent({ type: "accept" });
    applyUpgradeEvent({ type: "download-started" });
    applyUpgradeEvent({ type: "download-completed" });
  }

  it("swaps into eco-smart and leaves eco-fast's binding untouched", async () => {
    // Seed eco-fast with the starter, ready — this must survive the swap.
    setSlot("eco-fast", CATALOG_STARTER);
    setSlotStatus("eco-fast", "ready");

    driveToStaged();
    expect(readUpgradeRecord()?.phase).toBe("staged");
    expect(readUpgradeRecord()?.targetModelId).toBe(CATALOG_SMART);

    const prepareCalls: { slot: string; modelId: string }[] = [];
    const seams: Partial<UpgradeSwapSeams> = {
      isModelFullyCached: () => Promise.resolve(true),
      getSlot: () => ({ slot: "eco-smart", modelId: null, model: null, status: "empty" }),
      prepareModelForSlot: ({ slot, modelId }) => {
        prepareCalls.push({ slot, modelId });
        return Promise.resolve(
          { success: true } as Awaited<ReturnType<UpgradeSwapSeams["prepareModelForSlot"]>>,
        );
      },
      recordEvidence: vi.fn(),
      getDeviceProfile: () => ({}) as DeviceProfile,
    };

    const outcome = await performUpgradeSwap({ seams });

    expect(outcome.kind).toBe("swapped");
    // Bound eco-smart — never any other slot.
    expect(prepareCalls).toEqual([{ slot: "eco-smart", modelId: CATALOG_SMART }]);
    // eco-fast is exactly as seeded.
    const fast = getSlot("eco-fast");
    expect(fast.modelId).toBe(CATALOG_STARTER);
    expect(fast.status).toBe("ready");
    // The settled record still names the eco-smart target.
    expect(readUpgradeRecord()?.phase).toBe("done");
    expect(readUpgradeRecord()?.targetModelId).toBe(CATALOG_SMART);
  });
});

/**
 * I4 — The pure transition table rejects illegal phase jumps by returning the
 * input unchanged (it never throws; only `reset` produces null). This is the
 * deliberate racing-event tolerance documented on `transitionUpgrade`.
 */
describe("I4 — transitionUpgrade rejects illegal jumps (returns input unchanged)", () => {
  const NOW = 1_000;
  const offered: UpgradeRecord = {
    version: 1,
    phase: "offered",
    targetModelId: CATALOG_SMART,
    baseModelId: CATALOG_STARTER,
    deferral: null,
    swapAttempts: 0,
    updatedAt: 0,
  };
  const done: UpgradeRecord = { ...offered, phase: "done" };

  it("leaves 'offered' unchanged on a swap-started (only 'staged' may start a swap)", () => {
    expect(transitionUpgrade(offered, { type: "swap-started" }, NOW)).toBe(offered);
  });

  it("leaves 'offered' unchanged on a download-completed (nothing was downloading)", () => {
    expect(transitionUpgrade(offered, { type: "download-completed" }, NOW)).toBe(offered);
  });

  it("leaves a settled 'done' unchanged on a download-started", () => {
    expect(transitionUpgrade(done, { type: "download-started" }, NOW)).toBe(done);
  });

  it("never throws on a wildly illegal event and returns the same reference", () => {
    expect(() => transitionUpgrade(done, { type: "swap-succeeded" }, NOW)).not.toThrow();
    expect(transitionUpgrade(done, { type: "swap-succeeded" }, NOW)).toBe(done);
  });

  it("still honors the one legal null transition: reset clears the record", () => {
    expect(transitionUpgrade(offered, { type: "reset" }, NOW)).toBeNull();
  });

  it("caps swap attempts at MAX_SWAP_ATTEMPTS before deferring", () => {
    // A staged record already at the cap defers rather than starting another swap.
    const cappedStaged: UpgradeRecord = { ...offered, phase: "staged", swapAttempts: MAX_SWAP_ATTEMPTS };
    const next = transitionUpgrade(cappedStaged, { type: "swap-started" }, NOW);
    expect(next?.phase).toBe("deferred");
  });
});

/**
 * I5 — Phantom-pick rule (slots.ts setSlot).
 *
 * Binding a DIFFERENT id — or binding into an empty slot — forces 'preparing'
 * because the new bytes are unverified until the pipeline drives the slot ready.
 * A same-id re-bind preserves status: the bytes it describes are unchanged. This
 * is the guard against the "Settings says running, chat refuses, nothing
 * resumes" phantom pick after a reload mid-switch.
 */
describe("I5 — phantom-pick rule on setSlot", () => {
  it("bind-from-empty forces 'preparing'", () => {
    expect(getSlot("eco-fast").status).toBe("empty");
    setSlot("eco-fast", CATALOG_FAST);
    expect(getSlot("eco-fast").status).toBe("preparing");
  });

  it("same-id rebind preserves a 'ready' status", () => {
    setSlot("eco-fast", CATALOG_FAST);
    setSlotStatus("eco-fast", "ready");
    setSlot("eco-fast", CATALOG_FAST); // same id
    expect(getSlot("eco-fast").status).toBe("ready");
  });

  it("different-id rebind from 'ready' forces 'preparing'", () => {
    setSlot("eco-fast", CATALOG_FAST);
    setSlotStatus("eco-fast", "ready");
    setSlot("eco-fast", CATALOG_SMART); // different id
    expect(getSlot("eco-fast").status).toBe("preparing");
  });
});

/**
 * I6 — 'ready' never survives a failed cache verify.
 *
 * `reconcileReadySlots` re-checks each 'ready' slot against reviewed manifest
 * sizes at boot. A short/corrupt file flips the slot to 'preparing' and fires
 * `onCacheRepaired`. Two escape hatches must hold: the harness force-skip leaves
 * fixtures alone, and a NULL plan (manifest unreachable) SKIPS — the 2026-06-11
 * incident where reconcile wiped a healthy 1.4GB cache after a manifest timeout.
 */
describe("I6 — reconcileReadySlots never leaves a failed-verify slot 'ready'", () => {
  function fakeStorage(overrides: Partial<DownloadStorage>): DownloadStorage {
    return {
      backend: "cache-api",
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      has: () => Promise.resolve(false),
      verify: () => Promise.resolve(false),
      remove: () => Promise.resolve(),
      listForModel: () => Promise.resolve([]),
      clearModel: () => Promise.resolve(),
      ...overrides,
    };
  }

  it("flips ready→preparing and fires onCacheRepaired on a short (removable) file", async () => {
    setSlot("eco-fast", CATALOG_FAST);
    setSlotStatus("eco-fast", "ready");

    const repaired: { modelId: string; slot: string; removed: number }[] = [];
    // verify fails but the file exists → it is a removable corrupt file → removed++.
    const cacheStorage = fakeStorage({
      verify: () => Promise.resolve(false),
      has: () => Promise.resolve(true),
    });

    await reconcileReadySlots(() => Promise.resolve([{ url: "weights.onnx", sizeBytes: 100 }]), {
      cacheStorage,
      isCacheVerificationForced: () => false,
      onCacheRepaired: (info) => repaired.push(info),
    });

    expect(getSlot("eco-fast").status).toBe("preparing");
    expect(repaired).toEqual([{ modelId: CATALOG_FAST, slot: "eco-fast", removed: 1 }]);
  });

  it("leaves the slot 'ready' when cache verification is force-skipped (harness fixtures)", async () => {
    setSlot("eco-fast", CATALOG_FAST);
    setSlotStatus("eco-fast", "ready");

    const cacheStorage = fakeStorage({
      verify: () => Promise.resolve(false),
      has: () => Promise.resolve(false),
    });
    await reconcileReadySlots(() => Promise.resolve([{ url: "weights.onnx", sizeBytes: 100 }]), {
      cacheStorage,
      isCacheVerificationForced: () => true,
    });

    expect(getSlot("eco-fast").status).toBe("ready");
  });

  it("SKIPS (never wipes) when the plan is null — manifest unreachable", async () => {
    setSlot("eco-fast", CATALOG_FAST);
    setSlotStatus("eco-fast", "ready");

    const report = await reconcileReadySlots(() => Promise.resolve(null), {
      cacheStorage: fakeStorage({}),
      isCacheVerificationForced: () => false,
    });

    expect(getSlot("eco-fast").status).toBe("ready");
    expect(report.slotsFlippedToPreparing).toEqual([]);
    expect(report.modelsRepaired).toEqual([]);
  });
});

/**
 * I7 — Retired-model detox leaves no dangling selection.
 *
 * The one invariant no per-module suite holds today: removing a catalog model
 * must scrub every surface that could still point at it — the bound slot, the
 * persisted `eco-selected-model`, and (transitively) the model chatStore
 * rehydrates. Uses a SYNTHETIC retired migration via the documented
 * `retiredMigrations` seam (rather than a real retired id like Bonsai/SmolLM2)
 * so the test can't rot when the catalog changes — the seam exists precisely for
 * exercising the mechanism without a real catalog removal.
 */
describe("I7 — retired-model detox leaves no dangling selection", () => {
  const RETIRED_ID = "local/__retired-test-model__";
  const migration: RetiredModelMigration = {
    modelId: RETIRED_ID,
    friendlyLabel: "Retired Test Model",
    markerKey: "eco-local-ai-mig-retire-test-v1",
  };

  it("rebinds the slot to a catalog model and never rehydrates the retired id", async () => {
    // The user was on the retired model: slot bound to it + explicit selection.
    setSlot("eco-fast", RETIRED_ID);
    localStorage.setItem("eco-selected-model", RETIRED_ID);
    localStorage.setItem("eco-selected-model-explicit", "true");
    // Pre-condition: the raw slot really holds the retired id (getSlot nulls it).
    expect(readRawSlotIdForMigration("eco-fast")).toBe(RETIRED_ID);

    const report = await runSelfHeal({
      retiredMigrations: [migration],
      resolveEcoFastDefault: () => CATALOG_SMART,
      deleteCacheByName: () => Promise.resolve(),
    });

    expect(report.retiredModelMigrationsRun).toContain(RETIRED_ID);
    // Slot rebound to a live catalog model; nothing still names the retired id.
    expect(getSlot("eco-fast").modelId).toBe(CATALOG_SMART);
    expect(readRawSlotIdForMigration("eco-fast")).not.toBe(RETIRED_ID);
    // Persisted selection detoxed off the retired id and demoted to non-explicit.
    expect(localStorage.getItem("eco-selected-model")).toBe("eco-fast");
    expect(localStorage.getItem("eco-selected-model-explicit")).toBe("false");

    // Fresh chatStore hydration never resolves the retired id.
    vi.resetModules();
    const { useChatStore } = await import("../../stores/chatStore");
    const selected = useChatStore.getState().selectedModel;
    expect(selected).not.toBe(RETIRED_ID);
    expect(resolveSelectedModelId(selected)).not.toBe(RETIRED_ID);
  });
});
