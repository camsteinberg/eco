# Seed Evidence Data Provenance

This file documents the provenance of each backfill record in
`v1-launch-manual-evidence.json`. Records are grouped by source type.

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
