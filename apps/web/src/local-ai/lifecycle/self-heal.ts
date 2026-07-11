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
  clearSlot,
  getAllSlots,
  getLegacyKeyPrefixes,
  getSlot,
  readRawSlotIdForMigration,
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
import { getActiveLocalHeavyWorkLease } from '../../lib/local-heavy-work-owner';
import { isCacheVerificationForced } from '../../lib/validation-harness';
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

/**
 * A model that has been RETIRED from the catalog and needs a one-time,
 * per-device cleanup of the state a live catalog id would otherwise own.
 *
 * Removing a catalog entry is not enough on its own: a user primed on the
 * retired model still holds orphaned weight bytes, stale evidence rows, a slot
 * bound to the id, a persisted `eco-selected-model`, and possibly a pending
 * upgrade record — none of which the ordinary boot path cleans, because the id
 * no longer resolves. This migration purges all of it and, when the user was
 * actually running the model, leaves a one-time hint so the UI can explain the
 * switch honestly.
 */
export type RetiredModelMigration = {
  /** The retired catalog id (must already be REMOVED from catalog-data.json). */
  modelId: string;
  /** Human name for the retired model — the catalog entry is gone, so the
   *  notice surface reads the name from here. */
  friendlyLabel: string;
  /** Once-per-device marker key. Written LAST, only after a fully successful
   *  migration, so a thrown step retries on the next boot. */
  markerKey: string;
  /** VERBATIM Cache API cache names for a retired runtime's own private caches
   *  (e.g. WebLLM's 'webllm/model' | 'webllm/config' | 'webllm/wasm'), disjoint
   *  from Eco's own 'eco-local-ai-<id>' namespace. These are exact names, NOT
   *  prefixes — nothing else is ever deleted. */
  extraCacheNames?: readonly string[];
};

/**
 * Retired-model migrations. A real entry MUST land in the same commit that
 * removes the model from the catalog, so the migration never runs against a
 * live catalog id.
 *
 * 2026-07-10: SmolLM2 (`local/smollm2-1.7b-webllm-q4f16`) — the sole model on
 * the retired WebLLM/MLC runtime. Its weights lived in Eco's own
 * `eco-local-ai-<id>` namespace AND in WebLLM's private Cache API caches
 * ('webllm/model' | 'webllm/config' | 'webllm/wasm', the lib's default cache
 * backend), which are disjoint from Eco's namespace and must be named
 * explicitly to be purged.
 */
const RETIRED_MODEL_MIGRATIONS: ReadonlyArray<RetiredModelMigration> = [
  {
    modelId: 'local/smollm2-1.7b-webllm-q4f16',
    friendlyLabel: 'SmolLM2',
    markerKey: 'eco-local-ai-mig-retire-smollm2-v1',
    extraCacheNames: ['webllm/model', 'webllm/config', 'webllm/wasm'],
  },
];

/** Canonical owner: stores/chatStore.ts (SELECTED_MODEL_STORAGE_KEY). */
const SELECTED_MODEL_KEY = 'eco-selected-model';
/** Canonical owner: local-ai/lifecycle/upgrade.ts (UPGRADE_STORAGE_KEY). */
const UPGRADE_RECORD_KEY = 'eco-local-ai-upgrade-v1';
/** One-time hint the RetiredModelNotice consumer reads+removes on mount to fire
 *  the "your model was retired" toast. localStorage (not sessionStorage) so it
 *  survives to a later session where the consumer actually mounts. */
const RETIRED_MODEL_NOTICE_HINT_KEY = 'eco-local-ai-retired-notice-v1';

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
  /** Retired-model ids whose one-time cleanup migration ran this boot
   *  (marker-guarded, once per device per migration). */
  retiredModelMigrationsRun: string[];
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
  /**
   * Test seam: sweep expired heavy-work leases. Defaults to
   * `getActiveLocalHeavyWorkLease`, whose read clears an expired lease in BOTH
   * mutual-exclusion domains (runtime + download) as a side effect. Only
   * EXPIRED leases are swept — a live lease is left untouched, because ownerId
   * cannot distinguish a dead session from a live other tab and the cross-tab
   * single-download invariant depends on live leases surviving.
   */
  sweepExpiredLeases?: () => void;
  /**
   * Test seam: the retired-model migrations to run. Defaults to the module
   * const `RETIRED_MODEL_MIGRATIONS`. Tests inject synthetic entries so the
   * mechanism can be exercised without a real catalog removal.
   */
  retiredMigrations?: ReadonlyArray<RetiredModelMigration>;
  /**
   * Test seam: delete a Cache API cache by its VERBATIM name. Defaults to
   * `caches.delete` (a no-op when the Cache API is unavailable, e.g. SSR). The
   * retirement migration uses this to purge a retired runtime's private caches,
   * whose names are disjoint from Eco's own 'eco-local-ai-<id>' namespace.
   */
  deleteCacheByName?: (name: string) => Promise<void>;
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

/** Default cache-name delete: the global Cache API, or a no-op where it's absent
 *  (SSR / restricted contexts have no caches to purge). */
async function defaultDeleteCacheByName(name: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.delete(name).catch(() => false);
}

/**
 * Run one retired-model migration. Each sub-step is individually idempotent so
 * a partial failure is safe to retry; the caller writes the marker only after
 * this resolves without throwing.
 *
 * NOT explicit-choice exempt (unlike the former-default rebind in step 0): a
 * retired pick simply cannot be honored — the model is gone from the catalog,
 * so there is nothing to load. This is the sanctioned exception to the L8
 * "never re-recommend over an explicit pick" rule; the honest recovery is to
 * rebind to the current recommendation and tell the user via the notice.
 */
async function runRetiredModelMigration(
  migration: RetiredModelMigration,
  storage: SlotStorage,
  options: SelfHealOptions | undefined,
  now: () => number,
  resolveEcoFastDefault: () => string | null,
): Promise<void> {
  const { modelId } = migration;

  // Capture "was the user actually ON this model?" BEFORE any detox mutates it,
  // and do it SELECTION-AWARE: an explicit pick of the retired id, OR riding a
  // slot's default while THAT slot held it. A slot that merely held the retired
  // id while the user was actually on the OTHER slot does NOT warrant the notice
  // (the "the model you were using" copy would be inaccurate) — its detox still
  // runs, just silently. `eco-selected-model` reads null / 'auto' / 'eco-fast'
  // when riding the fast (default) slot, and 'eco-smart' when riding the smart
  // slot; anything else is an explicit id.
  const selectedRaw = safeGetItem(storage, SELECTED_MODEL_KEY);
  const fastRaw = readRawSlotIdForMigration('eco-fast');
  const smartRaw = readRawSlotIdForMigration('eco-smart');
  const rodeFastDefault =
    (selectedRaw === null || selectedRaw === 'auto' || selectedRaw === 'eco-fast')
    && fastRaw === modelId;
  const rodeSmartDefault = selectedRaw === 'eco-smart' && smartRaw === modelId;
  const wasOnRetiredModel = selectedRaw === modelId || rodeFastDefault || rodeSmartDefault;

  // 1. Purge weight bytes, stale evidence, and the retired runtime's own caches.
  clearEvidence(modelId);
  const cacheStorage = options?.cacheStorage
    ?? (typeof caches !== 'undefined' ? new CacheApiStorage() : null);
  if (cacheStorage) await cacheStorage.clearModel(modelId);
  if (migration.extraCacheNames && migration.extraCacheNames.length > 0) {
    const deleteCacheByName = options?.deleteCacheByName ?? defaultDeleteCacheByName;
    for (const name of migration.extraCacheNames) {
      await deleteCacheByName(name);
    }
  }

  // 2. Slot detox. eco-fast rebinds to the device-appropriate default (setSlot
  //    forces 'preparing' on the id change, so the readiness pipeline downloads
  //    it before first use); below the assignable floor (resolver null) the dead
  //    binding is dropped so the consumer re-recommends from empty. eco-smart is
  //    cleared, never rebound — nothing drives an undriven 'preparing' smart
  //    slot; the upgrade machine re-offers a smart model later.
  if (fastRaw === modelId) {
    const target = resolveEcoFastDefault();
    if (target && target !== modelId) {
      setSlot('eco-fast', target);
    } else {
      clearSlot('eco-fast');
    }
  }
  if (smartRaw === modelId) {
    clearSlot('eco-smart');
  }

  // 3. chatStore selection detox: a persisted selection of the retired id
  //    degrades to the 'eco-fast' auto-slot, and the explicit flag is demoted so
  //    downstream never treats the (impossible) retired pick as deliberate.
  if (selectedRaw === modelId) {
    storage.setItem(SELECTED_MODEL_KEY, 'eco-fast');
    storage.setItem(SELECTED_MODEL_EXPLICIT_KEY, 'false');
  }

  // 4. Upgrade-offer detox: drop a pending upgrade record that targets (or was
  //    based on) the retired id, so the machine can't try to carry the device
  //    to a model that no longer exists.
  const upgradeRaw = safeGetItem(storage, UPGRADE_RECORD_KEY);
  if (upgradeRaw) {
    let record: { targetModelId?: unknown; baseModelId?: unknown } | null = null;
    try {
      record = JSON.parse(upgradeRaw) as { targetModelId?: unknown; baseModelId?: unknown };
    } catch {
      record = null;
    }
    if (record && (record.targetModelId === modelId || record.baseModelId === modelId)) {
      storage.removeItem(UPGRADE_RECORD_KEY);
    }
  }

  // 5. Notice hint — one-time, only when the user was actually on the model.
  if (wasOnRetiredModel) {
    storage.setItem(
      RETIRED_MODEL_NOTICE_HINT_KEY,
      JSON.stringify({ label: migration.friendlyLabel, at: now() }),
    );
  }
}

function safeGetItem(storage: SlotStorage, key: string): string | null {
  try {
    return storage.getItem(key);
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
    retiredModelMigrationsRun: [],
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
      // empty cache. Flip it to 'preparing' here — proactively, the instant we
      // wipe — so the setup pipeline re-fetches the new artifact through the
      // full download path (progress UI, headroom preflight). Boot reconcile
      // would now catch this too (it flips 'ready'→'preparing' on wholly-missing
      // files), but this migration already KNOWS the cache is gone, so it flips
      // immediately rather than waiting on reconcile's per-file verification.
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

  // -0.5. Retired-model migrations. MUST run AFTER the artifact-swap block above
  //       and BEFORE the former-default rebind below: the rebind reads slots and
  //       calls recommend(), so a slot still bound to a retired id has to be
  //       rebound/cleared first (otherwise the rebind operates on a dead id).
  //       Marker-guarded per device; the marker is written LAST, only after a
  //       fully successful migration, so a thrown step retries next boot with no
  //       marker written and no half-applied state trusted.
  const resolveEcoFastDefault = options?.resolveEcoFastDefault ?? defaultResolveEcoFastDefault;
  for (const migration of options?.retiredMigrations ?? RETIRED_MODEL_MIGRATIONS) {
    try {
      if (storage.getItem(migration.markerKey) !== null) continue;
      await runRetiredModelMigration(migration, storage, options, now, resolveEcoFastDefault);
      storage.setItem(migration.markerKey, String(now()));
      report.retiredModelMigrationsRun.push(migration.modelId);
    } catch (err) {
      report.errors.push(`retired-migration(${migration.modelId}): ${describe(err)}`);
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

  // 4. Expired-lease sweep. A tab that crashed mid-download/switch can leave a
  //    heavy-work lease behind; it self-expires by `expiresAt`, but the read
  //    below is what actually clears it (both the runtime and download domains
  //    in one call). We only READ — never force-clear a live lease, since a
  //    still-valid lease may belong to a live other tab, and the single-download
  //    invariant relies on it. Best-effort; a failure must not crash boot.
  try {
    (options?.sweepExpiredLeases ?? getActiveLocalHeavyWorkLease)();
  } catch (err) {
    report.errors.push(`lease-sweep: ${describe(err)}`);
  }

  return report;
}

/**
 * On-demand: verify the cache integrity for one model's files. Called
 * when a slot has transitioned to 'error' so we can clean corrupted
 * entries and let the user retry from a known-good state.
 *
 * Reports two distinct counts so the caller can act honestly:
 *   - `removed`: files that were present but failed verify (size mismatch /
 *     corruption) and were deleted.
 *   - `missing`: files that are wholly absent (verify failed AND has() is
 *     definitively false). NOTHING is deleted for a missing file — there is
 *     nothing to remove; the caller flips the slot to 'preparing' so the
 *     download pipeline re-fetches it. This is the interrupted-download case:
 *     the slot must not stay 'ready' on bytes that were never fully written.
 * Per-file storage errors stay best-effort (caught, skipped) and count as
 * neither — we can't prove such a file is gone.
 */
export async function repairModelCache(
  modelId: string,
  files: ReadonlyArray<{ url: string; sizeBytes: number }>,
  options?: { storage?: Storage },
): Promise<{ removed: number; missing: number }> {
  const storage = options?.storage ?? new CacheApiStorage();
  let removed = 0;
  let missing = 0;
  for (const file of files) {
    try {
      const verified = await storage.verify({ modelId, url: file.url }, file.sizeBytes);
      if (verified) continue;
      const exists = await storage.has({ modelId, url: file.url });
      if (!exists) {
        missing++;
        continue;
      }
      await storage.remove({ modelId, url: file.url });
      removed++;
    } catch {
      // Best-effort; storage layer's own self-heal will eventually
      // catch any entries we miss.
    }
  }
  return { removed, missing };
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
   *  their model's cache failed verification (files removed) OR was found
   *  wholly missing (interrupted download). */
  slotsFlippedToPreparing: Slot[];
  /** Per-model details: `removed` files deleted for a size mismatch, and
   *  `missing` files found wholly absent. A slot flips when either is > 0. */
  modelsRepaired: Array<{ modelId: string; removed: number; missing: number }>;
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
  /** Harness-only seam: when true, skip boot cache reconciliation entirely.
   *  Defaults to the validation-harness helper (`isCacheVerificationForced`),
   *  which is ALWAYS false on production hosts. Exists because e2e fixtures
   *  prime 'ready' slots via localStorage without writing real cache bytes — the
   *  wholly-missing-file flip below would otherwise (correctly, but unhelpfully)
   *  demote those fixture slots to 'preparing' and break the pre-seeded-ready
   *  convention their faked generation depends on. */
  isCacheVerificationForced?: () => boolean;
};

/**
 * Reconcile every slot marked 'ready' against the actual cache state.
 *
 * For each ready slot:
 *   1. Resolve the model's file plan via `planResolver`.
 *   2. Run `repairModelCache` — removes any file whose stored byte size
 *      doesn't match the plan's declared size (Bug #4 detection), and reports
 *      any file found wholly missing (an interrupted download the reload left
 *      the slot falsely 'ready' on).
 *   3. If anything was removed OR any file was missing, flip the slot to
 *      'preparing' so the consumer's setup pipeline re-fetches cleanly. The
 *      onCacheRepaired hint fires only when files were actually removed — a
 *      wholly-missing file was never there to "clean up," so that copy would
 *      be untruthful.
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

  // Harness-only escape hatch: e2e fixtures prime 'ready' slots with no cache
  // bytes by design (generation is faked), so the missing-file flip below would
  // wrongly demote them. Skip the whole pass when forced. Production is
  // unaffected — the seam is gated by isValidationHarnessEnabled().
  const cacheVerificationForced = options?.isCacheVerificationForced ?? isCacheVerificationForced;
  if (cacheVerificationForced()) {
    return report;
  }

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
    let missing = 0;
    try {
      const result = await repairModelCache(state.modelId, files, {
        storage: cacheStorage,
      });
      removed = result.removed;
      missing = result.missing;
    } catch (err) {
      report.errors.push(`repair(${state.modelId}): ${describe(err)}`);
      continue;
    }

    if (removed > 0 || missing > 0) {
      report.modelsRepaired.push({ modelId: state.modelId, removed, missing });
      try {
        setStatus(slot, 'preparing');
        report.slotsFlippedToPreparing.push(slot);
        // Only fire the "we cleaned up your cache" hint when bytes were actually
        // removed — a wholly-missing file was never present to clean up, so the
        // honest recovery is a silent re-download, not a cleanup notice.
        if (removed > 0) {
          options?.onCacheRepaired?.({ modelId: state.modelId, slot, removed });
        }
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
