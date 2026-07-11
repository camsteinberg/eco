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

import type { DeviceProfile, Intent, ModelConfig, Slot } from '../types';
import { getCatalog } from '../catalog/catalog';
import { isAssignable } from '../device/compatibility';
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
 * Everyday default (everyday-swap, graduated 2026-06-13): Qwen3.5-2B is the
 * default recommendation on any device that can run it. It won the chat #7
 * smart-tier bake-off (run `eval-mq8s89xp-1xeys0c7`, 114/114 on real WebGPU)
 * and then cleared the everyday-swap gates — fresh-profile cold-load (~2.5 min
 * for 1.4GB on real network), DeltaNet KV-reuse multi-turn (restored in #151),
 * deterministic CJK suppression (#156), and founder dogfood — so it is promoted
 * from the smart slot to the everyday default. It roughly doubles the answer-depth
 * floor over the previous LFM2.5 default and admits uncertainty instead of
 * confidently fabricating (the floor behavior the swap was for).
 *
 * Stronger hardware loads the default faster — it doesn't trigger an auto-upgrade
 * to a bigger model. Users who want a lighter/faster footprint (LFM2.5-1.2B =
 * "Eco Fast") or more reasoning (Phi-3) can opt in via "Choose your own".
 *
 * If Qwen3.5-2B is incompatible with the current device, the device-appropriate
 * default applies (see `preferredModelIdForSlot`): on f16-less-but-WebGPU adapters
 * (older-Intel desktop / Adreno Android) that is Gemma 4 (LiteRT) — see
 * PREFERRED_F16LESS_DEFAULT_MODEL_ID. On low-memory / WASM-only / non-Chromium
 * devices where neither runs, the natural fit-score ranking applies and the
 * smaller compatible models win — LFM2.5-1.2B, then LFM2.5-350M / Qwen3-0.6B.
 * LFM2.5-1.2B is therefore demoted to the fast/light tier, NOT removed: it stays
 * selectable AND remains the automatic default where neither Qwen nor Gemma run.
 *
 * Wired here (not in catalog data) to keep the change surface small for v1.0.
 * Future revisions may move this to a `defaultPreference` field on ModelConfig.
 */
export const PREFERRED_DEFAULT_MODEL_ID = 'candidate/qwen3.5-2b-onnx';

/**
 * Smart-slot pick. Post everyday-swap this COINCIDES with the everyday default:
 * the everyday default IS now the smart-tier model (Qwen3.5-2B), so eco-fast and
 * eco-smart resolve to the same model on capable hardware. The two-slot
 * architecture stays in place — when a larger smart model graduates (Qwen3.5-4B
 * is the high-memory candidate from the same bake-off), pointing this constant at
 * it re-splits the slots with no other change. Where Qwen3.5-2B is not assignable,
 * the natural fit-score ranking applies unchanged.
 */
export const PREFERRED_SMART_MODEL_ID = 'candidate/qwen3.5-2b-onnx';

/**
 * Models that were once the everyday default and should yield to the CURRENT
 * device-appropriate default. Boot self-heal migrates an eco-fast slot still
 * bound to one of these — but device-aware: it rebinds to `recommend('eco-fast',
 * profile)`, not a fixed constant. Profiles primed before a graduation otherwise
 * keep the old model forever.
 *
 * LFM2.5-1.2B is here because the 2026-06-13 everyday-swap superseded it on
 * capable devices — but it is NOT demoted everywhere (it remains the default on
 * low-memory/non-Chromium devices). The device-aware rebind handles this: on a
 * low-memory device `recommend('eco-fast')` returns LFM2.5 itself, so the rebind
 * is a no-op.
 *
 * Bonsai used to sit here (the dev-era former default) but retired 2026-07-11 —
 * a bonsai-bound slot is now handled by the retirement migration in
 * lifecycle/self-heal.ts (RETIRED_MODEL_MIGRATIONS), which runs before this
 * former-default rebind, so it no longer needs a former-default entry.
 *
 * There is no eco-smart counterpart: no shipped code path has ever auto-bound the
 * eco-smart slot (setup and Settings both bind eco-fast), so there is no
 * system-written stale-smart-binding population to migrate.
 */
export const FORMER_EVERYDAY_DEFAULT_IDS: ReadonlyArray<string> = [
  'candidate/lfm2.5-1.2b-instruct-onnx',
];

/**
 * f16-less-but-WebGPU default (Track E Slice 4, 2026-06-30). On devices that run
 * WebGPU but lack the `shader-f16` feature — older-Intel desktops (C2) and ~all
 * Adreno Android (C3) — every q4f16 ONNX/MLC build is unassignable, but Gemma 4
 * (LiteRT, non-f16 `.litertlm`) loads fine. It is therefore the device-appropriate
 * default there — the f16-free floor role Bonsai used to share before it retired
 * (2026-07-11); LFM2.5-350M (onnx-q4) remains the light non-f16 fallback.
 * Empirically confirmed runnable on a shimmed-f16-less WebGPU device (#191: 51/51
 * generations, 0 errors). Where Gemma is ALSO unassignable (low-memory / WASM-only
 * / non-Chromium) it never enters the ranked list, so preferring it is a safe
 * no-op and natural fit-score ranking applies unchanged.
 */
export const PREFERRED_F16LESS_DEFAULT_MODEL_ID = 'candidate/gemma-4-e2b-litert';

/**
 * The universal instant-start floor: the smallest, f16-free starter rung every
 * device falls back to. It is EXEMPT from the download-fail auto-demotion
 * (slice 3) — demoting the floor would leave a device with nothing offerable
 * and break instant-start. Repeated download failures of even this model are an
 * environmental dead-end the demotion can't fix, so we never remove it.
 */
export const STARTER_FLOOR_MODEL_ID = 'candidate/lfm2.5-350m-onnx';

/** ≥ this many genuine download failures in 7 days demotes a model from auto-offer. */
export const DOWNLOAD_FAIL_DEMOTION_THRESHOLD = 2;

/**
 * Per-slot deliberate pick, promoted to the top of that slot's ranking when
 * assignable. eco-fast carries the everyday default; eco-smart carries the
 * bake-off-graduated smart pick. Resolved through `preferredModelIdForSlot`,
 * which layers in the f16-less default where the primary pick can't run.
 */
const PREFERRED_MODEL_ID_BY_SLOT: Readonly<Record<Slot, string>> = {
  'eco-fast': PREFERRED_DEFAULT_MODEL_ID,
  'eco-smart': PREFERRED_SMART_MODEL_ID,
};

/**
 * The device-appropriate preferred pick for a slot: the best-tier model THIS
 * device can actually run. The primary is the slot's f16 pick (Qwen3.5-2B); when
 * the device can't run it (no shader-f16, low memory, …) we fall back to the
 * f16-less default (Gemma 4) where assignable. The returned id is fed to
 * `promotePreferred`, which lifts it only if it survived the assignable +
 * admitted + slot + floor filters — so an unassignable fallback is a safe no-op
 * that yields to natural fit-score ranking (LFM2.5 / Qwen3-0.6B on smaller
 * devices). Layering here (not in fit scoring) keeps the preference explicit and
 * unit-testable rather than emergent from snappy-vs-balanced weighting.
 */
function preferredModelIdForSlot(slot: Slot, profile: DeviceProfile): string {
  const primary = PREFERRED_MODEL_ID_BY_SLOT[slot];
  if (isCatalogModelAssignable(primary, profile)) return primary;
  if (isCatalogModelAssignable(PREFERRED_F16LESS_DEFAULT_MODEL_ID, profile)) {
    return PREFERRED_F16LESS_DEFAULT_MODEL_ID;
  }
  return primary;
}

function isCatalogModelAssignable(modelId: string, profile: DeviceProfile): boolean {
  const model = getCatalog().find((m) => m.id === modelId);
  return model != null && isAssignable(model, profile);
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
 * Instant-start Stage A pick (slice 2b): the SMALLEST model this device can
 * run for the slot — the fastest trustworthy path to a working chat, not the
 * best one. First-run setup leads with this so a fresh device is chatting in
 * about a minute; the consent-driven upgrade (lifecycle/upgrade.ts) then
 * offers the class-best pick as a background download.
 *
 * Reuses the full listCandidates filter chain (assignable + admitted +
 * slot-matched + confidence floor), so a starter can never be a model the
 * engine wouldn't offer — including models this device recently smoke-failed.
 * Among survivors the smallest download wins; ties keep fit-score order
 * (listCandidates is already score-sorted and the scan is strict-less-than).
 * Returns null when nothing survives; callers fall back to the class-best
 * pick, which throws NoAssignableModelError on the same empty set.
 */
export function starterModelForSlot(
  slot: Slot,
  profile: DeviceProfile,
  intent: Intent = slotDefaultIntent(slot),
  options: ListCandidatesOptions = {},
): ModelConfig | null {
  const candidates = listCandidates(slot, profile, intent, options);
  if (candidates.length === 0) return null;
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
    if (!isAssignable(model, profile)) {
      continue; // unsupported devices: hard exclude
    }
    const admission = admit(model, profile);

    const floor = applyConfidenceFloor(model, profile, admission, {
      currentlyBoundModelId: options.currentlyBoundModelId,
      // Manual Settings list: never hide a model for download failures — the
      // user may always retry it by hand.
      demoteOnDownloadFail: false,
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
  // top spot (it is what a fresh device gets): Qwen3.5-2B on f16-capable
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
};
type FloorOutcome =
  | { admit: true; confidence: AvailableConfidence }
  | { admit: false };

function applyConfidenceFloor(
  model: ModelConfig,
  _profile: DeviceProfile,
  admission: AdmissionResult,
  options: FloorOptions,
): FloorOutcome {
  const isBound = options.currentlyBoundModelId === model.id;
  if (admission.decision === 'denied' && !isBound) return { admit: false };
  if (admission.recentFailureCount >= 1 && !isBound) return { admit: false };
  // Auto-demote a model that keeps failing to DOWNLOAD (≥2 in 7d) from the
  // auto-offer surfaces — this kills the re-offer nag loop. Two carve-outs: the
  // currently-bound model (never lose the user's pick) and the starter floor
  // (never leave a device with nothing offerable).
  if (
    options.demoteOnDownloadFail
    && !isBound
    && model.id !== STARTER_FLOOR_MODEL_ID
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
