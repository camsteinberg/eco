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
 * Everyday default (model-ladder read, 2026-08-09): LFM2.5-1.2B-instruct is the
 * default recommendation on any device that can run it. This REVERSES the
 * 2026-06-13 everyday-swap to Qwen3.5-2B. That swap graduated on a rubric-scored
 * bake-off; a by-eye read on real WebGPU (the rubric cannot see answer quality —
 * it scored reader-rejected output 1.00) found the 2B buys no clear everyday-quality
 * gain over the 1.2B while costing ~2–4× the speed, AND it hallucinates on
 * open-knowledge asks (fabricated Roman history) and mangles simple reasoning
 * (bat-and-ball headlined "$0.10"). The 1.2B is the fast, accurate everyday
 * workhorse: ~300ms first token / ~51 tok/s / ~4s per answer vs the 2B's
 * ~567ms / ~23 tok/s / ~15.5s. Evidence: m2-evidence/model-ladder-by-eye-2026-08-09.md
 * and deeper-tier-read-by-eye-2026-08-09.md.
 *
 * The 2B is NOT removed — it stays selectable via Settings ("Choose your own").
 * A genuinely-stronger DEEPER tier (LFM2-2.6B, which beats the 2B on reasoning/
 * knowledge at equal speed) graduated into the catalog on 2026-08-10 and is now
 * the eco-smart pick (see PREFERRED_SMART_MODEL_ID below).
 *
 * If the 1.2B is incompatible with the current device, the device-appropriate
 * default applies (see `preferredModelIdForSlot`): on f16-less-but-WebGPU adapters
 * (older-Intel desktop / Adreno Android) that is Gemma 4 (LiteRT) — see
 * PREFERRED_F16LESS_DEFAULT_MODEL_ID. On low-memory / WASM-only / non-Chromium
 * devices the natural fit-score ranking applies and the smaller compatible models
 * win (Qwen3-0.6B).
 *
 * Wired here (not in catalog data) to keep the change surface small for v1.0.
 * Future revisions may move this to a `defaultPreference` field on ModelConfig.
 */
export const PREFERRED_DEFAULT_MODEL_ID = 'candidate/lfm2.5-1.2b-instruct-onnx';

/**
 * Smart-slot pick — the graduated deeper tier. LFM2-2.6B graduated into the
 * shipping catalog on 2026-08-10 (a by-eye read on real WebGPU found it beats the
 * 2B on reasoning/history/code at equal speed; the rubric that had ranked the 2B
 * higher cannot see answer quality). Pointing this constant at it re-splits the
 * slots that the 2026-08-09 read had collapsed onto the 1.2B: eco-fast stays the
 * fast everyday default (LFM2.5-1.2B) and eco-smart is the deeper opt-in, which the
 * consent-driven upgrade card (lifecycle/upgrade.ts offers `recommend('eco-smart')`)
 * now surfaces as a genuine "deeper" download.
 *
 * The card only ever carries a device UP: the size guard in `planUpgradeOffer`
 * never offers a target that isn't a genuine step up in size, and the 1.2B everyday
 * default (0.76GB) → the 2.6B (1.65GB) is a real up-size. A fresh device still
 * chats on the 1.2B first; the deeper model is opt-in, never auto-pushed. Existing
 * 2B users keep their 2B (it stays selectable via Settings). Where the 2.6B is not
 * assignable (no shader-f16, low memory, non-Chromium), the slot falls back to the
 * f16-less default or the natural fit-score ranking.
 */
export const PREFERRED_SMART_MODEL_ID = 'candidate/lfm2-2.6b-onnx';

/**
 * Models that were once the everyday default and should yield to the CURRENT
 * device-appropriate default. Boot self-heal migrates an eco-fast slot still
 * bound to one of these — but device-aware: it rebinds to `recommend('eco-fast',
 * profile)`, not a fixed constant. Profiles primed before a graduation otherwise
 * keep the old model forever.
 *
 * Empty as of the 2026-08-09 model-ladder read. LFM2.5-1.2B was here (superseded
 * by the 2026-06-13 everyday-swap to Qwen3.5-2B) but that swap is now reversed —
 * the 1.2B is the CURRENT default, so it must not be migrated away from. The
 * outgoing Qwen3.5-2B is deliberately NOT added: the former-default rebind exists
 * to move auto-primed devices UP to a better default, not to force a working
 * bigger model DOWN to a smaller one. Auto-2B devices keep their 2B; only fresh
 * devices get the 1.2B. (An explicit user choice is exempt from this rebind
 * regardless — see hasExplicitModelChoice in self-heal.ts.)
 *
 * Bonsai used to sit here too (the dev-era former default) but retired 2026-07-11
 * — a bonsai-bound slot is handled by RETIRED_MODEL_MIGRATIONS in
 * lifecycle/self-heal.ts, which runs before this rebind.
 *
 * There is no eco-smart counterpart: no shipped code path has ever auto-bound the
 * eco-smart slot (setup and Settings both bind eco-fast), so there is no
 * system-written stale-smart-binding population to migrate.
 */
export const FORMER_EVERYDAY_DEFAULT_IDS: ReadonlyArray<string> = [];

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
 * The f16-less-but-WebGPU eco-FAST pick (device-coverage, 2026-08-10). On adapters
 * that run WebGPU but lack `shader-f16`, the everyday q4f16 1.2B default is
 * unassignable, and the old fallback (Gemma 4) is 1.87GB — over the instant-start
 * budget — so `starterModelForSlot` stepped the first download DOWN to the weak
 * 350M. The plain-int4 build of the SAME 1.2B
 * (`candidate/lfm2.5-1.2b-instruct-q4-onnx`, onnx-q4, 0.85GB) needs no shader-f16,
 * loads on the f16-less WebGPU EP, and — being ≤ STARTER_MAX_SIZE_GB — is its OWN
 * starter. So f16-less eco-fast gets the good 1.2B as its first impression,
 * converging starter==recommend exactly as the 2026-08-09 fix did for f16-capable
 * devices. Gemma 4 stays the f16-less eco-SMART (deeper) pick.
 */
export const PREFERRED_F16LESS_FAST_MODEL_ID = 'candidate/lfm2.5-1.2b-instruct-q4-onnx';

/**
 * Per-slot f16-less-but-WebGPU fallback: the best model such an adapter can run
 * for each slot. eco-fast → the plain-int4 1.2B (its own instant-start rung);
 * eco-smart → Gemma 4 (the deeper LiteRT pick). Layered in by
 * `preferredModelIdForSlot` only when the slot's primary q4f16 pick can't run.
 * Where the per-slot pick is ALSO unassignable (low-memory / WASM-only /
 * non-Chromium) it never enters the ranked list, so preferring it is a safe no-op
 * and natural fit-score ranking applies unchanged.
 */
const PREFERRED_F16LESS_MODEL_ID_BY_SLOT: Readonly<Record<Slot, string>> = {
  'eco-fast': PREFERRED_F16LESS_FAST_MODEL_ID,
  'eco-smart': PREFERRED_F16LESS_DEFAULT_MODEL_ID,
};

/**
 * The default instant-start floor: the smallest, f16-free starter rung most
 * devices fall back to. It is EXEMPT from the download-fail auto-demotion
 * (slice 3) — demoting the floor would leave a device with nothing offerable
 * and break instant-start. Repeated download failures of even this model are an
 * environmental dead-end the demotion can't fix, so we never remove it.
 *
 * NOT literally universal: on a `wasm-only` device this build is unassignable
 * (its block-quantized embeddings emit GatherBlockQuantized, unimplemented on
 * the CPU EP — see compatibility `cpuEpIncompatible`), so qwen3-0.6b is the
 * effective floor there. The demotion exemption below is keyed to THIS id, so
 * the wasm-only floor (qwen3-0.6b) is not itself exempt and can be demoted on
 * transient download failures, over-declining a runnable device until the 7-day
 * window clears (device-coverage audit, finding COV-3 — backlog, device-keyed
 * fix deferred).
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
 * No-WebGPU (WASM/CPU-EP) floor preference. On a `wasm-only` device the f16 primary
 * (requireWebgpu) and its f16-less int4 sibling BOTH can never load: the int4 LFM2.5
 * builds block-quantize embeddings → emit GatherBlockQuantized, which ort-web 1.26's
 * CPU/WASM EP does not implement (verified on-device 2026-08-10, three LFM2.5 builds).
 * So a no-GPU device needs its own preferred pick. SmolLM2-360M (onnx-int8) is the fast
 * floor — ~2.7× the retired qwen3-0.6b's CPU-EP throughput (8.1 vs 2.98 words/s on-device),
 * coherent + WebGPU/WASM-consistent, and small enough (0.37GB, 3GB memory floor) to reach
 * devices below the 4GB rung that previously got nothing. Qwen2.5-0.5B (int8, 4GB floor)
 * stays offerable as a higher-world-knowledge alternative on 4GB+ devices; qwen3-0.6b stays
 * in the catalog but is no longer the preferred floor. int8 has no block-quantized embeddings,
 * so it clears the wall — but it decodes far slower on the WebGPU EP than a WebGPU-native
 * build, so this preference is consulted ONLY on `webgpuSupport === 'wasm-only'`.
 */
export const PREFERRED_WASM_FLOOR_MODEL_ID = 'candidate/smollm2-360m-instruct-onnx';

const PREFERRED_WASM_FLOOR_MODEL_ID_BY_SLOT: Readonly<Record<Slot, string>> = {
  'eco-fast': PREFERRED_WASM_FLOOR_MODEL_ID,
  'eco-smart': PREFERRED_WASM_FLOOR_MODEL_ID,
};

/**
 * WebGPU floor preference. On a WebGPU device that can't run the 8GB-floor 1.2B
 * family (sub-8GB memory) yet isn't wasm-only, natural fit-ranking otherwise
 * surfaces LFM2.5-350M — a 0.35GB extraction-type model wrong for chat — as the
 * "Recommended" pick by a ~0.004 margin over the PROVEN qwen3-0.6b. Prefer the
 * proven 0.6B chat floor instead (FR-2). Where qwen3-0.6b is itself unassignable
 * (e.g. a shader-f16-less adapter, where only the 350M's onnx-q4 loads) this is a
 * safe no-op and natural ranking applies — the 350M stays the honest only option.
 */
export const PREFERRED_WEBGPU_FLOOR_MODEL_ID = 'local/qwen3-0.6b';

const PREFERRED_WEBGPU_FLOOR_MODEL_ID_BY_SLOT: Readonly<Record<Slot, string>> = {
  'eco-fast': PREFERRED_WEBGPU_FLOOR_MODEL_ID,
  'eco-smart': PREFERRED_WEBGPU_FLOOR_MODEL_ID,
};

/**
 * The device-appropriate preferred pick for a slot: the best-tier model THIS
 * device can actually run. The primary is the slot's f16 pick (LFM2.5-1.2B for
 * both slots today); when the device can't run it (no shader-f16, low memory, …)
 * we fall back to the slot's f16-less pick where assignable — the plain-int4 1.2B
 * for eco-fast, Gemma 4 for eco-smart (PREFERRED_F16LESS_MODEL_ID_BY_SLOT). The
 * returned id is fed to `promotePreferred`, which lifts it only if it survived the
 * assignable + admitted + slot + floor filters — so an unassignable fallback is a
 * safe no-op that yields to natural fit-score ranking (LFM2.5 / Qwen3-0.6B on
 * smaller devices). Layering here (not in fit scoring) keeps the preference
 * explicit and unit-testable rather than emergent from snappy-vs-balanced weighting.
 */
function preferredModelIdForSlot(slot: Slot, profile: DeviceProfile): string {
  const primary = PREFERRED_MODEL_ID_BY_SLOT[slot];
  if (isCatalogModelAssignable(primary, profile)) return primary;
  const f16lessFallback = PREFERRED_F16LESS_MODEL_ID_BY_SLOT[slot];
  if (isCatalogModelAssignable(f16lessFallback, profile)) {
    return f16lessFallback;
  }
  // No-WebGPU floor: neither the f16 primary nor its f16-less int4 sibling can load
  // on the CPU EP, so prefer the fast int8 floor (SmolLM2-360M where assignable, down
  // to 3GB). Gated to wasm-only so int8 never wins on a (low-memory) WebGPU device,
  // where it decodes far slower than a WebGPU-native build. Unassignable → safe no-op.
  if (profile.webgpuSupport === 'wasm-only') {
    const wasmFloor = PREFERRED_WASM_FLOOR_MODEL_ID_BY_SLOT[slot];
    if (isCatalogModelAssignable(wasmFloor, profile)) return wasmFloor;
  }
  // WebGPU floor (FR-2): a WebGPU (non-wasm) device that can't run the 1.2B family
  // — prefer the proven qwen3-0.6b over the weak 350M that fit-ranking would
  // otherwise surface as "Recommended". Unassignable → safe no-op.
  const webgpuFloor = PREFERRED_WEBGPU_FLOOR_MODEL_ID_BY_SLOT[slot];
  if (isCatalogModelAssignable(webgpuFloor, profile)) return webgpuFloor;
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
 * model wrong-type for chat that ALSO fails to load on WebGPU (GatherBlockQuantized).
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
    if (!isAssignable(model, profile)) {
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

function applyConfidenceFloor(
  model: ModelConfig,
  _profile: DeviceProfile,
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
