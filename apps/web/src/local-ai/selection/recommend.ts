// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Recommendation engine — THE engine (one, singular).
 *
 * `recommend(slot, profile, intent)` is the only place in `local-ai/` that
 * decides which model to assign. Invariant 1 (one engine) is enforced via a
 * grep test that fails if another file exports a function named `recommend`.
 *
 * Pipeline:
 *
 *   1. Filter the v1.0 catalog to models the device can run
 *      (`device/compatibility.isAssignable`). Models flagged unsupported
 *      never reach scoring — a structural guarantee so predicted-fit
 *      cannot recommend unassignable models.
 *
 *   2. Filter to admitted candidates (`evidence/admission.admit()`).
 *      Models with recent smoke failures on this profile also drop out
 *      here (unless currently bound).
 *
 *   3. Restrict to candidates whose declared capabilities match the slot
 *      preference: eco-fast prefers snappy/balanced; eco-smart prefers
 *      balanced/quality. A model can match multiple intents — Bonsai
 *      shows up in both slots, for example.
 *
 *   4. Score each survivor with `scoreFit` (intent-weighted). Use seed
 *      metrics when seed evidence exists for (model × profile); fall
 *      back to predicted metrics from `predicted-fit.ts` otherwise.
 *      Reliability axis is derived from the admission decision.
 *
 *   5. Return the highest-scoring model. If no candidate survives the
 *      filters, throw `NoAssignableModelError` — the caller is expected
 *      to have gated below-floor profiles already via `isBelowFloor()`.
 *      Any other surface that reaches this throw is a bug.
 *
 * Invariant 2: `recommend()` cannot return a non-assignable model because
 * (1) above is a hard precondition. The accompanying parametric test
 * iterates every (catalog × profile × slot × intent) combination and
 * asserts the result either passes `isAssignable` or correctly throws.
 */

import type { DeviceProfile, Intent, ModelConfig, ModelTier, Slot } from '../types';
import { getCatalog, getModel, TIER_ORDER, type CatalogModel } from '../catalog/catalog';
import { isAssignable, isWebKitMobile } from '../device/compatibility';
import {
  admit,
  type AdmissionDecision,
  type AdmissionReason,
  type AdmissionResult,
} from '../evidence/admission';
import type { SeedEvidenceSource } from '../evidence/seed';
import { scoreFit, type FitScore } from './fit-scoring';
import { getMetrics, modelMatchesSlot, slotDefaultIntent } from './predicted-fit';

/**
 * Models that were once the everyday default and should yield to the CURRENT
 * device-appropriate default. Boot self-heal migrates an eco-fast slot still
 * bound to one of these — but device-aware: it rebinds to `recommend('eco-fast',
 * profile)`, not a fixed id. Profiles primed before a graduation otherwise keep
 * the old model forever.
 *
 * Derived from the catalog: an entry declares itself outgoing with
 * `formerEverydayDefault: true`. Empty today — the current default must never
 * appear here (it would be migrated away from), and the outgoing Qwen3.5-2B is
 * deliberately absent: this rebind exists to move auto-primed devices UP to a
 * better default, not to force a working bigger model DOWN to a smaller one. An
 * explicit user choice is exempt regardless (hasExplicitModelChoice in
 * self-heal.ts). Bonsai, the dev-era former default, retired 2026-07-11 and is
 * handled by RETIRED_MODEL_MIGRATIONS, which runs before this rebind.
 *
 * There is no eco-smart counterpart: no shipped code path has ever auto-bound
 * the eco-smart slot, so there is no stale-smart-binding population to migrate.
 */
export const FORMER_EVERYDAY_DEFAULT_IDS: ReadonlyArray<string> =
  getCatalog().filter((model) => model.formerEverydayDefault === true).map((model) => model.id);

/** ≥ this many genuine download failures in 7 days demotes a model from auto-offer. */
export const DOWNLOAD_FAIL_DEMOTION_THRESHOLD = 2;

/**
 * The model a slot defaults to at a given device tier, or null if that rung is
 * empty. The rung is declared on the catalog entry (`tier`), so a graduation is
 * a catalog edit — not an id literal in this file, which is what the ladder used
 * to be. Exported for tests that need to name a rung's occupant without
 * re-hardcoding it.
 */
export function tierDefaultModelId(slot: Slot, tier: ModelTier): string | null {
  return getCatalog().find((model) => model.tier[slot] === tier)?.id ?? null;
}

/**
 * This slot's ladder, best rung first, skipping empty rungs.
 *
 * Read off the catalog rather than kept here: each entry names the device tier
 * it is the default for (`tier`), and TIER_ORDER fixes the fallback order.
 */
function tierLadderForSlot(slot: Slot): CatalogModel[] {
  const catalog = getCatalog();
  return TIER_ORDER.flatMap((tier) => {
    const model = catalog.find((entry) => entry.tier[slot] === tier);
    return model === undefined ? [] : [model];
  });
}

/**
 * The device-appropriate preferred pick for a slot: the best-tier model THIS
 * device can actually run. Walk the slot's ladder best-first and take the first
 * assignable rung — the `capable` q4f16 pick, else the `laptop` f16-less build,
 * else the `phone` CPU-EP pick, else the universal `floor`.
 *
 * The rungs are NOT device-gated here. Each rung's own `compat` block does that
 * work: the `phone` picks carry `requireWasmOnly`, so they are unassignable on
 * any device with a WebGPU adapter and the ladder walks past them on its own.
 *
 * The returned id is fed to `promotePreferred`, which lifts it only if it
 * survived the assignable + admitted + slot + floor filters — so an unassignable
 * rung is a safe no-op that yields to natural fit-score ranking. Layering here
 * (not in fit scoring) keeps the preference explicit and unit-testable rather
 * than emergent from snappy-vs-balanced weighting.
 */
function preferredModelIdForSlot(slot: Slot, profile: DeviceProfile): string {
  const ladder = tierLadderForSlot(slot);
  for (const model of ladder) {
    if (isAssignable(model, profile)) return model.id;
  }
  // Nothing on the ladder runs here. Naming the top rung anyway is a no-op —
  // promotePreferred cannot lift a model that never entered the ranked list.
  return ladder[0]?.id ?? '';
}

function promotePreferred<T extends { model: { id: string } }>(
  ranked: T[],
  preferredId: string,
): T[] {
  const idx = ranked.findIndex(c => c.model.id === preferredId);
  if (idx > 0) {
    const [preferred] = ranked.splice(idx, 1);
    ranked.unshift(preferred!);
  }
  return ranked;
}

/**
 * Starter download budget (GB). At or below this size, the class-best pick is
 * itself a fast-enough first download to BE the starter; above it, Stage A steps
 * down to a smaller rung so a fresh device still chats quickly. The 1.2B everyday
 * default (0.76GB) fits; a larger class-best (e.g. Gemma 4 LiteRT, 1.87GB, on
 * f16-less adapters) does not, so those devices still get a small instant-start
 * rung instead of a multi-minute first download.
 */
export const STARTER_MAX_SIZE_GB = 1.0;

/**
 * Instant-start Stage A pick (slice 2b): the fastest trustworthy path to a
 * working chat. First-run setup leads with this so a fresh device is chatting
 * quickly; the consent-driven upgrade (lifecycle/upgrade.ts) then offers the
 * eco-smart pick as a background download only when it differs.
 *
 * Model-ladder fix (2026-08-09): this used to return the SMALLEST offerable
 * model, which on a capable device served LFM2.5-350M (0.28GB) — an EXTRACTION
 * model wrong-type for chat that ALSO can't load on wasm-only (CPU-EP) devices:
 * its block-quantized embeddings emit GatherBlockQuantized, unimplemented on
 * ort-web's CPU/WASM EP (it DOES run on the WebGPU EP — see compatibility.ts).
 * A broken, wrong-type first impression. Now the class-best pick (candidates[0],
 * i.e. exactly what recommend() returns) is the starter when it is within
 * STARTER_MAX_SIZE_GB — so a capable device's first chat runs on the good 1.2B
 * default and Stage A converges with the class-best (no jarring mid-session swap).
 * Only when the class-best is too big for a fast first download does it step down
 * to the smallest offerable, preserving instant-start where the default is large.
 *
 * Reuses the full listCandidates filter chain (assignable + admitted +
 * slot-matched + confidence floor), so a starter can never be a model the engine
 * wouldn't offer — including models this device recently smoke-failed. Returns
 * null when nothing survives; callers fall back to the class-best pick, which
 * throws NoAssignableModelError on the same empty set.
 */
export function starterModelForSlot(
  slot: Slot,
  profile: DeviceProfile,
  intent: Intent = slotDefaultIntent(slot),
  options: ListCandidatesOptions = {},
): ModelConfig | null {
  const candidates = listCandidates(slot, profile, intent, options);
  if (candidates.length === 0) return null;
  // candidates[0] is the class-best (promoted preferred / top fit score) — exactly
  // what recommend() returns. When it's a fast enough download, it IS the starter,
  // so the first impression is the good model rather than the smallest one.
  const classBest = candidates[0]!.model;
  if (classBest.sizeGB <= STARTER_MAX_SIZE_GB) return classBest;
  // Class-best too big for instant-start — step down to the smallest offerable
  // (ties keep fit-score order; the scan is strict-less-than).
  let smallest = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.model.sizeGB < smallest.model.sizeGB) smallest = candidate;
  }
  return smallest.model;
}

export class NoAssignableModelError extends Error {
  readonly slot: Slot;
  readonly profile: DeviceProfile;

  constructor(slot: Slot, profile: DeviceProfile) {
    super(
      `No assignable model for slot=${slot} on this device profile `
      + `(browserClass=${profile.browserClass}, webgpuSupport=${profile.webgpuSupport}, `
      + `deviceMemoryGB=${profile.deviceMemoryGB}). Caller should check isBelowFloor() first.`,
    );
    this.name = 'NoAssignableModelError';
    this.slot = slot;
    this.profile = profile;
  }
}

export type RecommendationCandidate = {
  model: ModelConfig;
  score: FitScore;
  admission: AdmissionResult;
  reliability: number;
};

/**
 * Confidence source for an offered model:
 *   - 'benchmark': we measured this combo on real hardware
 *   - 'calculated': we predicted based on model size + runtime knowledge,
 *     or no prior evidence exists (v1.0 default — smoke test gates quality)
 *   - 'ledger': this user's device has personally run it successfully
 */
export type AvailableConfidence = 'benchmark' | 'calculated' | 'ledger';

export type AvailableModel = {
  model: ModelConfig;
  confidence: AvailableConfidence;
  scoreTotal: number;
};

export type ListCatalogResult = {
  available: AvailableModel[];
};

export type ListCatalogOptions = {
  /**
   * The model id currently bound to this user's slot. Stays visible even
   * if it falls below the normal confidence floor or has recent failures,
   * so users never lose track of what they previously chose.
   */
  currentlyBoundModelId?: string | null;
};

export type ListCandidatesOptions = {
  /**
   * The model id currently bound to this user's slot. Exempt from the
   * recent-failure filter + confidence floor so users never lose their
   * previous choice.
   */
  currentlyBoundModelId?: string | null;
};

export function recommend(
  slot: Slot,
  profile: DeviceProfile,
  intent: Intent = slotDefaultIntent(slot),
  options?: ListCandidatesOptions,
): ModelConfig {
  const candidates = listCandidates(slot, profile, intent, options);
  if (candidates.length === 0) {
    throw new NoAssignableModelError(slot, profile);
  }
  return candidates[0]!.model;
}

/**
 * Hardware-level "can this device be served at all" gate: true iff SOME catalog
 * model is assignable to the device (compatibility only — ignores admission /
 * ledger, matching `isBelowFloor`'s purity). This is the COMPLETE complement of
 * the below-floor decision. `isBelowFloor` trips only on the no-capability +
 * low-memory subset, so it returns false for two bands where nothing is
 * nonetheless assignable — no-capability + adequate/unknown memory, and
 * sub-floor memory on a WebGPU/WASM device — exactly where `recommend()` throws
 * `NoAssignableModelError`. Surfaces deciding whether to offer models should
 * gate on `!canServe(profile)` rather than `isBelowFloor(profile)` alone, so
 * that "no assignable model" band is handled uniformly instead of slipping
 * through a partial gate (device-coverage audit, finding COV-1).
 */
export function canServe(profile: DeviceProfile): boolean {
  return getCatalog().some((model) => isAssignable(model, profile));
}

export function listCandidates(
  slot: Slot,
  profile: DeviceProfile,
  intent: Intent = slotDefaultIntent(slot),
  options: ListCandidatesOptions = {},
): RecommendationCandidate[] {
  const ranked: RecommendationCandidate[] = [];
  for (const model of getCatalog()) {
    if (!isAssignable(model, profile)) continue;
    const admission = admit(model, profile);
    if (!modelMatchesSlot(model, slot)) continue;

    const floor = applyConfidenceFloor(model, profile, admission, {
      currentlyBoundModelId: options.currentlyBoundModelId,
      demoteOnDownloadFail: true,
    });
    if (!floor.admit) continue;

    const reliability = reliabilityFromDecision(admission.decision);
    const metrics = getMetrics(model, profile);
    const score = scoreFit({ model, profile, intent, metrics, reliability, confidence: floor.confidence });
    ranked.push({ model, score, admission, reliability });
  }
  ranked.sort((a, b) => b.score.total - a.score.total);
  return promotePreferred(ranked, preferredModelIdForSlot(slot, profile));
}

/**
 * Return the flat, ranked list of models we can offer for this profile.
 * The Switch dialog renders this as a single "Available AIs" list with
 * no tier headings.
 *
 * A model surfaces when ALL hold:
 *   - It's assignable to this device (compatibility passes)
 *   - Admission allows it (not denied)
 *   - The user's device hasn't recorded a smoke/generate failure for it
 *     in the last 30 days
 *
 * Exception: the currently-bound model stays visible even if it has
 * recent failures — never silently drop the user's current choice.
 *
 * v1.0 policy: a confidence source (benchmark/calculated/ledger) is NOT
 * required to surface a model. The smoke test on first use is the actual
 * quality gate. Models without prior evidence appear with a 'calculated'
 * label. Pre-shipping benchmarks for every (model x profile) is not how
 * we unlock v1.0 confidence — real-world smoke tests + ledger graduation
 * handle that.
 *
 * The sort is fit-score descending. The top entry is what the dialog
 * surfaces with a small "Recommended" tag.
 */
export function listCatalog(
  profile: DeviceProfile,
  options: ListCatalogOptions = {},
): ListCatalogResult {
  const available: AvailableModel[] = [];

  for (const model of getCatalog()) {
    // FH-2: the user's currently-bound model stays visible in the manual Switch
    // list even if a later device re-probe (e.g. shader-f16=false, or a
    // populated max-buffer gate) made it unassignable — otherwise it vanishes
    // with no path to switch away. applyConfidenceFloor already carries the
    // isBound exemption for the admission/failure checks; the auto-offer path
    // (listCandidates) keeps the unconditional hard-filter and never surfaces
    // an unrunnable model.
    const isBoundModel = options.currentlyBoundModelId === model.id;
    if (!isAssignable(model, profile) && !isBoundModel) {
      continue; // unsupported devices: hard exclude
    }
    const admission = admit(model, profile);

    const floor = applyConfidenceFloor(model, profile, admission, {
      currentlyBoundModelId: options.currentlyBoundModelId,
      // Manual Settings list: never hide a model for download failures — the
      // user may always retry it by hand. Same for a single smoke-fail: hiding it
      // for 30 days with no retry path is the FH-1 trap; re-selecting re-smokes it.
      demoteOnDownloadFail: false,
      hideOnRecentFailure: false,
    });
    if (!floor.admit) continue;

    const reliability = reliabilityFromDecision(admission.decision);
    const metrics = getMetrics(model, profile);
    const intent = slotDefaultIntent('eco-fast');
    const score = scoreFit({ model, profile, intent, metrics, reliability, confidence: floor.confidence });

    available.push({
      model,
      confidence: floor.confidence,
      scoreTotal: score.total,
    });
  }

  available.sort((a, b) => b.scoreTotal - a.scoreTotal);
  // The flat dialog list is slotless — the device-appropriate default keeps the
  // top spot (it is what a fresh device gets): LFM2.5-1.2B on f16-capable
  // hardware, Gemma 4 on f16-less-but-WebGPU adapters. Everything else ranks by
  // fit score. Using the eco-fast preference keeps the dialog's "Recommended"
  // tag consistent with the slot the setup path actually binds.
  return { available: promotePreferred(available, preferredModelIdForSlot('eco-fast', profile)) };
}

// ─── Admission gate ──────────────────────────────────────────────────────
//
// Shared gate used by both the user-facing dialog (listCatalog) and the
// recommendation engine (listCandidates, recommend). A model is admitted
// when ALL hold:
//   - Admission allows it (not denied) — unless currently bound
//   - No recent smoke/generate failures — unless currently bound
//
// v1.0 policy: a confidence source is NOT required to surface a model.
// The smoke test on first use is the actual quality gate. Models without
// prior evidence appear with a 'calculated' label.
//
// The currently-bound model is exempt from the failure check so users
// never lose track of what they previously chose.

type FloorOptions = {
  currentlyBoundModelId?: string | null;
  /**
   * Apply the download-fail auto-demotion (slice 3). True for the auto-offer
   * engine (`listCandidates`/`recommend`/starter/upgrade); FALSE for the manual
   * Settings list (`listCatalog`) so a user can always retry a model by hand —
   * a repeated download failure is usually environmental (disk/network) and may
   * clear on the next attempt.
   */
  demoteOnDownloadFail?: boolean;
  /**
   * Hide a model that has a recent smoke/generate FAILURE. Default true for the
   * auto-offer engine (`listCandidates`/`recommend`/starter/upgrade) — don't
   * auto-recommend something that just failed. FALSE for the manual Settings list
   * (`listCatalog`): a single transient smoke-fail otherwise hides the model for
   * the full 30-day window with no user retry path — asymmetric with downloads,
   * which are already manual-exempt. Re-selecting it re-runs the smoke gate, so
   * showing it IS the retry path (FH-1).
   */
  hideOnRecentFailure?: boolean;
};
type FloorOutcome =
  | { admit: true; confidence: AvailableConfidence }
  | { admit: false };

/**
 * Whether a model is EXEMPT from download-fail auto-demotion because it is the
 * DEVICE's effective instant-start floor — demoting it would leave the device with
 * nothing offerable (COV-3). Every clause reads the model's own catalog entry:
 *   - `starterFloor`: the universal instant-start rung, which covers most WebGPU
 *     devices (its onnx-q4 build loads on the WebGPU EP).
 *   - `wasm-only`: the starter build is `cpuEpIncompatible` and never assignable
 *     there, so the effective floor is that slot's `phone` tier occupant.
 *   - iOS/WebKit-mobile: every ONNX build (incl. the starter) is declined by the
 *     WebKit-mobile gate before any capability check, so the sole assignable floor
 *     is the `compat.webkitMobileValidated` entry — a WebGPU model, so the
 *     wasm-only branch never covers it.
 * Without these, two transient download failures of a device's sole assignable model
 * would over-decline a runnable device to below-floor for the 7-day window.
 */
function isDemotionExemptFloor(modelId: string, profile: DeviceProfile): boolean {
  const model = getModel(modelId);
  if (model === null) return false;
  if (model.starterFloor === true) return true;
  if (profile.webgpuSupport === 'wasm-only' && model.tier['eco-fast'] === 'phone') return true;
  if (isWebKitMobile(profile) && model.compat.webkitMobileValidated === true) return true;
  return false;
}

function applyConfidenceFloor(
  model: ModelConfig,
  profile: DeviceProfile,
  admission: AdmissionResult,
  options: FloorOptions,
): FloorOutcome {
  const isBound = options.currentlyBoundModelId === model.id;
  if (admission.decision === 'denied' && !isBound) return { admit: false };
  if (
    options.hideOnRecentFailure !== false
    && admission.recentFailureCount >= 1
    && !isBound
  ) {
    return { admit: false };
  }
  // Auto-demote a model that keeps failing to DOWNLOAD (≥2 in 7d) from the
  // auto-offer surfaces — this kills the re-offer nag loop. Two carve-outs: the
  // currently-bound model (never lose the user's pick) and the device's effective
  // floor (never leave a device with nothing offerable — see isDemotionExemptFloor).
  if (
    options.demoteOnDownloadFail
    && !isBound
    && !isDemotionExemptFloor(model.id, profile)
    && admission.recentDownloadFailureCount >= DOWNLOAD_FAIL_DEMOTION_THRESHOLD
  ) {
    return { admit: false };
  }
  // Models surface if admission isn't denied + no recent failure (or currently bound).
  // The smoke test is the actual quality gate on first use; pre-shipping benchmarks
  // for every (model × profile) is not how we unlock v1.0 confidence.
  const confidence = deriveConfidence(admission.seedProofSource, admission.hasLedgerSuccess);
  return { admit: true, confidence: confidence ?? 'calculated' };
}

function deriveConfidence(
  seedProofSource: SeedEvidenceSource | null,
  hasLedgerSuccess: boolean,
): AvailableConfidence | null {
  if (seedProofSource === 'benchmark') return 'benchmark';
  if (seedProofSource === 'calculated') return 'calculated';
  if (hasLedgerSuccess) return 'ledger';
  return null;
}

function reliabilityFromDecision(decision: AdmissionDecision): number {
  switch (decision) {
    case 'allowed':
      return 1;
    case 'with-warning':
      return 0.6;
    case 'denied':
    default:
      return 0;
  }
}

export type { AdmissionDecision, AdmissionReason };
