// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Shared types for the local-ai module.
 *
 * Types only — implementations live in subdirectory files.
 */

import type { SystemRoleSupport } from './runtime/chat-template-adapter';

// ─── Slots ────────────────────────────────────────────────────────────────

export type Slot = 'eco-fast' | 'eco-smart';

// ─── Device profile ────────────────────────────────────────────────────────

export type BrowserClass = 'chromium' | 'safari' | 'firefox' | 'mobile' | 'unknown';

export type WebGPUSupport = 'webgpu' | 'wasm-only' | 'none';

export type DeviceProfile = {
  browserClass: BrowserClass;
  webgpuSupport: WebGPUSupport;
  deviceMemoryGB: number;
  isMobile: boolean;
  override: 'user' | 'auto';
  /**
   * Whether the WebGPU adapter exposes the `shader-f16` feature. Every f16
   * catalog build (`onnx-q4f16` / `onnx-q2f16`) needs it to run
   * on the WebGPU EP — an adapter without it loads the model then dies on the
   * first f16 op. Only the setup path (`resolveSetupProfile`) probes and sets
   * this; `undefined` means "not probed → assume capable" so the synchronous
   * `getDeviceProfile()` and every existing caller behave exactly as before.
   */
  webgpuShaderF16?: boolean;
  /**
   * The WebGPU adapter's `maxBufferSize` limit in bytes — the ceiling on any
   * single GPU buffer allocation, and the real hard cap on what a model can
   * physically allocate on the GPU. Only the setup path (`resolveSetupProfile`)
   * probes and sets this; `undefined` means "not probed", so the synchronous
   * `getDeviceProfile()` and every existing caller behave exactly as before. On
   * WebKit this is the ONLY hard GPU-memory number the platform exposes
   * (`deviceMemoryGB` is always 0 there). Consumed by the tightening-only
   * max-buffer compatibility gate (Wave 3 scaffolding); no catalog model
   * declares a floor yet, so today it changes no recommendation.
   */
  webgpuMaxBufferBytes?: number;
};

// ─── Intent ────────────────────────────────────────────────────────────────

export type Intent = 'snappy' | 'balanced' | 'quality';

// ─── Catalog model ─────────────────────────────────────────────────────────

export type ModelRuntime = 'transformers' | 'litert' | 'webllm';

/**
 * Concrete download artifact for a catalog model: HuggingFace id, pinned
 * revision, and the exact file list. The proxy allowlist enforces these
 * paths server-side, so the catalog's `artifact.files` MUST match the
 * server's `LOCAL_MODEL_CANDIDATE_POLICY[id].artifactReview.files` exactly.
 *
 * Optional on the type so non-catalog test fixtures don't need it; bootstrap
 * throws when a catalog model lacks an artifact (fail-fast on misconfig).
 */
export type ModelArtifact = {
  hfId: string;
  revision: string;
  files: readonly string[];
};

/**
 * The license the model WEIGHTS are published under.
 *
 * This is separate from Eco's own license: the app code is AGPL-3.0-or-later,
 * the weights are third-party works with their own terms. Eco redistributes
 * those weights (through the `/api/local-models` proxy and the R2 mirror), so
 * we are a redistributor and must pass the license text on with them — Apache
 * 2.0 §4(a) and the LFM Open License v1.0 §4(a) both require it.
 *
 * `upstreamRepo` is deliberately the ORIGINAL author's repo, not the repack we
 * happen to download from: attribution belongs to whoever trained the model.
 */
export type ModelLicense = {
  /** SPDX id, or null when the license is not an SPDX-listed open-source one. */
  spdx: string | null;
  /** Human-readable license name, as the publisher writes it. */
  name: string;
  /** Canonical URL for the full license text. */
  url: string;
  /** The original model author's Hugging Face repo (`org/name`). */
  upstreamRepo: string;
  /**
   * Whether we have verified the license against the publisher's own
   * statement. `false` means the publisher declares it but the declaration is
   * self-inconsistent or unverified — the UI says so rather than implying we
   * checked.
   */
  confirmed: boolean;
  /** Plain-language limitation on commercial use, when the license has one. */
  commercialUseNote?: string;
  /**
   * File name under `local-ai/catalog/licenses/` holding the verbatim license
   * text that ships with this build. The mirror script uploads it alongside
   * the weights so CDN recipients get a copy too.
   */
  textFile: string;
  /**
   * Path to a license file that already exists inside the download repo at the
   * pinned revision, or null when that repo ships none. When non-null the file
   * is part of `artifact.files`, so every download carries the license.
   */
  artifactLicenseFile: string | null;
};

/** The seven chat intents a turn can route to. Mirrors `lib/chat-intent.ts`. */
export type ModelIntent =
  | 'quick' | 'explain' | 'deep' | 'code' | 'writing' | 'file' | 'research';

/** The sampling knobs the runtimes can actually honor. */
export type ModelSampling = {
  temperature: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  /**
   * Prompt-inclusive n-gram ban. Transformers.js applies it across the FULL
   * sequence, prompt included, so it forbids handing the user their own words
   * back — no shipping catalog entry sets it. Kept on the type because the
   * eval-lane Bonsai profiles still do.
   */
  noRepeatNgramSize?: number;
};

/**
 * A model's complete sampling description: the base row plus its per-intent
 * overrides. Resolution is a single spread —
 * `{ ...base, ...intentOverrides[intent] }` — so the values written here are
 * the values the runtime receives.
 *
 * An override may restate a base value; that is deliberate, not redundancy.
 * The per-intent rows are recorded as authored so a future retune of the base
 * does not silently move an intent that was tuned to its own number.
 */
export type ModelGeneration = ModelSampling & {
  /**
   * Opt into deterministic CJK-token suppression on non-CJK conversations
   * (runtime/cjk-suppression.ts). Set ONLY on models with a measured CJK-leak
   * class — each one is a live surface needing a real-WebGPU verification run.
   */
  suppressCjkTokens?: boolean;
  intentOverrides: Partial<Record<ModelIntent, Partial<ModelSampling>>>;
};

/**
 * A model's length budget. The resolved cap for an intent is
 * `min(intentTokens[intent] ?? default, max, ceiling)`.
 *
 * `ceiling` is the model's own generation ceiling — the largest number of new
 * tokens it may be asked for under ANY intent. Context-window selection
 * reserves against it before the turn's intent is known.
 */
export type ModelMaxNewTokens = {
  ceiling: number;
  default: number;
  max: number;
  intentTokens: Partial<Record<ModelIntent, number>>;
};

export type ModelConfig = {
  id: string;
  friendlyName: string;
  vendor: string;
  sizeGB: number;
  runtime: ModelRuntime;
  format: 'onnx-q4' | 'onnx-q4f16' | 'onnx-q2f16' | 'onnx-int8' | 'litertlm' | 'mlc-q4f16';
  capabilities: {
    intent: Intent[];
    tasks: ('chat' | 'code' | 'writing' | 'reasoning')[];
    contextTokens: number;
  };
  bestFor: string;
  knownLimitation: string;
  evidenceTier: 'proven' | 'predicted' | 'experimental';
  /** Optional system-prompt suffix (e.g. thinking-control directive). */
  systemDirective?: string;
  /**
   * How this model's chat template handles `role: "system"` messages.
   * Defaults to `"native"` when absent (backward-compatible with existing
   * catalog entries before this field was added).
   */
  systemRoleSupport?: SystemRoleSupport;
  artifact?: ModelArtifact;
  /**
   * License of the model weights. Required for every shipping catalog entry
   * (catalog.test.ts pins that); optional on the type so non-catalog fixtures
   * and eval-lane candidates don't have to carry it.
   */
  license?: ModelLicense;
  /**
   * Sampling and length budget. Required for every shipping catalog entry
   * (`CatalogModel` makes them non-optional and catalog.ts validates them at
   * load); optional on the type so non-catalog fixtures and eval-lane
   * candidates, whose profiles still live in
   * `lib/local-model-generation-profiles.ts`, don't have to carry them.
   */
  generation?: ModelGeneration;
  maxNewTokens?: ModelMaxNewTokens;
};

// ─── Below-floor ───────────────────────────────────────────────────────────

export type BelowFloorReason = {
  browser: string;
  version: string;
  constraint: string;
};
