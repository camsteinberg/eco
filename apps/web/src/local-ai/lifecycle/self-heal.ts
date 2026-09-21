// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Self-heal — boot-time cleanup.
 *
 * Runs once per page load from `bootstrap.ts` (a client effect, not before
 * first render). `runSelfHeal` performs:
 *   1. Slot re-gates — WebKit-mobile and device-scope — so a binding that
 *      this device cannot actually run is cleared rather than resumed.
 *   2. An expired heavy-work lease sweep.
 *   3. A dead model-bytes sweep (unreachable cache namespaces and orphaned
 *      chunk-parts).
 * Cooldown expiry is NOT handled here (see the note on `SelfHealReport`).
 * `repairModelCache` is a separate, on-demand repair for one model's bytes;
 * nothing triggers it automatically on a slot error.
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
  setSlotStatus,
  type KeyValueStorage as SlotStorage,
} from './slots';
import { hasRecentSuccess } from '../evidence/ledger';
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

// ─── Report types ──────────────────────────────────────────────────────────

export type SelfHealReport = {
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
  /** Inject storage for tests. Defaults to globalThis.localStorage. */
  storage?: SlotStorage;
  /** Inject the download `Storage` the dead-bytes sweep reads. */
  cacheStorage?: Storage;
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
   * Test seam: delete a Cache API cache by its VERBATIM name. Defaults to
   * `caches.delete` (a no-op when the Cache API is unavailable, e.g. SSR). The
   * dead-bytes sweep uses this to drop a whole unreachable model namespace.
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

/** Default cache-name delete: the global Cache API, or a no-op where it's absent
 *  (SSR / restricted contexts have no caches to purge). A rejection is NOT
 *  swallowed — it propagates to the caller's try/catch, which records the
 *  failure in the report and moves on. */
async function defaultDeleteCacheByName(name: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.delete(name);
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function runSelfHeal(options?: SelfHealOptions): Promise<SelfHealReport> {
  const storage = options?.storage ?? defaultSlotStorage();

  const report: SelfHealReport = {
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

  // 1. WebKit-mobile re-gate. A device primed BEFORE the WebKit-mobile gate
  //    shipped holds a slot bound to a model that crash-loops the tab on load.
  //    Nothing else re-checks it: boot reconcile only flips 'ready'→'preparing'
  //    on missing bytes, and a 'preparing' slot with cached partial bytes
  //    RESUMES the doomed load. So re-gate here: on iOS WebKit, clear any slot
  //    bound to a model NOT on the validated list (both slots). The next setup
  //    run then re-enters recommend → NoAssignableModelError → the designed
  //    mobile handoff surface. Cached model BYTES are left alone — harmless
  //    dead weight that reconcile/repair owns; this step only touches the slot
  //    binding.
  //
  //    Runs FIRST so a cleared slot is already empty when the sweeps below read
  //    it. No-op on every non-WebKit-mobile profile. Never crashes boot.
  try {
    const profile = (options?.resolveDeviceProfile ?? getDeviceProfile)();
    if (isWebKitMobile(profile)) {
      const slotState = getAllSlots();
      for (const slot of SLOTS) {
        const boundId = slotState[slot].modelId;
        if (!boundId || WEBKIT_MOBILE_VALIDATED_MODEL_IDS.includes(boundId)) continue;
        clearSlot(slot);
        report.webkitMobileSlotsRegated.push(slot);
      }
    }
  } catch (err) {
    report.errors.push(`webkit-mobile-regate: ${describe(err)}`);
  }

  // 2. The desktop mirror of the re-gate above. An iOS-only binding can
  //    survive in localStorage on a desktop profile (seen live 2026-08-05:
  //    Settings announced "Eco Mobile (Qwen)" — "Made for iPhone" — on a
  //    Chromium desktop). Selection never picks it here, but nothing
  //    re-checked a binding that already existed, and every state surface
  //    reads the binding as truth. Clear it. Form-factor facts only (no
  //    capability probes), so a transient probe misread can never wipe a
  //    healthy slot.
  try {
    const profile = (options?.resolveDeviceProfile ?? getDeviceProfile)();
    if (!isWebKitMobile(profile)) {
      const slotState = getAllSlots();
      for (const slot of SLOTS) {
        const boundId = slotState[slot].modelId;
        if (!boundId || !requiresWebKitMobile(boundId)) continue;
        clearSlot(slot);
        report.incompatibleSlotsRegated.push(slot);
      }
    }
  } catch (err) {
    report.errors.push(`device-scope-regate: ${describe(err)}`);
  }

  // 3. Expired-lease sweep. A tab that crashed mid-download/switch can leave a
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

  // 4. Dead-bytes sweep. Removes ONLY unambiguously-dead cached weights:
  //      (a) whole model cache namespaces the CURRENT catalog can no longer
  //          offer, bound to no slot and owned by no in-flight download — the
  //          model is unreachable, so its bytes are dead; and
  //      (b) orphaned chunk-parts of a catalog model that is unbound and not
  //          mid-download — abandoned/interrupted resume bytes that no
  //          parts-native manifest claims (a finalized parts-native file's parts
  //          ARE its bytes and are kept).
  //    NEVER touches a slot-bound model, a current-catalog model's finalized
  //    weights, or a model with an in-flight download. When unsure it KEEPS — a
  //    false keep only wastes disk; a false delete forces an active model to
  //    re-download.
  //
  //    Runs LAST — after the slot re-gates and the expired-lease sweep — so the
  //    bound-set is FINAL and "mid-download" reflects only a genuinely-live
  //    lease.
  try {
    await sweepDeadModelBytes(options, report);
  } catch (err) {
    report.errors.push(`dead-bytes-sweep: ${describe(err)}`);
  }

  return report;
}

/**
 * Best-effort boot-time sweep of unambiguously-dead cached model bytes. See the
 * step-4 comment in `runSelfHeal` for the full contract. Every external call is
 * wrapped so a storage/enumeration failure records an error and continues —
 * boot never breaks on cleanup.
 *
 * Skipped wholesale when the validation harness forces cache verification
 * (e2e/diagnostics prime real caches and eval-candidate models the catalog
 * omits; the same escape hatch reconcile uses), so the sweep never disturbs
 * fixtures or harness-only models.
 */
async function sweepDeadModelBytes(
  options: SelfHealOptions | undefined,
  report: SelfHealReport,
): Promise<void> {
  if (isCacheVerificationForced()) return;

  const cacheStorage = options?.cacheStorage
    ?? (typeof caches !== 'undefined' ? new CacheApiStorage() : null);
  if (!cacheStorage) return; // No Cache API (SSR / restricted) — nothing to sweep.

  // Ids we must never touch: everything the catalog can still offer, and
  // whatever a slot is bound to.
  const catalogIds = new Set(
    (options?.resolveCatalogIds ?? (() => getCatalog().map((m) => m.id)))(),
  );
  const boundIds = new Set<string>();
  const slotState = getAllSlots();
  for (const slot of SLOTS) {
    const id = slotState[slot].modelId;
    if (id) boundIds.add(id);
  }

  // (a) Sweep whole namespaces the catalog can no longer offer. Build the KEEP
  //     set of namespace NAMES by mapping every keep-worthy id FORWARD (the
  //     sanitization is lossy and not reversible; a name collision only
  //     over-keeps, never over-deletes), then drop every enumerated
  //     `eco-local-ai-*` namespace not in it.
  const keepNames = new Set<string>();
  for (const id of catalogIds) keepNames.add(modelCacheName(id));
  for (const id of boundIds) keepNames.add(modelCacheName(id));

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
  //     a download lease cannot be attributed to a single model id. Only
  //     namespaces that actually EXIST are touched, so no empty namespace is
  //     ever created.
  if (!cacheStorage.sweepOrphanedParts) return;
  const downloadActive =
    options?.hasActiveDownloadLease ?? (() => getActiveLocalDownloadLease() !== null);
  if (downloadActive()) return;
  const existing = new Set(names);
  for (const id of catalogIds) {
    if (boundIds.has(id)) continue;
    if (!existing.has(modelCacheName(id))) continue;
    try {
      report.orphanedPartsSwept += await cacheStorage.sweepOrphanedParts(id);
    } catch (err) {
      report.errors.push(`orphan-parts(${id}): ${describe(err)}`);
    }
  }
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
 * The one `webllm` presence question both reconcile passes ask.
 *
 * `unknown` covers the model having no artifact (the probe cannot resolve a
 * cache key, and its fails-closed `false` would read as proof of absence) and
 * the probe throwing. Neither pass acts on `unknown` — the demote pass must
 * not demote a healthy slot on an infrastructure error, and the promote pass
 * must not promote an unverified one. A thrown error is handed back so the
 * caller can record it in its own report.
 */
async function probeWebllmPresence(
  model: ModelConfig,
  probe: ((model: ModelConfig) => Promise<boolean>) | undefined,
): Promise<{ state: 'present' | 'absent' | 'unknown'; error?: unknown }> {
  if (!model.artifact?.hfId) return { state: 'unknown' };
  try {
    return { state: (await (probe ?? defaultWebllmInCache)(model)) ? 'present' : 'absent' };
  } catch (error) {
    return { state: 'unknown', error };
  }
}

/**
 * Read-only completeness check: is every file present at its declared size?
 * Any miss — or any storage error — answers false ("not proven complete").
 * Deletes nothing; that is what separates it from `repairModelCache`.
 */
async function verifyPlanComplete(
  modelId: string,
  files: ReadonlyArray<{ url: string; sizeBytes: number }>,
  storage: Storage,
): Promise<boolean> {
  for (const file of files) {
    try {
      if (!(await storage.verify({ modelId, url: file.url }, file.sizeBytes))) return false;
    } catch {
      return false;
    }
  }
  return true;
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
    // and demote a healthy ready slot on every single boot. Ask the
    // authoritative store instead.
    const resolveModel = options?.resolveModel ?? getModel;
    const model = resolveModel(state.modelId);
    if (model?.runtime === 'webllm') {
      // Offline, a 'preparing' flip drives a re-download that cannot succeed,
      // so skip the probe entirely: the next ONLINE boot runs it and repairs.
      // (A genuinely-evicted model then fails at engine load — executeSetup
      // trusts a 'ready' slot and returns, and no chat-path failure flips the
      // slot — so the boot probe is the actual repair mechanism, not
      // in-session recovery.)
      // `=== false` is load-bearing, not redundant: Node defines a global
      // `navigator` with NO `onLine` property, so `!navigator.onLine` would
      // read a missing property as "definitely offline" and skip verification
      // outright. Only an explicit `false` means the browser is certain.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
      if (typeof navigator !== 'undefined' && navigator.onLine === false) continue;
      const presence = await probeWebllmPresence(model, options?.webllmInCache);
      if (presence.error !== undefined) {
        // Absence not proven — never demote on a probe failure (the
        // 2026-06-11 lesson: verification errors must not destroy state).
        report.errors.push(`webllm-probe(${state.modelId}): ${describe(presence.error)}`);
      }
      if (presence.state === 'absent') {
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
 *   1. No heavy-work lease is held right now — an in-flight download or smoke
 *      owns the slot, and the pipeline that started it drives the status.
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

    // An active heavy-work lease means a download or smoke is running right
    // now — the pipeline that started it will drive the status.
    if (getActiveLocalHeavyWorkLease() !== null) continue;

    if (!hasDeviceProof(state.modelId)) continue;

    const model = resolveModel(state.modelId);

    // `webllm` models live in the engine's own cache — same probe as the
    // demote pass.
    if (model?.runtime === 'webllm') {
      const presence = await probeWebllmPresence(model, options?.webllmInCache);
      if (presence.error !== undefined) {
        report.errors.push(`webllm-probe(${state.modelId}): ${describe(presence.error)}`);
      }
      if (presence.state !== 'present') continue;
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

    if (!(await verifyPlanComplete(state.modelId, files, cacheStorage))) continue;

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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
