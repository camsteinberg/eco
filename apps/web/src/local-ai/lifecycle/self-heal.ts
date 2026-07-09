// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Self-heal — boot-time cleanup.
 *
 * Runs once at app boot before any rendering. Cleans:
 *   1. Stale download-in-progress markers older than 5 minutes.
 *   2. Stale smoke-ready markers for models the user no longer has
 *      assigned to either slot.
 *   3. Cooldown records that have expired (timestamp-based; the
 *      lifecycle module owns the read/write).
 *   4. (Optional) Per-model storage cache verification for the
 *      currently-assigned slot models. Off by default — runs on demand
 *      when a slot transitions to 'error' so the user has a clean
 *      retry path.
 *
 * Migration: also calls into slots.ts's legacy-key reader, which
 * promotes legacy slot ids forward as a side effect.
 *
 * Never crashes app boot — every external call is wrapped. Returns a
 * structured report so callers can surface "cleaned up X stale items"
 * in the dev console for visibility.
 */

import { CacheApiStorage, type Storage } from '../download/storage';
import {
  SLOTS,
  getAllSlots,
  getLegacyKeyPrefixes,
  getSlot,
  setSlot,
  setSlotStatus,
  type KeyValueStorage as SlotStorage,
} from './slots';
import {
  FORMER_EVERYDAY_DEFAULT_IDS,
  recommend,
} from '../selection/recommend';
import { clearEvidence } from '../evidence/ledger';
import { getDeviceProfile } from '../device/profile';
import type { Slot } from '../types';

// ─── Constants ─────────────────────────────────────────────────────────────

const DOWNLOAD_IN_PROGRESS_PREFIX_NEW = 'eco-local-ai-download-in-progress-';
const DOWNLOAD_IN_PROGRESS_PREFIX_LEGACY = 'eco-model-download-in-progress:';
const SMOKE_READY_PREFIX_LEGACY = 'eco-local-model-smoke-ready-v1:';
const DOWNLOAD_MARKER_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * One-time artifact-swap migrations, marker-guarded per device.
 *
 * When a catalog model's artifact is replaced in place (same model id,
 * different weight files), two kinds of stale per-device state would
 * otherwise sabotage the NEW build:
 *   - ledger evidence recorded against the OLD build (a recent smoke-fail
 *     makes the confidence floor exclude the model — even though the new
 *     build removed the failure cause), and
 *   - the OLD weight files lingering as dead bytes in the model's cache
 *     namespace (the new file list never references them).
 * Clearing both once gives the new artifact a clean first attempt.
 *
 * 2026-07-01: lfm2.5-350m q4f16 → q4 (f16-free starter rung — instant-start
 * plan slice 1). The q4f16 build smoke-failed on f16-less adapters at an f16
 * op the q4 build does not contain.
 */
const ARTIFACT_SWAP_MIGRATIONS: ReadonlyArray<{ modelId: string; markerKey: string }> = [
  {
    modelId: 'candidate/lfm2.5-350m-onnx',
    markerKey: 'eco-local-ai-mig-350m-q4-v1',
  },
];

// ─── Report types ──────────────────────────────────────────────────────────

export type SelfHealReport = {
  staleDownloadMarkersCleared: number;
  staleSmokeMarkersCleared: number;
  legacySlotKeysMigrated: number;
  /** True when the eco-fast slot was rebound from a demoted former default
   *  (e.g. Bonsai) to the current preferred default. */
  staleDefaultSlotMigrated: boolean;
  /** Model ids whose stale evidence + cache were cleared this boot because
   *  their catalog artifact was replaced in place (marker-guarded, once per
   *  device per migration). */
  artifactMigrationsRun: string[];
  errors: string[];
};

// Note: cooldown expiry is NOT in this report because the cooldown system
// in runtime/lifecycle.ts auto-expires lazily — any call to getCooldown
// after the window passes clears the record as a side effect. There is
// nothing for self-heal to actively do at boot time.

export type SelfHealOptions = {
  /** Override clock for tests. */
  now?: () => number;
  /** Inject storage for tests. Defaults to globalThis.localStorage. */
  storage?: SlotStorage;
  /** Inject the download `Storage` for the artifact-swap cache clear. */
  cacheStorage?: Storage;
  /**
   * Test seam: resolve the device-appropriate everyday default for the
   * eco-fast slot. Defaults to `recommend('eco-fast', getDeviceProfile())`,
   * returning null if the profile is below the assignable floor (recommend
   * throws). The former-default slot migration rebinds to this value, so it is
   * always device-correct — on a low-memory device where Qwen3.5 isn't
   * assignable it returns LFM2.5 (the rebind then no-ops).
   */
  resolveEcoFastDefault?: () => string | null;
};

/** Local-only mirror of chatStore's explicit-selection flag key. A user who
 *  ever made a deliberate model choice is exempt from auto-migration — their
 *  pick (and its separate persisted selection) is honored verbatim, and we
 *  never trigger a surprise re-download for them. Canonical key owner:
 *  stores/chatStore.ts (SELECTED_MODEL_EXPLICIT_STORAGE_KEY). */
const SELECTED_MODEL_EXPLICIT_KEY = 'eco-selected-model-explicit';

/** True when the user has explicitly chosen a model (vs riding the auto-default).
 *  Auto-migration only touches the pure auto-default population. */
function hasExplicitModelChoice(storage: SlotStorage): boolean {
  try {
    return storage.getItem(SELECTED_MODEL_EXPLICIT_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Default resolver: the real device-appropriate eco-fast default. Wrapped so a
 *  below-floor profile (recommend throws NoAssignableModelError) yields null
 *  rather than aborting boot. */
function defaultResolveEcoFastDefault(): string | null {
  try {
    return recommend('eco-fast', getDeviceProfile()).id;
  } catch {
    return null;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function runSelfHeal(options?: SelfHealOptions): Promise<SelfHealReport> {
  const now = options?.now ?? (() => Date.now());
  const storage = options?.storage ?? defaultSlotStorage();

  const report: SelfHealReport = {
    staleDownloadMarkersCleared: 0,
    staleSmokeMarkersCleared: 0,
    legacySlotKeysMigrated: 0,
    staleDefaultSlotMigrated: false,
    artifactMigrationsRun: [],
    errors: [],
  };

  if (!storage) {
    // No browser storage (SSR or restricted environments). Nothing to do.
    return report;
  }

  // -1. Artifact-swap evidence migration. MUST run before the former-default
  //     rebind below: that step resolves `recommend(...)`, which reads the
  //     evidence ledger — stale rows have to be gone by then. The marker is
  //     written only after a fully successful clear, so a failed attempt
  //     retries on the next boot.
  //
  //     Deliberately NO hasExplicitModelChoice() exemption (unlike step 0):
  //     this migration never rebinds anyone's pick — it refreshes the
  //     artifact behind the SAME id. An explicit chooser's old cache is dead
  //     bytes either way (the new file plan never references it), so the
  //     clean re-download here is strictly better than the implicit worker
  //     fetch they would otherwise hit on their next message.
  //
  //     Storage note: the marker uses the injected `storage` seam while
  //     clearEvidence() writes the global localStorage ledger — in production
  //     both are the same localStorage (the ledger module is global-only by
  //     design across the codebase).
  for (const migration of ARTIFACT_SWAP_MIGRATIONS) {
    try {
      if (storage.getItem(migration.markerKey) !== null) continue;
      clearEvidence(migration.modelId);
      // The cache wipe is best-effort dead-bytes cleanup: environments without
      // the Cache API (SSR, restricted contexts) have no cached weights to
      // clear, so the evidence clear alone completes the migration there.
      const cacheStorage = options?.cacheStorage
        ?? (typeof caches !== 'undefined' ? new CacheApiStorage() : null);
      if (cacheStorage) await cacheStorage.clearModel(migration.modelId);
      // A slot bound to the migrated model and marked 'ready' now points at an
      // empty cache. Flip it to 'preparing' so the setup pipeline re-fetches
      // the new artifact through the full download path (progress UI, headroom
      // preflight). Without this the slot stays 'ready' forever: reconcile
      // skips fully-missing files (nothing to "repair"), and the first message
      // would fall into the worker's implicit remote fetch instead.
      const slotState = getAllSlots();
      for (const slot of SLOTS) {
        if (slotState[slot].modelId === migration.modelId && slotState[slot].status === 'ready') {
          setSlotStatus(slot, 'preparing');
        }
      }
      storage.setItem(migration.markerKey, String(now()));
      report.artifactMigrationsRun.push(migration.modelId);
    } catch (err) {
      report.errors.push(`artifact-migration(${migration.modelId}): ${describe(err)}`);
    }
  }

  // 0. Former-default slot migration: an eco-fast slot still bound to a model
  //    that was once the everyday default (Bonsai, or LFM2.5 after the
  //    2026-06-13 everyday-swap) belongs to a profile primed before a default
  //    graduation — the binding was written by the old setup flow, not chosen
  //    by the user, and nothing else ever refreshes it (observed live
  //    2026-06-10: a pre-graduation profile still routed to Bonsai five days
  //    after LFM2.5 shipped as default).
  //
  //    Rebind to the CURRENT device-appropriate default and mark 'preparing'
  //    so the readiness pipeline verifies (and downloads if needed) before
  //    first use. Two guards keep this correct and unsurprising:
  //      - Device-aware: the target is `recommend('eco-fast', profile)`, not a
  //        fixed constant. On a low-memory device the recommendation is still
  //        LFM2.5, so rebinding LFM2.5→target no-ops (target === bound). This
  //        is why LFM2.5 can sit in FORMER_EVERYDAY_DEFAULT_IDS without
  //        stranding low-end devices on an unassignable Qwen3.5.
  //      - Explicit-choice exempt: a user who ever picked a model deliberately
  //        is left untouched (their pick persists separately and is honored
  //        verbatim by the chat store; auto-migration is only for the
  //        auto-default population, and never triggers a surprise re-download).
  //    Runs BEFORE the stale-smoke sweep so the old model's smoke marker is
  //    cleaned up in the same boot.
  try {
    const fast = getSlot('eco-fast');
    if (
      fast.modelId
      && FORMER_EVERYDAY_DEFAULT_IDS.includes(fast.modelId)
      && !hasExplicitModelChoice(storage)
    ) {
      const target = (options?.resolveEcoFastDefault ?? defaultResolveEcoFastDefault)();
      if (target && target !== fast.modelId) {
        setSlot('eco-fast', target);
        setSlotStatus('eco-fast', 'preparing');
        report.staleDefaultSlotMigrated = true;
      }
    }
  } catch (err) {
    report.errors.push(`stale-default-slot: ${describe(err)}`);
  }

  // 1. Stale download-in-progress markers.
  try {
    const removed = clearStaleDownloadMarkers(storage, now());
    report.staleDownloadMarkersCleared = removed;
  } catch (err) {
    report.errors.push(`download-markers: ${describe(err)}`);
  }

  // 2. Stale smoke markers for models no longer assigned.
  try {
    const assigned = new Set<string>();
    const slotState = getAllSlots();
    for (const slot of SLOTS) {
      const id = slotState[slot].modelId;
      if (id) assigned.add(id);
    }
    const removed = clearStaleSmokeMarkers(storage, assigned);
    report.staleSmokeMarkersCleared = removed;
  } catch (err) {
    report.errors.push(`smoke-markers: ${describe(err)}`);
  }

  // 3. Legacy slot key migration count. We deliberately don't read the new
  //    key directly — Invariant 3 reserves that to lifecycle/slots.ts.
  //    Instead, we compare the legacy value against the slots-API result
  //    for the same slot; a match means a migration occurred (either now
  //    or in some prior boot).
  try {
    const slotState = getAllSlots();
    let migrated = 0;
    for (const slot of SLOTS) {
      const newVal = slotState[slot].modelId;
      if (!newVal) continue;
      for (const prefix of getLegacyKeyPrefixes()) {
        const legacyVal = storage.getItem(prefix + slot);
        if (legacyVal === newVal) migrated++;
      }
    }
    report.legacySlotKeysMigrated = migrated;
  } catch (err) {
    report.errors.push(`legacy-migration: ${describe(err)}`);
  }

  return report;
}

/**
 * On-demand: verify the cache integrity for one model's files. Called
 * when a slot has transitioned to 'error' so we can clean corrupted
 * entries and let the user retry from a known-good state.
 */
export async function repairModelCache(
  modelId: string,
  files: ReadonlyArray<{ url: string; sizeBytes: number }>,
  options?: { storage?: Storage },
): Promise<{ removed: number }> {
  const storage = options?.storage ?? new CacheApiStorage();
  let removed = 0;
  for (const file of files) {
    try {
      const verified = await storage.verify({ modelId, url: file.url }, file.sizeBytes);
      if (verified) continue;
      const exists = await storage.has({ modelId, url: file.url });
      if (!exists) continue;
      await storage.remove({ modelId, url: file.url });
      removed++;
    } catch {
      // Best-effort; storage layer's own self-heal will eventually
      // catch any entries we miss.
    }
  }
  return { removed };
}

// ─── Boot-time slot reconciliation ─────────────────────────────────────────

/**
 * Plan resolver for a single model — produces the file list the model
 * needs. Returns null when the model isn't downloadable (caller should
 * skip rather than treat as an error). The boot path wires this to the
 * same resolver used by `downloadModel()`.
 */
export type SlotPlanResolver = (
  modelId: string,
) => Promise<ReadonlyArray<{ url: string; sizeBytes: number }> | null>;

export type ReconcileReport = {
  /** Slots whose status was flipped from 'ready' to 'preparing' because
   *  their model's cache failed verification. */
  slotsFlippedToPreparing: Slot[];
  /** Per-model details: which files were removed because they didn't
   *  match the plan's declared sizes. */
  modelsRepaired: Array<{ modelId: string; removed: number }>;
  /** Non-fatal errors during reconciliation. */
  errors: string[];
};

export type ReconcileOptions = {
  cacheStorage?: Storage;
  /** Test seam — defaults to the slots.setSlotStatus production fn. */
  setStatus?: (slot: Slot, status: 'preparing') => void;
  /** Called once per repaired model — the consumer wires a sessionStorage
   *  hint so the UI can surface a one-time "we cleaned up your cache"
   *  message. Optional. */
  onCacheRepaired?: (info: { modelId: string; slot: Slot; removed: number }) => void;
};

/**
 * Reconcile every slot marked 'ready' against the actual cache state.
 *
 * For each ready slot:
 *   1. Resolve the model's file plan via `planResolver`.
 *   2. Run `repairModelCache` — removes any file whose stored byte size
 *      doesn't match the plan's declared size (Bug #4 detection).
 *   3. If anything was removed, flip the slot to 'preparing' so the
 *      consumer's setup pipeline can re-fetch the missing files cleanly.
 *
 * Closes the L3-03 wiring loop: `repairModelCache` previously existed
 * but wasn't called from boot, so a slot marked 'ready' could silently
 * reference corrupted cache and surface chat failures at first generate
 * instead.
 *
 * Idempotent — calling twice in succession is safe; the second call
 * sees the new 'preparing' status and skips.
 */
export async function reconcileReadySlots(
  planResolver: SlotPlanResolver,
  options?: ReconcileOptions,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    slotsFlippedToPreparing: [],
    modelsRepaired: [],
    errors: [],
  };

  const cacheStorage = options?.cacheStorage ?? new CacheApiStorage();
  const setStatus = options?.setStatus ?? setSlotStatus;

  const slotState = getAllSlots();
  for (const slot of SLOTS) {
    const state = slotState[slot];
    if (state.status !== 'ready' || !state.modelId) continue;

    let files: ReadonlyArray<{ url: string; sizeBytes: number }> | null = null;
    try {
      files = await planResolver(state.modelId);
    } catch (err) {
      report.errors.push(`plan-resolver(${state.modelId}): ${describe(err)}`);
      continue;
    }
    if (!files || files.length === 0) continue;

    let removed = 0;
    try {
      const result = await repairModelCache(state.modelId, files, {
        storage: cacheStorage,
      });
      removed = result.removed;
    } catch (err) {
      report.errors.push(`repair(${state.modelId}): ${describe(err)}`);
      continue;
    }

    if (removed > 0) {
      report.modelsRepaired.push({ modelId: state.modelId, removed });
      try {
        setStatus(slot, 'preparing');
        report.slotsFlippedToPreparing.push(slot);
        options?.onCacheRepaired?.({ modelId: state.modelId, slot, removed });
      } catch (err) {
        report.errors.push(`set-status(${slot}): ${describe(err)}`);
      }
    }
  }

  return report;
}

// ─── Internals ─────────────────────────────────────────────────────────────

function defaultSlotStorage(): SlotStorage | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as { localStorage?: SlotStorage };
  return g.localStorage ?? null;
}

function clearStaleDownloadMarkers(storage: SlotStorage, nowMs: number): number {
  let removed = 0;
  // localStorage doesn't expose iteration via SlotStorage's narrow shape.
  // Reach for the global Storage interface if it's available — it's the
  // only practical way to scan keys. Wrapped in a try because some
  // environments restrict iteration.
  const browserLike = storage as SlotStorage & { length?: number; key?: (i: number) => string | null };
  if (typeof browserLike.length !== 'number' || typeof browserLike.key !== 'function') {
    return removed;
  }

  const keysToCheck: string[] = [];
  for (let i = 0; i < browserLike.length; i++) {
    const k = browserLike.key(i);
    if (!k) continue;
    if (
      k.startsWith(DOWNLOAD_IN_PROGRESS_PREFIX_NEW)
      || k.startsWith(DOWNLOAD_IN_PROGRESS_PREFIX_LEGACY)
    ) {
      keysToCheck.push(k);
    }
  }

  for (const k of keysToCheck) {
    const raw = storage.getItem(k);
    if (!raw) {
      storage.removeItem(k);
      removed++;
      continue;
    }
    // Marker value is either a unix timestamp or JSON with { startedAt }.
    const startedAt = parseTimestamp(raw);
    if (startedAt === null || nowMs - startedAt > DOWNLOAD_MARKER_MAX_AGE_MS) {
      storage.removeItem(k);
      removed++;
    }
  }
  return removed;
}

function clearStaleSmokeMarkers(
  storage: SlotStorage,
  assigned: ReadonlySet<string>,
): number {
  let removed = 0;
  const browserLike = storage as SlotStorage & { length?: number; key?: (i: number) => string | null };
  if (typeof browserLike.length !== 'number' || typeof browserLike.key !== 'function') {
    return removed;
  }
  const keysToCheck: string[] = [];
  for (let i = 0; i < browserLike.length; i++) {
    const k = browserLike.key(i);
    if (!k) continue;
    if (k.startsWith(SMOKE_READY_PREFIX_LEGACY)) keysToCheck.push(k);
  }
  for (const k of keysToCheck) {
    const modelId = k.slice(SMOKE_READY_PREFIX_LEGACY.length);
    if (!assigned.has(modelId)) {
      storage.removeItem(k);
      removed++;
    }
  }
  return removed;
}

function parseTimestamp(raw: string): number | null {
  // Try JSON first.
  try {
    const parsed = JSON.parse(raw) as { startedAt?: unknown };
    if (typeof parsed?.startedAt === 'number') return parsed.startedAt;
  } catch {
    // Fall through.
  }
  // Plain numeric.
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
