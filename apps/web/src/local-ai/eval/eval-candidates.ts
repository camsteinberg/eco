// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eval-only candidate lane (Phase 2).
 *
 * This model is NOT in the shipping v1.0 catalog (catalog-data.json), does NOT
 * appear in the user-facing chat ModelSelector or recommendation engine, and is
 * intentionally excluded from the catalog-size invariant. It exists so a
 * non-shipping instruction-tuned candidate can be downloaded + run through the
 * eval harness for an A/B against the shipping catalog.
 *
 * Phase-2 status: the lane originally held two fast candidates. LFM2.5-1.2B-Instruct
 * won the on-device A/B and GRADUATED into the shipping catalog as the new fast
 * default (catalog-data.json + the registry artifact-metadata, generation profile,
 * and chat-intent entries). Qwen3-1.7B remains here, parked as non-viable in Eco's
 * browser runtime; it stays in the lane for a future retry against an external-data
 * ONNX build. LFM2-2.6B was then added as the SMART-tier candidate (external-data
 * single causal-LM, same family as the fast default) to A/B against Phi-3 before a
 * potential smart-default graduation.
 *
 * Chat #7 M2 bake-off (2026-06-10): before graduating LFM2-2.6B, a model-sweep
 * research pass added three challengers so the smart-tier decision is a measured
 * bake-off, not an auto-graduation:
 *   - Qwen3.5-2B (ONNX-OPT, text-only q4f16, ~1.40GB) — WON the bake-off
 *     (run `eval-mq8s89xp-1xeys0c7`: instruction-following 5/5 vs the LFM2-2.6B
 *     incumbent's 2/5, honesty 2/2 vs 0/2, depth 339 vs 283 words, parity
 *     speed) and GRADUATED into the shipping catalog as the eco-smart pick
 *     (catalog-data.json + artifact-metadata.json + PREFERRED_SMART_MODEL_ID
 *     in selection/recommend.ts). LFM2-2.6B stays here as the beaten incumbent.
 *   - Qwen3.5-4B (ONNX-OPT, text-only q4f16, ~2.82GB; multi-chunk decoder) —
 *     high-memory quality-tier candidate (leads all <10B on Intelligence Index;
 *     cleanest dim profile in the bake-off — the eventual Phi-3 replacement track).
 *   - Gemma 4 E2B (base PTQ q4f16, text-only ~3.13GB) — eliminated on evidence
 *     (deterministic m2 arithmetic error, slowest decode). The preferred
 *     QAT-mobile q2f16 build is blocked on onnxruntime-web ^1.26 — 2-bit
 *     GatherBlockQuantized unsupported; see the artifact note on the model entry.
 * The remaining candidates are multimodal ONNX exports consumed TEXT-ONLY: their configs declare
 * `architectures: [*ForConditionalGeneration]`, so TJS 4.2.0's cross-architecture
 * branch (AutoModelForCausalLM → textOnly) loads ONLY `embed_tokens` +
 * `decoder_model_merged` — the pinned file lists intentionally omit the
 * vision/audio encoder files. See the chat #7 charter memory for the full
 * research record and decision criteria.
 *
 * How candidates stay dev-only: the same-origin proxy
 * (app/api/local-models/[...slug]/route.ts) resolves a normal user download from
 * the proxy-allowed (catalog) set; these candidates live ONLY in the
 * validation-allowed superset, which the proxy consults solely when
 * `isValidationHarnessRequestAllowed(headers)` is true — an environment gate
 * (loopback host + non-production). So they download on localhost dev and are
 * 403 in production.
 *
 * `loadModel(model)` (runtime/lifecycle.ts) takes a ModelConfig directly and
 * never re-resolves through getCatalog(), so these load fine without touching the
 * catalog. The eval harness resolves catalog ∪ eval-candidates by default; see
 * harness.defaultGetModel.
 *
 * The per-file metadata (`EVAL_CANDIDATE_ARTIFACT_METADATA`) is verified against
 * the pinned HuggingFace revision: the proxy SHA-256-verifies any file whose
 * reviewed `oid` is 64 chars (LFS) against the downloaded bytes; 40-char oids are
 * git-blob and pass through unverified.
 */

import type { ModelConfig } from '../types';

type ArtifactFileMetadataEntry = { sizeBytes: number; oid: string };

// ─── Candidate model configs ───────────────────────────────────────────────

const QWEN3_1_7B: ModelConfig = {
  id: 'candidate/qwen3-1.7b-onnx',
  friendlyName: 'Qwen3 1.7B',
  vendor: 'Alibaba',
  sizeGB: 1.44,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: {
    intent: ['snappy', 'balanced'],
    tasks: ['chat', 'writing', 'reasoning'],
    contextTokens: 4096,
  },
  bestFor:
    'Instruction-tuned chat and reasoning; the larger Qwen3 sibling for higher quality.',
  knownLimitation:
    'Non-viable in Eco\'s browser runtime: 1.43GB single-file q4f16 ONNX std::bad_allocs on onnxruntime-web session creation (even on 16GB). Retry needs an external-data build.',
  evidenceTier: 'predicted',
  systemRoleSupport: 'native',
  artifact: {
    hfId: 'onnx-community/Qwen3-1.7B-ONNX',
    revision: 'cc6a06a21d614e9b8e92a6adfab1074d4e7d2438',
    files: [
      'onnx/model_q4f16.onnx',
      'added_tokens.json',
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'merges.txt',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'vocab.json',
    ],
  },
};

// Smart-tier candidate (#4 Phase 2 follow-up): a higher-quality default for the
// eco-smart slot. Single text causal-LM in external-data q4f16 (model_q4f16.onnx +
// .onnx_data) — same family/format as the graduated LFM2.5-1.2B fast default, so it
// dodges the single-file bad_alloc that killed Qwen3-1.7B. To be A/B'd vs Phi-3.
const LFM2_2_6B: ModelConfig = {
  id: 'candidate/lfm2-2.6b-onnx',
  friendlyName: 'LFM2 2.6B',
  vendor: 'Liquid AI',
  sizeGB: 1.65,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: {
    intent: ['balanced', 'quality'],
    tasks: ['chat', 'writing', 'reasoning', 'code'],
    contextTokens: 4096,
  },
  bestFor:
    'Smart-tier candidate: higher-quality reasoning, writing, and code on capable laptops.',
  knownLimitation:
    'Phase-2 smart-tier evaluation candidate — not yet validated on real Eco hardware.',
  evidenceTier: 'predicted',
  systemRoleSupport: 'merge-first-user',
  artifact: {
    hfId: 'onnx-community/LFM2-2.6B-ONNX',
    revision: '9655cd41239618886d6ebf9b4ff20b892b295f78',
    files: [
      'onnx/model_q4f16.onnx',
      'onnx/model_q4f16.onnx_data',
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
  },
};

// ─── Chat #7 M2 bake-off candidates (added 2026-06-10) ──────────────────────
//
// Multimodal ONNX exports consumed text-only: pinned files cover ONLY what TJS
// requests on the AutoModelForCausalLM → textOnly path (embed_tokens +
// decoder_model_merged sessions + tokenizer/config files). Vision/audio encoder
// files are deliberately NOT pinned — TJS never requests them in this mode, and
// the proxy allowlist should stay minimal.

// Qwen3.5-2B GRADUATED (2026-06-11): it won the chat #7 smart-tier bake-off and
// moved to the shipping catalog (catalog-data.json) with its artifact metadata
// in catalog/artifact-metadata.json. Its lane entry was removed — the catalog
// is now its single source of truth (a model must never live in both sets;
// the registry would emit duplicate proxy artifacts).

// High-memory quality-tier candidate (tests the "~2GB catalog ceiling" that was
// never a deliberate decision). Decoder external data ships in TWO chunks
// (.onnx_data + .onnx_data_1) — exercises the per-file chunk-map path.
const QWEN35_4B: ModelConfig = {
  id: 'candidate/qwen3.5-4b-onnx',
  friendlyName: 'Qwen3.5 4B',
  vendor: 'Alibaba',
  sizeGB: 2.82,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: {
    intent: ['balanced', 'quality'],
    tasks: ['chat', 'writing', 'reasoning', 'code'],
    contextTokens: 4096,
  },
  bestFor:
    'Bake-off candidate: highest-quality option for high-memory devices (leads all <10B models on Intelligence Index).',
  knownLimitation:
    'Unvalidated in Eco\'s runtime; ~2.8GB download + multi-chunk decoder targets high-memory WebGPU devices only.',
  evidenceTier: 'predicted',
  systemRoleSupport: 'native',
  artifact: {
    hfId: 'onnx-community/Qwen3.5-4B-ONNX-OPT',
    revision: '57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7',
    files: [
      'onnx/decoder_model_merged_q4f16.onnx',
      'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/decoder_model_merged_q4f16.onnx_data_1',
      'onnx/embed_tokens_q4f16.onnx',
      'onnx/embed_tokens_q4f16.onnx_data',
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
  },
};

// Quality-ceiling candidate — 2.3B effective / 5.1B with per-layer embeddings.
// ARTIFACT NOTE (smoked 2026-06-10): the preferred QAT-mobile q2f16 build
// (onnx-community/gemma-4-E2B-it-qat-mobile-ONNX @ 5cd5514) is BLOCKED on
// onnxruntime-web ^1.26 — session creation fails in the WebGPU
// GatherBlockQuantized kernel (2-bit block-quantized gather unsupported;
// "Can't create a session ... gather_block_quantized.h:55"). Retry the QAT
// build on a future ORT-web bump; until then the lane carries the base PTQ
// q4f16 export (~3.13GB text-only). Known risks (bake-off verifies): the
// ~1.6GB embed_tokens external data lives in browser RAM (no mmap on web),
// and the Gemma family has an OPEN ORT-web fp16 overflow issue
// (microsoft/onnxruntime#26732, confirmed Gemma 3 only). Hybrid thinking
// template — the worker's universal enable_thinking:false covers it.
const GEMMA4_E2B: ModelConfig = {
  id: 'candidate/gemma-4-e2b-onnx',
  friendlyName: 'Gemma 4 E2B',
  vendor: 'Google',
  sizeGB: 3.13,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: {
    intent: ['balanced', 'quality'],
    tasks: ['chat', 'writing', 'reasoning', 'code'],
    contextTokens: 4096,
  },
  bestFor:
    'Bake-off candidate: strongest raw quality in the 2B class; future vision/audio path in the same artifact family.',
  knownLimitation:
    'Unvalidated in Eco\'s runtime. PTQ q4f16 fallback build (QAT-mobile q2f16 is ORT-web-blocked); ~1.6GB embeddings resident in RAM; ORT-web Gemma fp16 overflow lineage and KV-cache reuse compatibility unverified.',
  evidenceTier: 'predicted',
  systemRoleSupport: 'native',
  artifact: {
    hfId: 'onnx-community/gemma-4-E2B-it-ONNX',
    revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
    files: [
      'onnx/decoder_model_merged_q4f16.onnx',
      'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx',
      'onnx/embed_tokens_q4f16.onnx_data',
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
  },
};

// Community QAT-q4 Gemma 4 E2B (nico-martin, created 2026-06-11 — did not exist at the
// 2026-06-10 bake-off). QAT at q4 (not the ORT-web-blocked qat-mobile q2f16); tested whether
// QAT recovers the quality the base PTQ q4f16 build (GEMMA4_E2B below) lost. Text-only repo
// (no generation_config.json, no audio/vision encoders) — TJS textOnly path loads
// embed_tokens + decoder.
//
// RESULT (2026-06-15 fair-eval): DOES NOT LOAD. Downloads + verifies fine, then HANGS
// indefinitely at onnxruntime-web WebGPU session-create (reproduced uncached ~5min + cached
// ~3.75min, no error). Root: the q4 build block-quantizes the 1.76GB embedding table →
// GatherBlockQuantized, which ORT-web's WebGPU EP does NOT support (q2 hard-fails, q4 hangs;
// the q4f16 PTQ build keeps fp16 embeddings → regular Gather → loads). Forcing the WASM/CPU
// EP also grinds without completing for a 3.2GB model. onnxruntime-web 1.26 is the latest
// release — no engine fix. Kept lane-only as the test record; do NOT re-run blind or graduate.
// Full record: pitfall-gemma4-gatherblockquantized-webgpu.
const GEMMA4_E2B_QAT_Q4: ModelConfig = {
  id: 'candidate/gemma-4-e2b-qat-q4-onnx',
  friendlyName: 'Gemma 4 E2B QAT q4',
  vendor: 'Google',
  sizeGB: 3.2,
  runtime: 'transformers',
  format: 'onnx-q4',
  capabilities: {
    intent: ['balanced', 'quality'],
    tasks: ['chat', 'writing', 'reasoning', 'code'],
    contextTokens: 4096,
  },
  bestFor:
    'Bake-off candidate: a quantization-aware-trained (QAT) q4 Gemma 4 E2B (community conversion by nico-martin) — tests whether QAT recovers the quality the base PTQ build lost.',
  knownLimitation:
    "Does NOT load in Eco's runtime (verified 2026-06-15): hangs at onnxruntime-web WebGPU session-create because the q4 build block-quantizes its 1.76GB embedding table → GatherBlockQuantized, unsupported on ORT-web's WebGPU EP. WASM/CPU EP also impractical at this size. Lane-only test record.",
  evidenceTier: 'predicted',
  systemRoleSupport: 'native',
  artifact: {
    hfId: 'nico-martin/gemma-4-E2B-it-qat-q4-ONNX',
    revision: 'f83a0fb4825956b3d87687a30b7716e8692f1f70',
    files: [
      'onnx/decoder_model_merged_q4.onnx',
      'onnx/decoder_model_merged_q4.onnx_data',
      'onnx/embed_tokens_q4.onnx',
      'onnx/embed_tokens_q4.onnx_data',
      'chat_template.jinja',
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
  },
};

// Gemma 4 E2B (LiteRT) GRADUATED (2026-06-29): it became the f16-less (C2/C3)
// answer in the shipping catalog (catalog-data.json + catalog/artifact-metadata.json)
// — LiteRT productionized as Eco's third runtime (the model offering overhaul,
// Track E). Its lane entry
// was removed: a model must never live in both sets, or the registry emits
// duplicate proxy artifacts. The E4B sibling below stays eval-only.

// Gemma 4 E4B via LiteRT-LM Web — eval-only sibling of the E2B LiteRT
// candidate above. This is deliberately NOT a shipping catalog/default or
// recommendation entry; it exists only for same-channel evidence gathering in
// the validation/eval harness before any future product decision.
const GEMMA4_E4B_LITERT: ModelConfig = {
  id: 'candidate/gemma-4-e4b-litert',
  friendlyName: 'Gemma 4 E4B (LiteRT)',
  vendor: 'Google',
  sizeGB: 2.77,
  runtime: 'litert',
  format: 'litertlm',
  capabilities: {
    intent: ['balanced', 'quality'],
    tasks: ['chat', 'writing', 'reasoning', 'code'],
    contextTokens: 2048,
  },
  bestFor:
    'Eval-only LiteRT evidence candidate: tests whether the larger Gemma 4 LiteRT build improves quality over E2B through the same validation-selected product path, without changing Eco shipping defaults.',
  knownLimitation:
    "Dev-only third runtime (@litert-lm/core, early preview, Chromium WebGPU only). Single 2.97GB .litertlm bundle fetched through Eco's validation-only same-origin proxy; sampling maps temperature/top-k/top-p but has no repetition-penalty knob; KV-cache reuse across turns is not wired in the spike.",
  evidenceTier: 'predicted',
  systemRoleSupport: 'native',
  artifact: {
    hfId: 'litert-community/gemma-4-E4B-it-litert-lm',
    revision: 'f7ad3343bd6ebc9607f4dc3bc4f2398bd5749bc5',
    files: ['gemma-4-E4B-it-web.litertlm'],
  },
};

const MODELS: readonly ModelConfig[] = Object.freeze([
  Object.freeze(QWEN3_1_7B),
  Object.freeze(LFM2_2_6B),
  Object.freeze(QWEN35_4B),
  Object.freeze(GEMMA4_E2B),
  Object.freeze(GEMMA4_E2B_QAT_Q4),
  Object.freeze(GEMMA4_E4B_LITERT),
]);

const MODELS_BY_ID: ReadonlyMap<string, ModelConfig> = new Map(
  MODELS.map((model) => [model.id, model]),
);

// ─── Per-file artifact metadata ────────────────────────────────────────────
//
// EXACT values verified against the pinned HuggingFace revisions. 64-char oids
// are LFS SHA-256 (proxy verifies the bytes); 40-char oids are git-blob hashes
// (pass through unverified). Used by the registry to build the validation-allowed
// artifact's `fileMetadata` so the proxy can size/digest-verify downloads.

export const EVAL_CANDIDATE_ARTIFACT_METADATA: Readonly<
  Record<string, Record<string, ArtifactFileMetadataEntry>>
> = Object.freeze({
  'candidate/qwen3-1.7b-onnx': Object.freeze({
    'onnx/model_q4f16.onnx': { sizeBytes: 1426069098, oid: 'fb85b44defdf43ace50c7a4937127e889b9f8a0483eb87a6c4151a815c5da3b5' },
    'added_tokens.json': { sizeBytes: 707, oid: 'b54f9135e44c1e81047e8d05cb027af8bc039eed' },
    'chat_template.jinja': { sizeBytes: 4116, oid: '699ff8df401fe4788525e9c1f9b86a99eadd6230' },
    'config.json': { sizeBytes: 943, oid: '29522daabd113d097e62390bacec58f0fca04428' },
    'generation_config.json': { sizeBytes: 219, oid: 'f0e014517edce509b5d5f07cfa4855d79fad3bcf' },
    'merges.txt': { sizeBytes: 1671853, oid: '31349551d90c7606f325fe0f11bbb8bd5fa0d7c7' },
    'special_tokens_map.json': { sizeBytes: 613, oid: 'ac23c0aaa2434523c494330aeb79c58395378103' },
    'tokenizer.json': { sizeBytes: 9117040, oid: 'e7a95fce95bf5b0946d0ddb3f9d7caa030b7e850bbe92b0edb26bcf563e9f3d5' },
    'tokenizer_config.json': { sizeBytes: 9705, oid: '7ea8b974de6450e023f8e4977a8b7f30902cc3be' },
    'vocab.json': { sizeBytes: 2776833, oid: '4783fe10ac3adce15ac8f358ef5462739852c569' },
  }),
  'candidate/lfm2-2.6b-onnx': Object.freeze({
    'onnx/model_q4f16.onnx': { sizeBytes: 322750, oid: 'd98c4f6cf16c142f928127c01be89b0199d7a0c8223c60a756bfde21afe33878' },
    'onnx/model_q4f16.onnx_data': { sizeBytes: 1654910976, oid: '3dd89d13c6c716bba3fe196f9b6cd22abc51a1a476efb70a8c0151b14a5f8cfe' },
    'chat_template.jinja': { sizeBytes: 1296, oid: '99f3593d02fff6c0ac1f3c1293d5e2d1fa182dc8' },
    'config.json': { sizeBytes: 1757, oid: 'f71d662be57555ddc093ed57e47cbb7d752e895c' },
    'generation_config.json': { sizeBytes: 137, oid: 'b946d67bd1acd2149dd19aeb17a21b76e910a3ff' },
    'special_tokens_map.json': { sizeBytes: 434, oid: 'b28c8a1e9ecfa97dfc04bf0a5951183155ccc6d7' },
    'tokenizer.json': { sizeBytes: 3296920, oid: '3a6e61ec569abcf53b2127bfd8996cd7c2f30eff' },
    'tokenizer_config.json': { sizeBytes: 92936, oid: '6dbe82b868141e6d97d02a23bed9ae371f45daf3' },
  }),
  'candidate/qwen3.5-4b-onnx': Object.freeze({
    'onnx/decoder_model_merged_q4f16.onnx': { sizeBytes: 933554, oid: '8f159924389ced435ff445b9aaf1604d7de7756961299568f106990415bedcbb' },
    'onnx/decoder_model_merged_q4f16.onnx_data': { sizeBytes: 2065635328, oid: '83a2b12931978d2a3577f1f1a19e7ec42b87a760e87567dd26313fd933dcddd3' },
    // NOTE: data_1 and embed_tokens data are byte-identical LFS objects in this
    // repo (HF dedup of tied embedding weights) — same oid/size is intentional.
    'onnx/decoder_model_merged_q4f16.onnx_data_1': { sizeBytes: 367513600, oid: 'fc1bb145d8839272a87c71e0cb4d34832a0d7bb4de06ab4fb74fea1aa6ddf7e5' },
    'onnx/embed_tokens_q4f16.onnx': { sizeBytes: 1064, oid: '0e5fe965e5575b6428b7dea82661ed09bf7abadf29450c279e46e8113745110e' },
    'onnx/embed_tokens_q4f16.onnx_data': { sizeBytes: 367513600, oid: 'fc1bb145d8839272a87c71e0cb4d34832a0d7bb4de06ab4fb74fea1aa6ddf7e5' },
    'chat_template.jinja': { sizeBytes: 7756, oid: 'a585dec894e63da457d9440ec6aa7caa16d20860' },
    'config.json': { sizeBytes: 3198, oid: 'fde26e50a8587ab4a2aafc503d24678e74f42366' },
    'generation_config.json': { sizeBytes: 248, oid: '59ee4c198e909ccdc280d57660829658989582b2' },
    'tokenizer.json': { sizeBytes: 19226111, oid: '89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b' },
    'tokenizer_config.json': { sizeBytes: 9162, oid: 'b92de956c8b2d468de079efed8104ab7ec80281e' },
  }),
  'candidate/gemma-4-e2b-onnx': Object.freeze({
    'onnx/decoder_model_merged_q4f16.onnx': { sizeBytes: 673231, oid: '73c0f1fe04f9a3a048fb3319c0671b6cf0346bf33a3a8624c853bcffe01c24a4' },
    'onnx/decoder_model_merged_q4f16.onnx_data': { sizeBytes: 1519700992, oid: '3b27245a7396cb7039a4e4118bd2a8aa35106bae381522edf7c4867b5f22bb10' },
    'onnx/embed_tokens_q4f16.onnx': { sizeBytes: 5621, oid: 'd7ca53f6a169471b5699b2f57ee4c7aa2c73732b0152f3909e64b71384444825' },
    'onnx/embed_tokens_q4f16.onnx_data': { sizeBytes: 1590689792, oid: '024b199e6358ed42970f807686add5f9430d7e254ca7ce22fc9c83f015b9c517' },
    'chat_template.jinja': { sizeBytes: 16317, oid: '07e50e69a8c445f2c31a089b828e85b2a93942bf' },
    'config.json': { sizeBytes: 5549, oid: 'a7f7623b5229c8498655847bd9cdeea34e5017f6' },
    'generation_config.json': { sizeBytes: 238, oid: 'b2b0ab11eaf5317ad648bb48ce64b110532d661a' },
    'tokenizer.json': { sizeBytes: 19439251, oid: '47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566' },
    'tokenizer_config.json': { sizeBytes: 18807, oid: '8dc6453271e40decb8ebdb68f4f9421d306dd6b3' },
  }),
  'candidate/gemma-4-e2b-qat-q4-onnx': Object.freeze({
    'onnx/decoder_model_merged_q4.onnx': { sizeBytes: 2757274, oid: '23f6dfb651b51f75ccaee65cd6feb4ed2443105b4edf0aa2cebb2d90147312d2' },
    'onnx/decoder_model_merged_q4.onnx_data': { sizeBytes: 1425784832, oid: 'a6bbd8b57332a79ac8a4cfda7a8ed349c015fa7e522113eda1b46d40ec109767' },
    'onnx/embed_tokens_q4.onnx': { sizeBytes: 5142, oid: '2d8c8a2bcc30e8ded7f636967c2a58a346116583356dd933720b005fc88079c4' },
    'onnx/embed_tokens_q4.onnx_data': { sizeBytes: 1762656256, oid: 'fc6c6db4c1f72a7ee7c75c5e6ed11fcb2cc78e92e5214ed4fbc96026e1504361' },
    'chat_template.jinja': { sizeBytes: 16804, oid: 'dc032e46e28e0d325b18d26da1279cdda3afa8d7' },
    'config.json': { sizeBytes: 5097, oid: 'bf8fe268a14c8cc67143d153448ab5d3ad7b937f' },
    'tokenizer.json': { sizeBytes: 32169626, oid: 'cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f' },
    'tokenizer_config.json': { sizeBytes: 19949, oid: '6a79f1e4e96f21a1b9004ecb5966e795a1667914' },
  }),
  // Single self-contained .litertlm bundle (LFS, 64-char oid → proxy SHA-256-verifies it).
  // (gemma-4-e2b-litert GRADUATED to the shipping catalog 2026-06-29 — its metadata
  // now lives in catalog/artifact-metadata.json.)
  'candidate/gemma-4-e4b-litert': Object.freeze({
    'gemma-4-E4B-it-web.litertlm': { sizeBytes: 2969059328, oid: '3904d826d5dddd25ea173e85204caec09e68ba038116e9b992b69cbdc94f57a0' },
  }),
});

// ─── Accessors ──────────────────────────────────────────────────────────────

/** Return the eval-only candidate models (NOT in the shipping catalog). */
export function getEvalCandidateModels(): ModelConfig[] {
  return [...MODELS];
}

/** Look up an eval candidate by id, or null if it is not a candidate. */
export function getEvalCandidateModel(id: string): ModelConfig | null {
  return MODELS_BY_ID.get(id) ?? null;
}
