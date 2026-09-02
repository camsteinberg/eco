// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase C catalog tests.
 *
 * The v1.0 user-facing catalog is exactly 10 models. Every entry must carry the
 * full ModelConfig surface. These tests are the guard against silent drift in
 * the catalog data (especially: someone adding a model without going through the
 * design review that locks the catalog).
 *
 * Source: docs/design/2026-05-16/vision-and-architecture.md §2.4
 * Qwen3.5-2B graduated 2026-06-11 (chat #7 smart-tier bake-off winner).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCatalog, getEvalLaneModels, getModel } from '../catalog';
import catalogData from '../catalog-data.json';
import { getCapabilities } from '../capabilities';
import artifactMetadata from '../artifact-metadata.json';
import { isUsableSeedRecord, type RawReconciliationRecord } from '../../evidence/seed';
import seedData from '../../evidence/data/v1-launch-manual-evidence.json';

const V1_CATALOG_IDS = [
  'local/qwen3-0.6b',
  'candidate/lfm2.5-1.2b-instruct-onnx',
  'candidate/lfm2.5-1.2b-instruct-q4-onnx',
  'candidate/lfm2.5-350m-onnx',
  'candidate/qwen3.5-2b-onnx',
  'candidate/gemma-4-e2b-litert',
  'candidate/qwen2.5-0.5b-mlc',
  'candidate/granite-4.0-350m-onnx',
  'candidate/smollm2-360m-instruct-onnx',
  'candidate/lfm2-2.6b-onnx',
] as const;

const LICENSES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'licenses');

const TECHNICAL_ID_PATTERN =/q4f16|q4f|q4_1|webllm|onnx|fp16|q8|q4\b|q2f16|bnb4|mlc/i;

describe('local-ai catalog (Phase C)', () => {
  it('ships exactly 10 models', () => {
    expect(getCatalog()).toHaveLength(10);
  });

  // catalog-data.json holds BOTH lanes. `shipping` is the only thing separating
  // them, so the filter in getCatalog() is load-bearing for real: without it the
  // dev-only eval candidates would be recommendable, selectable and — through the
  // registry — publicly proxy-downloadable. Asserted on the REAL data, not a
  // fixture, and on the surfaces a user actually reaches.
  it('keeps every shipping:false entry out of the shipping catalog', () => {
    const raw = catalogData.models as ReadonlyArray<{ id: string; shipping: boolean }>;
    const evalLaneIds = raw.filter((m) => !m.shipping).map((m) => m.id);

    // Non-vacuous: the lane is genuinely in the same file.
    expect(evalLaneIds.length).toBeGreaterThan(0);
    expect(raw.length).toBe(getCatalog().length + evalLaneIds.length);

    const catalogIds = new Set(getCatalog().map((m) => m.id));
    for (const id of evalLaneIds) {
      expect(catalogIds.has(id), `${id} must not be in the shipping catalog`).toBe(false);
      expect(getModel(id), `getModel must not resolve ${id}`).toBeNull();
    }
    // ...and the lane accessor returns exactly those, so nothing is simply lost.
    expect(getEvalLaneModels().map((m) => m.id).sort()).toEqual([...evalLaneIds].sort());
  });

  // A tier assignment is a CHOICE on the serving path, so it owes a measurement
  // cited next to the code — the constraint register applied to model selection.
  // The R3c fold moved these assignments out of nine id constants in
  // selection/recommend.ts, whose comments carried the by-eye reads, the measured
  // throughputs and the evidence-doc filenames behind each pick. This test is what
  // stops the next fold from dropping that trail again: hold a rung, cite why.
  it('backs every tier assignment and the starter floor with recorded provenance', () => {
    for (const model of getCatalog()) {
      const provenance: Record<string, string> = model._provenance ?? {};
      const slots = Object.keys(model.tier);
      if (slots.length > 0) {
        // Either one entry covering the whole ladder position, or one per slot.
        const cited = '_provenance' in model
          && (provenance.tier !== undefined
            || slots.every((slot) => provenance[`tier.${slot}`] !== undefined));
        expect(cited, `${model.id} holds tier rung(s) ${slots.join('+')} with no _provenance`)
          .toBe(true);
      }
      if (model.starterFloor === true) {
        expect(provenance.starterFloor, `${model.id} is the starter floor with no _provenance`)
          .toEqual(expect.any(String));
      }
    }
  });

  // Non-vacuous: the recovered evidence must still carry the ORIGINAL measured
  // numbers, not a paraphrase. These are the values the deleted
  // PREFERRED_DEFAULT_MODEL_ID comment recorded for the 2026-08-09 by-eye read
  // that reversed the swap to Qwen3.5-2B — the specific thing a future rubric
  // score must not quietly overturn.
  it('keeps the measured numbers behind the everyday default, not a paraphrase', () => {
    const everyday = getModel('candidate/lfm2.5-1.2b-instruct-onnx')!;
    const cited = everyday._provenance!['tier.eco-fast']!;
    for (const token of [
      '~300ms first token', '~51 tok/s', '~4s per answer',
      '~567ms', '~23 tok/s', '~15.5s',
      'fabricated Roman history', '$0.10',
      'm2-evidence/model-ladder-by-eye-2026-08-09.md',
      'deeper-tier-read-by-eye-2026-08-09.md',
    ]) {
      expect(cited, `everyday-default provenance lost "${token}"`).toContain(token);
    }
  });

  // Every shipping entry declares which device tier it is the default for. The
  // ladder selection/recommend.ts walks is this data, not id literals in the
  // engine — so a rung that silently emptied would change what a device is
  // offered. Pinned per rung.
  it('fills the recommendation ladder from the catalog, one model per rung', () => {
    const rungs = new Map<string, string>();
    for (const model of getCatalog()) {
      for (const [slot, tier] of Object.entries(model.tier)) {
        expect(rungs.has(`${slot}/${tier}`), `${slot}/${tier} claimed twice`).toBe(false);
        rungs.set(`${slot}/${tier}`, model.id);
      }
    }
    expect(Object.fromEntries(rungs)).toEqual({
      'eco-fast/capable': 'candidate/lfm2.5-1.2b-instruct-onnx',
      'eco-fast/laptop': 'candidate/lfm2.5-1.2b-instruct-q4-onnx',
      'eco-fast/phone': 'candidate/smollm2-360m-instruct-onnx',
      'eco-fast/floor': 'local/qwen3-0.6b',
      // R5c: rungs added when the fit scorer was deleted (recommend.ts /
      // catalog.ts TIER_ORDER doc comments explain each). `light` is the
      // last-resort WebGPU-general pick reached only when `floor`'s own
      // occupant is unassignable; `webkit-mobile` is the sole model iOS/
      // WebKit-mobile can ever run, on both slots.
      'eco-fast/light': 'candidate/lfm2.5-350m-onnx',
      'eco-fast/webkit-mobile': 'candidate/qwen2.5-0.5b-mlc',
      'eco-smart/capable': 'candidate/lfm2-2.6b-onnx',
      'eco-smart/laptop': 'candidate/gemma-4-e2b-litert',
      'eco-smart/phone': 'candidate/granite-4.0-350m-onnx',
      'eco-smart/floor': 'local/qwen3-0.6b',
      'eco-smart/light': 'candidate/lfm2.5-1.2b-instruct-q4-onnx',
      'eco-smart/webkit-mobile': 'candidate/qwen2.5-0.5b-mlc',
    });
  });

  it('ships the locked v1.0 catalog ids in source order', () => {
    expect(getCatalog().map((m) => m.id)).toEqual(V1_CATALOG_IDS);
  });

  it.each(V1_CATALOG_IDS)('exposes all required ModelConfig fields for %s', (id) => {
    const model = getModel(id);
    expect(model, id).not.toBeNull();
    expect(model!.id, `${id}.id`).toBe(id);
    expect(model!.friendlyName, `${id}.friendlyName`).toMatch(/\S/);
    expect(model!.vendor, `${id}.vendor`).toMatch(/\S/);
    expect(model!.sizeGB, `${id}.sizeGB`).toBeGreaterThan(0);
    expect(['transformers', 'litert', 'webllm']).toContain(model!.runtime);
    expect(['onnx-q4', 'onnx-q4f16', 'onnx-int8', 'litertlm', 'mlc-q4f16']).toContain(model!.format);
    expect(model!.capabilities.intent.length, `${id}.capabilities.intent`).toBeGreaterThan(0);
    expect(model!.capabilities.tasks.length, `${id}.capabilities.tasks`).toBeGreaterThan(0);
    expect(model!.capabilities.contextTokens, `${id}.capabilities.contextTokens`).toBeGreaterThan(0);
    expect(model!.bestFor, `${id}.bestFor`).toMatch(/\S/);
    expect(model!.knownLimitation, `${id}.knownLimitation`).toMatch(/\S/);
    expect(['proven', 'predicted', 'experimental']).toContain(model!.evidenceTier);
  });

  // Context windows are per-model MEASURED values, not defaults: 8192 requires
  // real-WebGPU memory-headroom evidence for that exact model (LFM2.5-1.2B +
  // Qwen3.5-2B verified 2026-06-12; both are hybrid-attention = small KV).
  // The rest stay 4096 deliberately — the small/legacy models haven't earned a
  // measurement. Raising any value here means a fresh headroom run first.
  it('pins the measured per-model context windows', () => {
    const expected: Record<(typeof V1_CATALOG_IDS)[number], number> = {
      'local/qwen3-0.6b': 4096,
      // LFM2.5-1.2B: LOWERED 8192 → 4096 on 2026-08-26 after real-WebGPU headroom
      // probes on a 16GB M1 Pro (Chromium, Metal): ~8k input = GPU OOM ("Failed
      // to allocate memory for buffer mapping", runtime left dead); ~6k (chat's
      // old 75% budget) = correct but 59s to first token, 1.4 tok/s, tab at
      // 3.2GB with system free memory at 18%; ~4k = correct, ~23s first token.
      // 4096 keeps chat's history budget at 3072, inside the measured-safe band.
      // Raising it again needs the ctx-stress-6k/8k probes to pass on the
      // weakest device class we ship it to, not just this Mac.
      'candidate/lfm2.5-1.2b-instruct-onnx': 4096,
      // The f16-less plain-int4 build of the same 1.2B — same window.
      'candidate/lfm2.5-1.2b-instruct-q4-onnx': 4096,
      'candidate/lfm2.5-350m-onnx': 4096,
      'candidate/qwen3.5-2b-onnx': 8192,
      // Passed as the engine's maxNumTokens. MEASURED 2026-09-01 (s37 context
      // probes, production build): loads at 32768 and passes two-fact recall
      // at ~12k prompt tokens, 14 s TTFT. The old 2048 made the engine throw
      // past it. This lane windows on a chars-per-token upper bound, so the
      // real prompt stays about 8k tokens at this value. See the entry's provenance.
      'candidate/gemma-4-e2b-litert': 32768,
      // Qwen2.5-0.5B is natively 32k, but the WebKit-mobile pick is deliberately
      // capped at 4096 to bound the KV-cache working set inside iOS's per-tab
      // memory envelope. This value is enforced engine-side via
      // ModelRecord.overrides.context_window_size (see runtime/webllm-config.ts),
      // not just clamped in what Eco sends. Raising it needs a fresh on-device run.
      'candidate/qwen2.5-0.5b-mlc': 4096,
      // The no-GPU CPU-EP floor models (deeper q4 Granite + lightest int8 SmolLM2).
      // Both are natively larger-context (Granite 32k / SmolLM2 8k) but capped at 4096
      // to bound the KV-cache working set on the weak, memory-tight devices this floor serves.
      'candidate/granite-4.0-350m-onnx': 4096,
      'candidate/smollm2-360m-instruct-onnx': 4096,
      // LFM2-2.6B graduated 2026-08-10 at the eval-lane's declared 4096 — no
      // headroom run has yet earned a larger window (raising it needs one first).
      'candidate/lfm2-2.6b-onnx': 4096,
    };
    for (const id of V1_CATALOG_IDS) {
      expect(getModel(id)!.capabilities.contextTokens, id).toBe(expected[id]);
    }
  });

  // systemRoleSupport is the per-model strategy normalizeMessagesForTemplate
  // applies before apply_chat_template; it must match what each model's real
  // chat template actually supports. Audited against the pinned tokenizers
  // 2026-08-11: every shipping transformers-runtime model's template has a
  // native system role (verified: the system content survives render), so each
  // carries "native". (Phi-3 was the sole "merge-first-user" model — its onnx-web
  // template rendered only user/assistant turns, silently dropping system content
  // — and was retired 2026-08-15, MC-2.) LiteRT/WebLLM models format prompts in
  // their own runtimes and are out of this audit's scope.
  it('pins the audited systemRoleSupport per transformers-runtime model', () => {
    const expected: Record<string, string> = {
      'local/qwen3-0.6b': 'native',
      'candidate/lfm2.5-1.2b-instruct-onnx': 'native',
      'candidate/lfm2.5-1.2b-instruct-q4-onnx': 'native',
      'candidate/lfm2.5-350m-onnx': 'native',
      'candidate/qwen3.5-2b-onnx': 'native',
      'candidate/granite-4.0-350m-onnx': 'native',
      'candidate/smollm2-360m-instruct-onnx': 'native',
      // LFM2-2.6B graduated 2026-08-10. Its template natively extracts a leading
      // system message (messages[0] role==system → renders <|im_start|>system),
      // the same shape as its LFM2.5-1.2B sibling — audited against the pinned
      // chat_template.jinja, so it is 'native', not the 'merge-first-user' the
      // eval-lane draft carried.
      'candidate/lfm2-2.6b-onnx': 'native',
    };
    for (const [id, strategy] of Object.entries(expected)) {
      expect(getModel(id)!.systemRoleSupport, id).toBe(strategy);
    }
  });

  // evidenceTier is a truth claim, not decoration: 'proven' drives a higher
  // predicted-tier smoke-pass (0.9 vs 0.7) and trust in scoring, and it tells the
  // user this model was actually validated on hardware like theirs. The label must
  // therefore match the shipped seed evidence. We pin the exact per-model tier so a
  // silent flip is caught, and enforce the structural invariant that every 'proven'
  // model is backed by >=1 usable seed row. This invariant would have caught
  // lfm2-2.6b shipping 'proven' with zero seed rows (Wave-3 evidence-truth, TIER-1).
  const EXPECTED_TIERS: Record<(typeof V1_CATALOG_IDS)[number], 'proven' | 'predicted' | 'experimental'> = {
    'local/qwen3-0.6b': 'proven',
    'candidate/lfm2.5-1.2b-instruct-onnx': 'proven',
    'candidate/lfm2.5-1.2b-instruct-q4-onnx': 'predicted',
    'candidate/lfm2.5-350m-onnx': 'predicted',
    'candidate/qwen3.5-2b-onnx': 'proven',
    'candidate/gemma-4-e2b-litert': 'predicted',
    'candidate/qwen2.5-0.5b-mlc': 'predicted',
    'candidate/granite-4.0-350m-onnx': 'predicted',
    'candidate/smollm2-360m-instruct-onnx': 'predicted',
    // Deeper eco-smart pick; 'predicted' pending a second-machine by-eye
    // validation (it carries no seed row of its own — see the invariant below).
    // promotePreferred still pins it as the eco-smart PICK regardless of tier.
    'candidate/lfm2-2.6b-onnx': 'predicted',
  };

  // Models permitted to carry 'proven' without a backing seed row, each with a
  // documented reason. Empty today: every 'proven' model is genuinely seed-backed.
  // A future re-graduation of lfm2-2.6b to 'proven' must add either a real seed
  // row or an explicit waiver entry here — not a silent label change.
  const PROVEN_SEED_WAIVERS: Readonly<Record<string, string>> = {};

  it('pins the per-model evidenceTier so the label cannot silently drift from the data', () => {
    for (const id of V1_CATALOG_IDS) {
      expect(getModel(id)!.evidenceTier, id).toBe(EXPECTED_TIERS[id]);
    }
  });

  it("backs every 'proven' model with >=1 usable seed row (existence, not freshness) or a documented waiver", () => {
    // Existence, NOT freshness: row recency is the 45-day-TTL concern owned by the
    // seed-freshness test. A fresh-based check here would fire on every 'proven'
    // model the moment the shipped seed ages past the TTL — a different failure.
    const rows = (seedData.routingEvidenceReconciliation ?? []) as unknown as RawReconciliationRecord[];
    const modelsWithUsableSeed = new Set(
      rows
        .filter((r) => typeof r.modelId === 'string' && isUsableSeedRecord(r))
        .map((r) => r.modelId as string),
    );
    // Not vacuous: the seed data must actually back some models.
    expect(modelsWithUsableSeed.size).toBeGreaterThan(0);

    const provenModels = getCatalog().filter((m) => m.evidenceTier === 'proven');
    expect(provenModels.length).toBeGreaterThan(0);
    for (const model of provenModels) {
      const backed = modelsWithUsableSeed.has(model.id) || model.id in PROVEN_SEED_WAIVERS;
      expect(
        backed,
        `${model.id} is 'proven' but has no usable seed row and no documented PROVEN_SEED_WAIVERS entry`,
      ).toBe(true);
    }
  });

  // Phase K invariant 10 (no technical IDs in user copy) starts to bite here —
  // the friendlyName + bestFor + knownLimitation are surfaced directly in UI.
  // Vendor strings are an exception (e.g., "MLC AI" is a real org name).
  it.each(V1_CATALOG_IDS)('uses a non-technical friendlyName for %s', (id) => {
    const model = getModel(id)!;
    expect(model.friendlyName, `${id}.friendlyName should not contain technical tokens`).not.toMatch(
      TECHNICAL_ID_PATTERN,
    );
  });

  it.each(V1_CATALOG_IDS)('keeps bestFor copy free of technical artifact tokens for %s', (id) => {
    const model = getModel(id)!;
    expect(model.bestFor, `${id}.bestFor should not contain technical tokens`).not.toMatch(
      TECHNICAL_ID_PATTERN,
    );
  });

  it('returns null for unknown model ids', () => {
    expect(getModel('local/does-not-exist')).toBeNull();
    expect(getModel('')).toBeNull();
  });

  it('returns null for lab-only model ids (catalog is the v1.0 set, not the universe)', () => {
    // smollm3-3b is in the lab, not the v1.0 catalog. Catalog must NOT surface it.
    expect(getModel('local/smollm3-3b')).toBeNull();
    expect(getModel('candidate/bitnet-b158')).toBeNull();
  });

  // MC-2 (2026-08-15): Phi-3 Mini was retired — never-reachable dead wiring (its
  // 16GB-memory + Chromium-only compatibility rule can never be met, because
  // navigator.deviceMemory is spec-clamped to <=8GB on Chromium and absent on the
  // non-Chromium browsers the rule already excluded). This guard proves the
  // catalog, its artifact metadata, and the proxy-facing HF repo are all clear so
  // it can never silently return.
  it('has retired Phi-3 Mini (MC-2) — absent from the catalog and its artifact metadata', () => {
    const RETIRED_ID = 'local/phi3-mini-4k-q4f16';
    expect(getModel(RETIRED_ID)).toBeNull();
    expect(getCatalog().some((m) => m.id === RETIRED_ID)).toBe(false);
    expect(RETIRED_ID in (artifactMetadata as Record<string, unknown>)).toBe(false);
    expect(
      getCatalog().some((m) => m.artifact?.hfId === 'microsoft/Phi-3-mini-4k-instruct-onnx-web'),
    ).toBe(false);
  });

  it('returns a frozen catalog snapshot — callers cannot mutate the source', () => {
    const snapshot = getCatalog();
    const original = snapshot[0]!;
    // Runtime check: Object.freeze refuses writes in strict mode.
    expect(() => {
      (original as { friendlyName: string }).friendlyName = 'tampered';
    }).toThrow();
    // And the array itself is a copy — mutating it doesn't break the next reader.
    snapshot.length = 0;
    expect(getCatalog()).toHaveLength(10);
  });

  // The catalog's artifact files must have corresponding entries in
  // artifact-metadata.json (the proxy's integrity-verification source).
  // Drift = 403 in production (the exact failure that prompted commit
  // bdb352ac). This invariant test catches drift at build time.
  it.each(V1_CATALOG_IDS)('artifact has complete file metadata for %s', (id) => {
    const model = getModel(id)!;
    expect(model.artifact, `${id}.artifact`).toBeDefined();
    const allMetadata = artifactMetadata as unknown as Record<string, Record<string, { sizeBytes: number; oid: string }> | undefined>;
    const metadata = allMetadata[id];
    expect(metadata, `${id} missing from artifact-metadata.json`).toBeDefined();
    for (const file of model.artifact!.files) {
      const entry = metadata![file];
      expect(entry, `${id} artifact-metadata.json missing entry for ${file}`).toBeDefined();
      expect(entry!.sizeBytes, `${id} ${file} sizeBytes`).toBeGreaterThan(0);
      expect(entry!.oid, `${id} ${file} oid`).toMatch(/^[0-9a-f]+$/);
    }
  });

  // Bootstrap reads model.artifact to build the DownloadPlan; the proxy
  // allowlist enforces the exact paths server-side. Mismatches surface as
  // 403s in production, so every catalog model MUST ship an artifact.
  it.each(V1_CATALOG_IDS)('ships a complete artifact block for %s', (id) => {
    const model = getModel(id)!;
    expect(model.artifact, `${id}.artifact`).toBeDefined();
    const artifact = model.artifact!;
    expect(artifact.hfId, `${id}.artifact.hfId`).toMatch(/^[\w.-]+\/[\w.-]+$/); // org/repo
    expect(artifact.revision, `${id}.artifact.revision`).toMatch(/^[0-9a-f]{40}$/); // pinned SHA
    expect(artifact.files.length, `${id}.artifact.files`).toBeGreaterThan(0);
    for (const file of artifact.files) {
      // file paths are HF-relative; no leading slash, no traversal.
      expect(file, `${id}.artifact.files contains a bad path`).toMatch(/^[\w./-]+$/);
      expect(file.startsWith('/'), `${id}.artifact.files entry starts with /`).toBe(false);
      expect(file.includes('..'), `${id}.artifact.files entry contains ..`).toBe(false);
    }
  });

  // generation_config.json is silently LOAD-BEARING for correct end-of-turn
  // stopping on the transformers runtime. Transformers.js builds its
  // EosTokenCriteria from generation_config.json's eos_token_id, which OVERRIDES
  // config.json's, and the worker passes no eos override — so this file is the
  // authoritative stop set. Audited against the pinned tokenizers 2026-08-11:
  // for Qwen3.5-2B the turn-ender <|im_end|> (248046) lives ONLY in
  // generation_config.json — config.json carries
  // a scalar/omitted eos that does NOT include the turn-ender (Qwen3.5-2B's
  // config.json has no eos_token_id at all). TJS loads generation_config.json
  // NON-fatally, so if a catalog edit ever drops it from files[], EOS falls back
  // to the wrong/absent config.json eos and the model runs to max_new_tokens
  // every turn — a 100% stall for Qwen3.5-2B, which has no fallback. This guard
  // makes the dependency explicit so it can't be removed by accident. (LiteRT /
  // WebLLM models format prompts and stop in their own runtimes and never read
  // this file, so the invariant is scoped to the transformers runtime.)
  it('ships generation_config.json for every transformers-runtime model (EOS stop is load-bearing)', () => {
    const transformersModels = getCatalog().filter((m) => m.runtime === 'transformers');
    // Guard against a filter that silently matches nothing (e.g. a runtime rename).
    expect(transformersModels.length).toBeGreaterThan(0);
    for (const model of transformersModels) {
      expect(model.artifact?.files, `${model.id}.artifact.files`).toContain(
        'generation_config.json',
      );
    }
  });

  // Eco redistributes the model weights (the /api/local-models proxy streams
  // them, and scripts/mirror-models-to-r2.mjs mirrors them to our own CDN), so
  // we are a REDISTRIBUTOR: Apache-2.0 §4(a) and LFM Open License v1.0 §4(a)
  // both require the license to travel with the work. That obligation is only
  // discharged if the catalog actually knows each model's license — this block
  // makes a license-less catalog entry a build failure rather than a quiet gap.
  const LFM_LICENSED_IDS = [
    'candidate/lfm2.5-1.2b-instruct-onnx',
    'candidate/lfm2.5-1.2b-instruct-q4-onnx',
    'candidate/lfm2.5-350m-onnx',
    'candidate/lfm2-2.6b-onnx',
  ] as const;

  it.each(V1_CATALOG_IDS)('declares a complete weights license for %s', (id) => {
    const license = getModel(id)!.license;
    expect(license, `${id}.license`).toBeDefined();
    expect(license.name, `${id}.license.name`).toMatch(/\S/);
    expect(license.url, `${id}.license.url`).toMatch(/^https:\/\/\S+$/);
    // The ORIGINAL author's repo, not the repack we happen to download from.
    expect(license.upstreamRepo, `${id}.license.upstreamRepo`).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(typeof license.confirmed, `${id}.license.confirmed`).toBe('boolean');
    expect(license.textFile, `${id}.license.textFile`).toMatch(/^[\w.-]+\.txt$/);
    // Non-null only where the download repo really carries the file; verified
    // over HTTP at the pinned revision, never assumed.
    if (license.artifactLicenseFile !== null) {
      expect(license.artifactLicenseFile, `${id}.license.artifactLicenseFile`).toMatch(
        /^[\w./-]+$/,
      );
    }
  });

  // The LFM models are NOT open-source licensed: commercial use is conditioned
  // on the licensee's annual revenue staying under US$10M. If that note ever
  // goes missing the /licenses page silently stops warning about it, so pin it.
  it.each(LFM_LICENSED_IDS)('carries the commercial-use limitation for %s', (id) => {
    const license = getModel(id)!.license;
    expect(license.spdx, `${id}.license.spdx`).toBeNull();
    expect(license.name, `${id}.license.name`).toBe('LFM Open License v1.0');
    expect(license.commercialUseNote, `${id}.license.commercialUseNote`).toMatch(/\S/);
    expect(license.commercialUseNote, `${id}.license.commercialUseNote`).toContain('$10 million');
    // Point at THIS model's own license file. All four LFM texts are the same
    // license, which makes it easy to link a sibling's repo by accident and
    // attribute the model to the wrong work.
    expect(license.url, `${id}.license.url`).toBe(
      `https://huggingface.co/${license.upstreamRepo}/blob/main/LICENSE`,
    );
  });

  it('claims an SPDX id only for the models that really carry one', () => {
    const lfmIds = new Set<string>(LFM_LICENSED_IDS);
    for (const model of getCatalog()) {
      if (lfmIds.has(model.id)) continue;
      expect(model.license.spdx, `${model.id}.license.spdx`).toBe('Apache-2.0');
      expect(model.license.commercialUseNote, `${model.id}.license.commercialUseNote`)
        .toBeUndefined();
    }
  });

  // Gemma 4's publisher declares apache-2.0 in the model-card metadata but also
  // points `license_link` at Google's own Gemma license page — a contradiction
  // we have NOT resolved. `confirmed: false` is what makes the UI say "declared
  // by the publisher, not yet confirmed" instead of implying we checked.
  it('marks only the unverified license declarations as unconfirmed', () => {
    const unconfirmed = getCatalog()
      .filter((m) => !m.license.confirmed)
      .map((m) => m.id);
    expect(unconfirmed).toEqual(['candidate/gemma-4-e2b-litert']);
  });

  // The obligation is discharged by SHIPPING the text, not by knowing the URL.
  // Every entry must resolve to a real license file: either one the download
  // repo itself carries at the pinned revision (verified over HTTP, in
  // artifact.files, so the download contains it), or the verbatim copy held in
  // catalog/licenses/ that scripts/mirror-models-to-r2.mjs uploads next to the
  // weights and /licenses renders. A dangling textFile means we redistribute
  // weights with no license anywhere — exactly the gap this test exists to stop.
  it.each(V1_CATALOG_IDS)('ships the license text that travels with %s', (id) => {
    const model = getModel(id)!;
    const license = model.license;

    const textPath = join(LICENSES_DIR, license.textFile);
    expect(existsSync(textPath), `${id} license.textFile missing at ${textPath}`).toBe(true);
    const text = readFileSync(textPath, 'utf8');
    expect(text.length, `${id} ${license.textFile} is empty`).toBeGreaterThan(1000);
    // Provenance header: where the verbatim text came from and when.
    expect(text.split('\n')[0], `${id} ${license.textFile} header`).toMatch(
      /^Verbatim copy of the license text fetched from https:\/\/\S+ on \d{4}-\d{2}-\d{2}\.$/,
    );

    if (license.artifactLicenseFile !== null) {
      // Claimed present in the download repo → it must really be downloaded,
      // with reviewed metadata, or the proxy 403s it.
      expect(model.artifact!.files, `${id}.artifact.files`).toContain(license.artifactLicenseFile);
      const allMetadata = artifactMetadata as unknown as Record<
        string,
        Record<string, { sizeBytes: number; oid: string }> | undefined
      >;
      const entry = allMetadata[id]![license.artifactLicenseFile];
      expect(entry, `${id} artifact-metadata.json missing ${license.artifactLicenseFile}`)
        .toBeDefined();
      expect(entry!.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('names license texts that are all actually used (no orphan files)', () => {
    const referenced = new Set(getCatalog().map((m) => m.license.textFile));
    const onDisk = readdirSync(LICENSES_DIR).filter((f) => f.endsWith('.txt'));
    expect(onDisk.length).toBeGreaterThan(0);
    expect([...onDisk].sort()).toEqual([...referenced].sort());
  });

  it('exposes capabilities via the dedicated capabilities surface', () => {
    const model = getModel('local/qwen3-0.6b')!;
    const caps = getCapabilities(model);
    expect(caps.intent).toEqual(model.capabilities.intent);
    expect(caps.tasks).toEqual(model.capabilities.tasks);
    expect(caps.contextTokens).toBe(model.capabilities.contextTokens);

    // capabilities returns copies — caller mutation doesn't poison the catalog.
    caps.intent.push('quality');
    expect(getCapabilities(model).intent).toEqual(model.capabilities.intent);
  });
});
