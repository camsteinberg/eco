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

import { CacheApiStorage, modelCacheName, type Storage } from '../download/storage';
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
import { clearEvidence, hasRecentSuccess } from '../evidence/ledger';
import { getCatalog, getModel } from '../catalog/catalog';
import { getDeviceProfile } from '../device/profile';
import { isWebKitMobile, requiresWebKitMobile, WEBKIT_MOBILE_VALIDATED_MODEL_IDS } from '../device/compatibility';
import type { DeviceProfile, ModelConfig } from '../types';
import {
  getActiveLocalDownloadLease,
  getActiveLocalHeavyWorkLease,
} from '../../lib/local-heavy-work-owner';
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
 *
 * 2026-07-17: qwen3-0.6b single-file q4f16 → external-data pair (A-3
 * load-transient fix). Same q4f16 weights repacked as model_q4f16.onnx +
 * model_q4f16.onnx_data; the external-data shape skips the in-heap model
 * staging copy at ORT session create, eliminating the ~2s load spike that
 * killed WebKit-mobile. Old single-file bytes must be purged and evidence
 * cleared so the new build gets a clean re-smoke.
 */
const ARTIFACT_SWAP_MIGRATIONS: ReadonlyArray<{ modelId: string; markerKey: string }> = [
  {
    modelId: 'candidate/lfm2.5-350m-onnx',
    markerKey: 'eco-local-ai-mig-350m-q4-v1',
  },
  {
    modelId: 'local/qwen3-0.6b',
    markerKey: 'eco-local-ai-mig-qwen3-0.6b-xd-v1',
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
 *
 * 2026-07-11: Bonsai (`local/bonsai-1.7b-q4`) — the dev-era former everyday
 * default, quality-demoted and loop-prone; its f16-less WebGPU floor role is
 * now served by Gemma 4 E2B (LiteRT). It ran on Transformers.js with the
 * default Cache API storage, so its bytes live entirely in the
 * `eco-local-ai-<id>` namespace — no extraCacheNames needed (the migration's
 * default clearModel purge is sufficient).
 */
const RETIRED_MODEL_MIGRATIONS: ReadonlyArray<RetiredModelMigration> = [
  {
    modelId: 'local/smollm2-1.7b-webllm-q4f16',
    friendlyLabel: 'SmolLM2',
    markerKey: 'eco-local-ai-mig-retire-smollm2-v1',
    extraCacheNames: ['webllm/model', 'webllm/config', 'webllm/wasm'],
  },
  {
    modelId: 'local/bonsai-1.7b-q4',
    friendlyLabel: 'Bonsai',
    markerKey: 'eco-local-ai-mig-retire-bonsai-v1',
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
/** Window event announcing a freshly written notice hint. The consumer mounts
 *  BEFORE this async self-heal step runs, so without the event its mount-time
 *  read would surface the toast one session late. Mirror reader:
 *  components/local-ai/RetiredModelNotice.tsx. */
const RETIRED_MODEL_NOTICE_EVENT = 'eco-local-ai-retired-notice';

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
  /** Slots demoted this boot because the device is iOS WebKit and the bound
   *  model is not on the WebKit-mobile validated list — cleared so the next
   *  setup run re-enters recommend → below-floor instead of resuming a load
   *  that crash-loops the tab. */
  webkitMobileSlotsRegated: Slot[];
  /** Slots cleared this boot because the bound model is scoped to a device
   *  class this device is not (today: an iOS-only model bound on desktop).
   *  Selection would never pick it here, but nothing else re-checks a binding
   *  that already exists — and every state surface reads the binding as truth. */
  incompatibleSlotsRegated: Slot[];
  /** Cache namespace names cleared this boot because the catalog can no longer
   *  offer the model AND no slot or in-flight download referenced it — the
   *  model is unreachable, so its weight bytes are dead. */
  deadModelCachesSwept: string[];
  /** Count of orphaned chunk-part entries swept from unbound, not-mid-download
   *  catalog models this boot — abandoned/interrupted resume bytes that no
   *  parts-native manifest claims. Terminal parts-native bytes are never here. */
  orphanedPartsSwept: number;
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
  /**
   * Test seam: the device profile for the WebKit-mobile re-gate step. Defaults
   * to the sync `getDeviceProfile()`. Injected in tests so the re-gate can be
   * exercised for an iOS-WebKit profile without spoofing navigator/URL params.
   */
  resolveDeviceProfile?: () => DeviceProfile;
  /**
   * Test seam: the current catalog's model ids. Defaults to `getCatalog()`.
   * The dead-bytes sweep keeps every namespace whose id is in this set — the
   * catalog is the source of truth for what remains reachable.
   */
  resolveCatalogIds?: () => readonly string[];
  /**
   * Test seam: enumerate Eco's per-model Cache API namespace names
   * (`eco-local-ai-<id>`). Defaults to the injected/real cache storage's
   * `listModelCacheNames` (empty where the Cache API is unavailable). The
   * dead-bytes sweep compares these against the keep-set of catalog / bound /
   * in-flight namespaces.
   */
  listModelCacheNames?: () => Promise<string[]>;
  /**
   * Test seam: whether a heavy download is active right now (possibly in
   * another tab). Defaults to the download-domain lease probe. When true the
   * orphaned-parts sweep is skipped wholesale — an in-flight download's resume
   * parts must never be swept, and a lease cannot be attributed to one model id.
   */
  hasActiveDownloadLease?: () => boolean;
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
 *  (SSR / restricted contexts have no caches to purge). A rejection is NOT
 *  swallowed — it propagates to the migration runner's try/catch so a failed
 *  purge blocks the marker (marker written LAST, only on full success), exactly
 *  as a failing clearModel does. */
async function defaultDeleteCacheByName(name: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.delete(name);
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
  // Also drop LEGACY slot keys still naming the retired id (walked 2026-07-11:
  // the rebind writes only the canonical key, which shadows a legacy value —
  // safe by construction, but a cleanup migration must not leave the retired
  // id lying in storage).
  for (const slot of SLOTS) {
    for (const prefix of getLegacyKeyPrefixes()) {
      const legacyKey = prefix + slot;
      if (safeGetItem(storage, legacyKey) === modelId) {
        storage.removeItem(legacyKey);
      }
    }
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
  //    Also announced via a window event: the RetiredModelNotice consumer mounts
  //    before this async migration runs, so its mount-time read alone would
  //    surface the toast one session late. The localStorage hint stays the
  //    source of truth for sessions where the consumer mounts later.
  if (wasOnRetiredModel) {
    storage.setItem(
      RETIRED_MODEL_NOTICE_HINT_KEY,
      JSON.stringify({ label: migration.friendlyLabel, at: now() }),
    );
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(RETIRED_MODEL_NOTICE_EVENT));
    }
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
    webkitMobileSlotsRegated: [],
    incompatibleSlotsRegated: [],
    deadModelCachesSwept: [],
    orphanedPartsSwept: 0,
    errors: [],
  };

  if (!storage) {
    // No browser storage (SSR or restricted environments). Nothing to do.
    return report;
  }

  // -2. WebKit-mobile re-gate. A device primed BEFORE the WebKit-mobile gate
  //     shipped (the founder's iPhone was bound during the pre-gate crash-loop
  //     spike; prod still serves that population) holds a slot bound to a model
  //     that crash-loops the tab on load. Nothing else re-checks it: boot
  //     reconcile only flips 'ready'→'preparing' on missing bytes, and a
  //     'preparing' slot with cached partial bytes RESUMES the doomed load. So
  //     re-gate here: on iOS WebKit, clear any slot bound to a model NOT on the
  //     validated list (both slots), and drop its download-in-progress marker so
  //     nothing resumes. The next setup run then re-enters recommend →
  //     NoAssignableModelError → the designed mobile handoff surface. Cached
  //     model BYTES are left alone — harmless dead weight that reconcile/repair
  //     owns; this step only touches the slot binding + resume markers.
  //
  //     Runs FIRST (before the former-default rebind and marker sweeps) so a
  //     cleared slot is already empty when those steps read it. No-op on every
  //     non-WebKit-mobile profile. Never crashes boot (wrapped).
  try {
    const profile = (options?.resolveDeviceProfile ?? getDeviceProfile)();
    if (isWebKitMobile(profile)) {
      const slotState = getAllSlots();
      for (const slot of SLOTS) {
        const boundId = slotState[slot].modelId;
        if (!boundId || WEBKIT_MOBILE_VALIDATED_MODEL_IDS.includes(boundId)) continue;
        clearSlot(slot);
        // Drop resume markers for the demoted model so a stale
        // download-in-progress record can't drive a re-fetch of it.
        storage.removeItem(DOWNLOAD_IN_PROGRESS_PREFIX_NEW + boundId);
        storage.removeItem(DOWNLOAD_IN_PROGRESS_PREFIX_LEGACY + boundId);
        report.webkitMobileSlotsRegated.push(slot);
      }
    }
  } catch (err) {
    report.errors.push(`webkit-mobile-regate: ${describe(err)}`);
  }

  // -2b. The desktop mirror of the re-gate above. An iOS-only binding can
  //     survive in localStorage on a desktop profile (seen live 2026-08-05:
  //     Settings announced "Eco Mobile (Qwen)" — "Made for iPhone" — on a
  //     Chromium desktop). Selection never picks it here, but nothing
  //     re-checked a binding that already existed, and every state surface
  //     reads the binding as truth. Clear it, and drop its resume markers.
  //     Form-factor facts only (no capability probes), so a transient probe
  //     misread can never wipe a healthy slot.
  try {
    const profile = (options?.resolveDeviceProfile ?? getDeviceProfile)();
    if (!isWebKitMobile(profile)) {
      const slotState = getAllSlots();
      for (const slot of SLOTS) {
        const boundId = slotState[slot].modelId;
        if (!boundId || !requiresWebKitMobile(boundId)) continue;
        clearSlot(slot);
        storage.removeItem(DOWNLOAD_IN_PROGRESS_PREFIX_NEW + boundId);
        storage.removeItem(DOWNLOAD_IN_PROGRESS_PREFIX_LEGACY + boundId);
        report.incompatibleSlotsRegated.push(slot);
      }
    }
  } catch (err) {
    report.errors.push(`device-scope-regate: ${describe(err)}`);
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

  // 5. Dead-bytes sweep. Removes ONLY unambiguously-dead cached weights:
  //      (a) whole model cache namespaces the CURRENT catalog can no longer
  //          offer, bound to no slot and owned by no in-flight download — the
  //          model is unreachable, so its bytes are dead (generalizes the
  //          hardcoded retired-model list to "anything the catalog dropped"); and
  //      (b) orphaned chunk-parts of a catalog model that is unbound and not
  //          mid-download — abandoned/interrupted resume bytes that no
  //          parts-native manifest claims (a finalized parts-native file's parts
  //          ARE its bytes and are kept).
  //    NEVER touches a slot-bound model, a current-catalog model's finalized
  //    weights, or a model with an in-flight download. When unsure it KEEPS — a
  //    false keep only wastes disk; a false delete forces an active model to
  //    re-download.
  //
  //    Runs LAST — after every slot-mutating migration (WebKit/device re-gate,
  //    artifact swap, retired-model, former-default rebind) and after the
  //    stale-marker and expired-lease sweeps — so the bound-set is FINAL and
  //    "mid-download" reflects only genuinely-live markers/leases. It cannot
  //    race the migrations that also clear caches: those have all already
  //    completed in this sequential pass, and a half-failed migration that left
  //    a slot bound is respected here (the binding keeps the model).
  try {
    await sweepDeadModelBytes(storage, options, report);
  } catch (err) {
    report.errors.push(`dead-bytes-sweep: ${describe(err)}`);
  }

  return report;
}

/**
 * Best-effort boot-time sweep of unambiguously-dead cached model bytes. See the
 * step-5 comment in `runSelfHeal` for the full contract. Every external call is
 * wrapped so a storage/enumeration failure records an error and continues —
 * boot never breaks on cleanup.
 *
 * Skipped wholesale when the validation harness forces cache verification
 * (e2e/diagnostics prime real caches and eval-candidate models the catalog
 * omits; the same escape hatch reconcile uses), so the sweep never disturbs
 * fixtures or harness-only models.
 */
async function sweepDeadModelBytes(
  storage: SlotStorage,
  options: SelfHealOptions | undefined,
  report: SelfHealReport,
): Promise<void> {
  if (isCacheVerificationForced()) return;

  const cacheStorage = options?.cacheStorage
    ?? (typeof caches !== 'undefined' ? new CacheApiStorage() : null);
  if (!cacheStorage) return; // No Cache API (SSR / restricted) — nothing to sweep.

  // Ids we must never touch: everything the catalog can still offer, whatever a
  // slot is bound to, and any model with a live download-in-progress marker (an
  // in-flight fetch — possibly in another tab; the marker is cross-tab).
  const catalogIds = new Set(
    (options?.resolveCatalogIds ?? (() => getCatalog().map((m) => m.id)))(),
  );
  const boundIds = new Set<string>();
  const slotState = getAllSlots();
  for (const slot of SLOTS) {
    const id = slotState[slot].modelId;
    if (id) boundIds.add(id);
  }
  const midDownloadIds = collectMidDownloadModelIds(storage);

  // (a) Sweep whole namespaces the catalog can no longer offer. Build the KEEP
  //     set of namespace NAMES by mapping every keep-worthy id FORWARD (the
  //     sanitization is lossy and not reversible; a name collision only
  //     over-keeps, never over-deletes), then drop every enumerated
  //     `eco-local-ai-*` namespace not in it.
  const keepNames = new Set<string>();
  for (const id of catalogIds) keepNames.add(modelCacheName(id));
  for (const id of boundIds) keepNames.add(modelCacheName(id));
  for (const id of midDownloadIds) keepNames.add(modelCacheName(id));

  const listNames =
    options?.listModelCacheNames
    ?? (() => cacheStorage.listModelCacheNames?.() ?? Promise.resolve([]));
  let names: string[];
  try {
    names = await listNames();
  } catch (err) {
    // Enumeration failed — the whole sweep no-ops this boot (both (a) and (b)
    // depend on it). Non-fatal; retries next boot.
    report.errors.push(`dead-cache-enum: ${describe(err)}`);
    return;
  }

  const deleteByName = options?.deleteCacheByName ?? defaultDeleteCacheByName;
  for (const name of names) {
    if (keepNames.has(name)) continue;
    try {
      await deleteByName(name);
      report.deadModelCachesSwept.push(name);
    } catch (err) {
      report.errors.push(`dead-cache(${name}): ${describe(err)}`);
    }
  }

  // (b) Sweep orphaned chunk-parts of catalog models that are unbound and NOT
  //     mid-download (their namespace was KEPT above; only abandoned resume
  //     parts that no parts-native manifest claims are dead). Skipped entirely
  //     while ANY heavy download is active — its resume parts must survive, and
  //     a download lease cannot be attributed to a single model id. A per-model
  //     marker also excludes that model. Only namespaces that actually EXIST are
  //     touched, so no empty namespace is ever created.
  if (!cacheStorage.sweepOrphanedParts) return;
  const downloadActive =
    options?.hasActiveDownloadLease ?? (() => getActiveLocalDownloadLease() !== null);
  if (downloadActive()) return;
  const existing = new Set(names);
  for (const id of catalogIds) {
    if (boundIds.has(id) || midDownloadIds.has(id)) continue;
    if (!existing.has(modelCacheName(id))) continue;
    try {
      report.orphanedPartsSwept += await cacheStorage.sweepOrphanedParts(id);
    } catch (err) {
      report.errors.push(`orphan-parts(${id}): ${describe(err)}`);
    }
  }
}

/**
 * Model ids with a live download-in-progress marker (either the new or the
 * legacy prefix) — the models an in-flight fetch owns. Read AFTER step 1 has
 * swept stale markers, so a remaining marker is genuinely live. The marker is
 * localStorage-backed and cross-tab, so this also catches a download running in
 * another tab. Mirrors `clearStaleDownloadMarkers`'s enumeration style; an
 * environment without key iteration yields an empty set (nothing swept).
 */
function collectMidDownloadModelIds(storage: SlotStorage): Set<string> {
  const ids = new Set<string>();
  const browserLike = storage as SlotStorage & {
    length?: number;
    key?: (i: number) => string | null;
  };
  if (typeof browserLike.length !== 'number' || typeof browserLike.key !== 'function') {
    return ids;
  }
  for (let i = 0; i < browserLike.length; i++) {
    const k = browserLike.key(i);
    if (!k) continue;
    if (k.startsWith(DOWNLOAD_IN_PROGRESS_PREFIX_NEW)) {
      ids.add(k.slice(DOWNLOAD_IN_PROGRESS_PREFIX_NEW.length));
    } else if (k.startsWith(DOWNLOAD_IN_PROGRESS_PREFIX_LEGACY)) {
      ids.add(k.slice(DOWNLOAD_IN_PROGRESS_PREFIX_LEGACY.length));
    }
  }
  return ids;
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
  /** Test seam — maps a slot's modelId to its catalog config so the loop can
   *  branch on `runtime`. Defaults to the catalog's getModel. */
  resolveModel?: (modelId: string) => ModelConfig | null;
  /** Test seam — authoritative presence probe for `webllm` models (WebLLM's
   *  own cache namespaces, NOT Eco storage). Must THROW rather than return
   *  false when it cannot determine presence; a `false` is read as proof of
   *  absence and demotes the slot. Defaults to the bridge's
   *  `webllmModelCachePresence` via dynamic import. */
  webllmInCache?: (model: ModelConfig) => Promise<boolean>;
};

/**
 * Presence probe for the reconcile path. Uses `webllmModelCachePresence`, NOT
 * the `webllmModelInCache` serving gate: the gate fails CLOSED (its body ends
 * in `catch { return false }`, and the library's own `hasAllKeys` swallows too),
 * so a failed chunk import on a weak connection would arrive here as a
 * confident "absent" and demote a healthy slot — the exact defect this branch
 * exists to remove. The presence variant lets infrastructure errors throw, and
 * the dynamic import is deliberately left unguarded here for the same reason.
 */
async function defaultWebllmInCache(model: ModelConfig): Promise<boolean> {
  const { webllmModelCachePresence } = await import('../runtime/webllm-cache-bridge');
  return webllmModelCachePresence(model);
}

/**
 * Reconcile every slot marked 'ready' against the actual cache state.
 *
 * For each ready slot:
 *   0. If the model's runtime is `webllm`, skip the Eco-storage path
 *      entirely and ask WebLLM's own cache (the authoritative store —
 *      Eco's staging cache is empty by design). Absent ⇒ same
 *      'preparing' flip; probe failure or definitely-offline ⇒ leave
 *      the slot alone (absence unproven).
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

    // `webllm` models live in WebLLM's OWN cache namespaces — Eco's staging
    // cache is empty by design once the bridge drains it into the engine, so
    // the per-file Eco-storage repair below would count every file "missing"
    // and demote a healthy ready slot on every single boot. Verify against
    // the authoritative store instead (the same runtime branch
    // download.ts's isModelDownloaded takes). Presence there is
    // model-granular: a definitive "absent" means the browser evicted the
    // engine's caches, which is exactly the wholly-missing case.
    const resolveModel = options?.resolveModel ?? getModel;
    const model = resolveModel(state.modelId);
    if (model?.runtime === 'webllm') {
      // No artifact ⇒ the probe cannot resolve a cache key and answers a
      // fails-closed `false`, which would demote this slot on every boot —
      // the very defect this branch exists to fix. Absence is unprovable
      // here, so skip (parity with the Eco path, which the null file plan
      // makes skip for an artifact-less model).
      if (!model.artifact?.hfId) continue;
      // A 'preparing' flip drives a re-download, which cannot succeed
      // offline — and the probe itself fails closed on import/Cache-API
      // errors, so probing while definitely-offline could demote a healthy
      // slot into an unsatisfiable download. Leave it ready: the next
      // ONLINE boot runs this probe and repairs. (A genuinely-evicted model
      // then fails at engine load — executeSetup trusts a 'ready' slot and
      // returns, and no chat-path failure flips the slot — so the boot probe
      // is the actual repair mechanism, not in-session recovery.)
      // `=== false` is load-bearing, not redundant: Node defines a global
      // `navigator` with NO `onLine` property, so `!navigator.onLine` would
      // read a missing property as "definitely offline" and skip verification
      // outright. Only an explicit `false` means the browser is certain.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
      if (typeof navigator !== 'undefined' && navigator.onLine === false) continue;
      let present = true;
      try {
        present = await (options?.webllmInCache ?? defaultWebllmInCache)(model);
      } catch (err) {
        // Absence not proven — never demote on a probe failure (the
        // 2026-06-11 lesson: verification errors must not destroy state).
        report.errors.push(`webllm-probe(${state.modelId}): ${describe(err)}`);
        continue;
      }
      if (!present) {
        report.modelsRepaired.push({ modelId: state.modelId, removed: 0, missing: 1 });
        try {
          setStatus(slot, 'preparing');
          report.slotsFlippedToPreparing.push(slot);
          // No onCacheRepaired hint: nothing was removed — same silent
          // re-download semantics as the wholly-missing branch below.
        } catch (err) {
          report.errors.push(`set-status(${slot}): ${describe(err)}`);
        }
      }
      continue;
    }

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

// ─── Boot-time slot promotion (the reverse of reconcileReadySlots) ─────────

export type PromoteReport = {
  /** Slots whose status was flipped from 'preparing' to 'ready' because their
   *  model's bytes verified complete AND the model has recent proof of running
   *  on this device. */
  slotsPromotedToReady: Slot[];
  /** Non-fatal errors during promotion. */
  errors: string[];
};

export type PromoteOptions = {
  cacheStorage?: Storage;
  /** Slot/marker storage — defaults to localStorage (same seam as runSelfHeal). */
  storage?: SlotStorage;
  /** Test seam — defaults to slots.setSlotStatus. */
  setStatus?: (slot: Slot, status: 'ready') => void;
  /** Test seam — defaults to the catalog's getModel. */
  resolveModel?: (modelId: string) => ModelConfig | null;
  /** Test seam — webllm presence probe (must THROW when undeterminable). */
  webllmInCache?: (model: ModelConfig) => Promise<boolean>;
  /** Test seam — "has this model recently run on this device?" Defaults to the
   *  evidence ledger's hasRecentSuccess against the live device profile. */
  hasDeviceProof?: (modelId: string) => boolean;
  /** Harness-only seam — same escape hatch as reconcileReadySlots. */
  isCacheVerificationForced?: () => boolean;
};

/**
 * Reconcile every slot stuck 'preparing' against the actual cache state — the
 * PROMOTE direction. Closes the ready-state wedge verified live 2026-08-05:
 * a slot can be left 'preparing' with its model fully downloaded (a demote
 * flip whose re-download completed but never re-ran setup, an interrupted
 * switch after the bytes landed, a reload at the wrong moment), and nothing
 * ever re-checked it — so every send died on a setup card whose button was
 * permanently disabled.
 *
 * A slot is promoted ONLY when all three hold:
 *   1. No live download-in-progress marker for its model (an actual in-flight
 *      download owns the slot; stale markers are cleared by runSelfHeal, which
 *      the boot path runs first).
 *   2. Its bytes verify COMPLETE — every manifest-plan file present at the
 *      declared size (or, for a `webllm` model, the engine's own cache reports
 *      presence). Manifest unreachable ⇒ skip; verification never guesses.
 *   3. The evidence ledger holds a recent smoke/generate PASS for the model on
 *      this device profile — 'ready' means "proven to run here", and this pass
 *      keeps that meaning. Bytes-present-but-never-proven stays 'preparing';
 *      the recovery surface owns driving a real setup run for it.
 *
 * Never demotes, never deletes, never throws. Idempotent.
 */
export async function reconcilePreparingSlots(
  planResolver: SlotPlanResolver,
  options?: PromoteOptions,
): Promise<PromoteReport> {
  const report: PromoteReport = { slotsPromotedToReady: [], errors: [] };

  const cacheVerificationForced = options?.isCacheVerificationForced ?? isCacheVerificationForced;
  if (cacheVerificationForced()) return report;

  const cacheStorage = options?.cacheStorage ?? new CacheApiStorage();
  const markerStorage = options?.storage ?? defaultSlotStorage();
  const setStatus = options?.setStatus ?? setSlotStatus;
  const resolveModel = options?.resolveModel ?? getModel;
  const hasDeviceProof =
    options?.hasDeviceProof
    ?? ((modelId: string): boolean => {
      try {
        return hasRecentSuccess(modelId, getDeviceProfile());
      } catch {
        return false;
      }
    });

  const slotState = getAllSlots();
  for (const slot of SLOTS) {
    const state = slotState[slot];
    if (state.status !== 'preparing' || !state.modelId) continue;

    // A live in-flight download owns this slot — the pipeline that started it
    // will drive the status. (runSelfHeal already cleared stale markers.)
    if (markerStorage) {
      const hasLiveMarker =
        markerStorage.getItem(DOWNLOAD_IN_PROGRESS_PREFIX_NEW + state.modelId) !== null
        || markerStorage.getItem(DOWNLOAD_IN_PROGRESS_PREFIX_LEGACY + state.modelId) !== null;
      if (hasLiveMarker) continue;
    }
    // Same reason, in-memory: an active heavy-work lease means a download or
    // smoke is running right now.
    if (getActiveLocalHeavyWorkLease() !== null) continue;

    if (!hasDeviceProof(state.modelId)) continue;

    const model = resolveModel(state.modelId);

    // `webllm` models live in the engine's own cache — same authoritative
    // probe (and the same throw-means-unknown contract) as the demote pass.
    if (model?.runtime === 'webllm') {
      if (!model.artifact?.hfId) continue;
      let present = false;
      try {
        present = await (options?.webllmInCache ?? defaultWebllmInCache)(model);
      } catch (err) {
        report.errors.push(`webllm-probe(${state.modelId}): ${describe(err)}`);
        continue;
      }
      if (!present) continue;
      try {
        setStatus(slot, 'ready');
        report.slotsPromotedToReady.push(slot);
      } catch (err) {
        report.errors.push(`set-status(${slot}): ${describe(err)}`);
      }
      continue;
    }

    let files: ReadonlyArray<{ url: string; sizeBytes: number }> | null = null;
    try {
      files = await planResolver(state.modelId);
    } catch (err) {
      report.errors.push(`plan-resolver(${state.modelId}): ${describe(err)}`);
      continue;
    }
    if (!files || files.length === 0) continue;

    // Read-only completeness check: every plan file present at its declared
    // size. Any miss (or any storage error) means "not proven complete" —
    // skip, delete nothing.
    let complete = true;
    for (const file of files) {
      try {
        const verified = await cacheStorage.verify(
          { modelId: state.modelId, url: file.url },
          file.sizeBytes,
        );
        if (!verified) {
          complete = false;
          break;
        }
      } catch {
        complete = false;
        break;
      }
    }
    if (!complete) continue;

    try {
      setStatus(slot, 'ready');
      report.slotsPromotedToReady.push(slot);
    } catch (err) {
      report.errors.push(`set-status(${slot}): ${describe(err)}`);
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
