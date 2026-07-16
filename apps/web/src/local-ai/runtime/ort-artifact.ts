// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * ONNX Runtime WASM artifact selection — pure mapping, no side effects.
 *
 * Transformers.js resolves `onnxruntime-web/webgpu` → `ort.webgpu.bundle.min.mjs`,
 * whose WASM binary is `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` (the
 * asyncify build carries BOTH the WASM execution provider AND the WebGPU/JSEP
 * kernels on Eco's path — that is why only asyncify is served by default).
 *
 * The real-device spike showed WebKit builds a 2–4.5 GB working set for a 0.6 B
 * model (~5× weights) and kills the tab under sustained chat, while Firefox is
 * calm on the identical artifact. The asyncify build's instrumentation ~doubles
 * the WASM binary, so the artifact itself is a memory-cost hypothesis worth
 * measuring against the leaner `standard` and `jspi` (JS Promise Integration)
 * variants — but ONLY on the WASM EP: forcing a non-asyncify artifact on the
 * WebGPU backend removes the JSEP kernels, so the matrix must not cross
 * {standard,jspi} × WebGPU.
 *
 * This module maps an artifact choice to the same-origin `/ort/` URLs
 * (`env.backends.onnx.wasm.wasmPaths`, object form) and clamps a requested
 * thread count. It is imported by BOTH the inference worker (to apply the
 * override) and the adapter/tests (to reason about it), so it stays free of
 * DOM/worker globals.
 */

/**
 * WASM artifact variants served under `/ort/`. `asyncify` is today's default
 * (also the WebGPU/JSEP carrier); `standard` has no async-stack support;
 * `jspi` uses JS Promise Integration instead of asyncify instrumentation.
 */
export type OrtArtifact = 'standard' | 'asyncify' | 'jspi';

export const ORT_ARTIFACTS: readonly OrtArtifact[] = ['standard', 'asyncify', 'jspi'];

/**
 * Filename suffix per artifact, applied to the `ort-wasm-simd-threaded` stem.
 * `standard` has no suffix; the others match onnxruntime-web's dist naming.
 */
const ORT_ARTIFACT_SUFFIX: Record<OrtArtifact, string> = {
  standard: '',
  asyncify: '.asyncify',
  jspi: '.jspi',
};

/** Same-origin directory the build serves ORT WASM statics from. */
export const ORT_ASSET_BASE_PATH = '/ort/';

/** The two served filenames for an artifact variant (no path prefix). */
export function ortArtifactFileNames(artifact: OrtArtifact): { wasm: string; mjs: string } {
  const stem = `ort-wasm-simd-threaded${ORT_ARTIFACT_SUFFIX[artifact]}`;
  return { wasm: `${stem}.wasm`, mjs: `${stem}.mjs` };
}

/** Type guard: is `value` one of the known artifact variants? */
export function isOrtArtifact(value: unknown): value is OrtArtifact {
  return typeof value === 'string' && (ORT_ARTIFACTS as readonly string[]).includes(value);
}

/**
 * Build the `env.backends.onnx.wasm.wasmPaths` object that forces a specific
 * variant. TJS reads the `{ wasm, mjs }` object shape directly (a bare string
 * prefix cannot force a variant — it would append the bundle's default
 * filename). `basePath` defaults to the same-origin `/ort/` statics.
 */
export function ortWasmPaths(
  artifact: OrtArtifact,
  basePath: string = ORT_ASSET_BASE_PATH,
): { wasm: string; mjs: string } {
  const names = ortArtifactFileNames(artifact);
  return { wasm: `${basePath}${names.wasm}`, mjs: `${basePath}${names.mjs}` };
}

/**
 * Clamp a requested thread count to `[1, max]`. onnxruntime-web itself falls
 * back to 1 without cross-origin isolation, but clamping to
 * `hardwareConcurrency` here keeps the measured value honest and avoids asking
 * for more workers than the device can schedule. Non-finite or sub-1 requests
 * collapse to 1.
 */
export function clampThreads(requested: number, max: number): number {
  if (!Number.isFinite(requested)) return 1;
  const ceil = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  return Math.max(1, Math.min(Math.floor(requested), ceil));
}
