# Seed Evidence Data Provenance

This file documents the provenance of each backfill record in
`v1-launch-manual-evidence.json`. Records are grouped by source type.

## Retirements

**2026-07-10 — SmolLM2 (`local/smollm2-1.7b-webllm-q4f16`) retired.** Every SmolLM2
row was removed from `v1-launch-manual-evidence.json` (both the
`src/local-ai/evidence/data/` and `src/lib/data/` copies): the
`routingEvidenceReconciliation` entry, the `finalLabDecision` decision, the
`launchReadiness.manualEligibleModelIds` id, and the `modelStateMatrix` entry.
The model was the sole user of the WebLLM/MLC runtime (retired with it, registry
C1); its last fresh eval rerun failed 4/4 at load with `Quota exceeded.`, so it
never carried an admitted runtime seed. A boot migration
(`lifecycle/self-heal.ts`) purges any orphaned per-device state on affected
clients. The historical provenance line below is kept as a record of the row
that existed before removal.

**2026-07-11 — Bonsai (`local/bonsai-1.7b-q4`) retired.** Every Bonsai row was
removed from `v1-launch-manual-evidence.json` (both copies): the
`routingEvidenceReconciliation` entry, the
`launchReadiness.manualEligibleModelIds` id, and the `modelStateMatrix` entry.
Bonsai was the dev-era former everyday default — quality-demoted and loop-prone;
its f16-less WebGPU floor role is now served by Gemma 4 E2B (LiteRT). A boot
migration (`lifecycle/self-heal.ts`) purges any orphaned per-device state. The
eval-lane `bonsai` generation profile and the `candidate/ternary-bonsai-1.7b-onnx`
records are a DIFFERENT model and are left intact. The historical benchmark line
below is kept as a record of the row that existed before removal.

**2026-08-15 — Dead lab blocks + duplicate copy removed (Wave-3 evidence-truth).**
The reader-less top-level blocks `finalLabDecision`, `launchReadiness`, and
`modelStateMatrix` were stripped from `v1-launch-manual-evidence.json`:
production reads only `routingEvidenceReconciliation` (plus `generatedAt` /
`schemaVersion` provenance), so those blocks — and the retired-Bonsai ids nested
inside them — were shipping to the client bundle with zero readers. The second,
fully-unimported copy at `src/lib/data/v1-launch-manual-evidence.json` was
deleted; there is now a SINGLE evidence file at `src/local-ai/evidence/data/`, so
future refreshes touch one place rather than "both copies." No
`routingEvidenceReconciliation` row was changed. NOTE: the per-row provenance
table in this file predates several ships and labels some rows `benchmark` that
are `calculated` in the shipped JSON; treat it as a historical record. Freshness
is now enforced by the production read path (`loadSeedEvidence` per-row TTL) and
its test, not by this table.

## Runtime Seed Benchmark Records (real hardware measurements)

Refresh correction (2026-06-19 Gemma catalogue closeout): the checked runtime
JSON snapshot was rebuilt from durable exported Eval Harness artifacts. New
records carry their own `generatedAt`; preserved legacy rows keep their own
`generatedAt` or `routingEvidence.observedAt` freshness and are not renewed by
the snapshot-level timestamp. The active `routingEvidenceReconciliation` payload
includes the refreshed Qwen3.5-2B and LFM2.5-1.2B shipping-model records from
the 2026-06-19 Gemma catalogue-closeout seed-refresh export; eval-only Gemma
LiteRT candidates remain excluded from shipping seed/admission.

| modelId | browserClass | deviceClass | observedAt | generatedAt | Rationale |
|---------|-------------|-------------|------------|-------------|-----------|
| `candidate/lfm2.5-1.2b-instruct-onnx` | chromium | high-memory-laptop | 2026-06-16T23:44:19.646Z | 2026-06-17T00:05:58.447Z | Fresh high-memory WebGPU benchmark: 358ms first-token, 46.0 tok/s, reliability 1.0. |
| `candidate/lfm2.5-350m-onnx` | chromium | capable-laptop | 2026-05-14T10:05:00.000Z | historical | Backfilled lab benchmark: 950ms first-token, 22 tok/s, reliability 0.95. |
| `candidate/lfm2.5-350m-onnx` | chromium | high-memory-laptop | 2026-06-16T23:44:19.646Z | 2026-06-17T00:05:58.447Z | Fresh high-memory WebGPU benchmark: 102.5ms first-token, 74.8 tok/s, reliability 1.0. |
| `candidate/lfm2.5-350m-onnx` | chromium | low-memory-laptop | 2026-06-16T23:53:45.269Z | 2026-06-17T00:05:58.447Z | Fresh low-memory WebGPU benchmark: 140ms first-token, 57.0 tok/s, reliability 1.0. |
| `candidate/qwen3.5-2b-onnx` | chromium | high-memory-laptop | 2026-06-16T23:44:19.646Z | 2026-06-17T00:05:58.447Z | Fresh high-memory WebGPU benchmark: 639ms first-token, 22.4 tok/s, reliability 1.0. |
| `local/bonsai-1.7b-q4` | chromium | high-memory-laptop | 2026-06-16T23:51:34.388Z | 2026-06-17T00:05:58.447Z | Fresh high-memory WebGPU benchmark: 446ms first-token, 21.5 tok/s, reliability 1.0. |
| `local/phi3-mini-4k-q4f16` | chromium | high-memory-laptop | 2026-06-16T23:51:34.388Z | 2026-06-17T00:05:58.447Z | Fresh high-memory WebGPU benchmark: 269ms first-token, 17.7 tok/s, reliability 1.0. |
| `local/qwen3-0.6b` | chromium | capable-laptop | 2026-05-13T19:38:47.000Z | historical | Backfilled lab benchmark: 8200ms first-token, 11.5 tok/s, reliability 1.0. |
| `local/qwen3-0.6b` | chromium | high-memory-laptop | 2026-06-16T23:44:19.646Z | 2026-06-17T00:05:58.447Z | Fresh high-memory WebGPU benchmark: 231.5ms first-token, 38.9 tok/s, reliability 1.0. |
| `local/qwen3-0.6b` | chromium | low-memory-laptop | 2026-06-16T23:53:45.269Z | 2026-06-17T00:05:58.447Z | Fresh low-memory WebGPU benchmark: 274ms first-token, 26.3 tok/s, reliability 1.0. |
| `local/qwen3-0.6b` | chromium | wasm-fallback-laptop | 2026-06-17T00:02:20.971Z | 2026-06-17T00:05:58.447Z | Fresh WASM fallback benchmark: 6662.5ms first-token, 0.75 tok/s, reliability 1.0. |

## Archival Rich Evidence (not runtime seed reconciliation)

These records remain in the rich historical evidence blob, but are not exposed
through `routingEvidenceReconciliation` and therefore do not currently seed the
runtime recommender.

| modelId | browserClass | deviceClass | Rationale |
|---------|-------------|-------------|-----------|
| `local/smollm2-1.7b-webllm-q4f16` | chromium | high-memory-laptop | Original v1 benchmark: 711ms first-token, 31.3 tok/s, reliability 0.83 (WebLLM MLC runtime). Fresh rerun `eval-mqhldbxl-38eqjp3s` on 2026-06-17 failed 4/4 prompts at load with `Quota exceeded.`, so no fresh runtime seed record was admitted. |

## Calculated Records (predicted confidence)

Records where we predicted viability based on model size, runtime
knowledge, and browser capabilities. No physical test on the exact
(browser x device) combo; conservative metrics assigned.

### LFM2.5 350M ONNX (`candidate/lfm2.5-350m-onnx`)

247 MB model -- small enough to predict viability across a wide range
of profiles.

| browserClass | deviceClass | Rationale |
|-------------|-------------|-----------|
| chromium | wasm-fallback-laptop | WASM fallback path is well-supported by transformers.js + onnxruntime-web for sub-1B models. |
| safari | capable-laptop | Safari 26+ supports WebGPU; ONNX-Q4F16 transformers.js path is browser-portable. |
| safari | high-memory-laptop | Same rationale as capable-laptop with more headroom. |
| safari | wasm-fallback-laptop | WASM fallback for sub-1B ONNX model on Safari. |
| firefox | capable-laptop | Firefox WebGPU support landed in 2025; transformers.js ONNX path is browser-portable. |
| firefox | high-memory-laptop | Same rationale as capable-laptop with more headroom. |
| firefox | wasm-fallback-laptop | WASM fallback for sub-1B ONNX model on Firefox. |
| mobile | capable-laptop | Only LFM2.5 (247 MB) is small enough to safely predict viability without per-device measurement. |
| mobile | wasm-fallback-laptop | Mobile WASM fallback: older or smaller-memory phone. LFM2.5 still light enough. |

### Qwen3 0.6B (`local/qwen3-0.6b`)

575 MB model -- fits most desktop profiles but too large for confident
mobile prediction.

| browserClass | deviceClass | Rationale |
|-------------|-------------|-----------|
| safari | capable-laptop | Safari 26+ supports WebGPU. ONNX-Q4F16 transformers.js path is browser-portable. |
| safari | high-memory-laptop | Same rationale as capable-laptop with more headroom. |
| safari | wasm-fallback-laptop | WASM fallback for sub-1B ONNX model on Safari. |
| firefox | capable-laptop | Firefox WebGPU support landed in 2025; treat as calculated confidence until we benchmark. |
| firefox | high-memory-laptop | Same rationale as capable-laptop with more headroom. |
| firefox | wasm-fallback-laptop | WASM fallback for sub-1B ONNX model on Firefox. |
