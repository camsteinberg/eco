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

/**
 * A model's device rules — the hardware floor `device/compatibility.ts`
 * evaluates a `DeviceProfile` against. Every clause a compatibility verdict can
 * turn on lives here, so a model's device story reads in one place next to the
 * weights it describes.
 *
 * `_rationale` carries the measurement or decision the numbers came from. It is
 * data, not decoration: a floor with no recorded provenance is exactly what this
 * fold exists to make visible.
 */
export type ModelCompat = {
  /** Requires WebGPU (cannot run in WASM-only). */
  requireWebgpu: boolean;
  /**
   * Restricts the model to NO-WebGPU (`webgpuSupport === 'wasm-only'`) devices —
   * the inverse of `requireWebgpu`. Set for the CPU-EP floor models: they clear
   * the GatherBlockQuantized wall and run on the CPU EP, but decode far slower on
   * the WebGPU EP than a WebGPU-native build, so on any device WITH WebGPU (full
   * or f16-less) a WebGPU model is the better pick and these are not offered.
   * Absent means "no wasm-only restriction."
   */
  requireWasmOnly?: boolean;
  /** Minimum reported device memory in GB. 0 means "no floor". */
  minDeviceMemoryGB: number;
  /** Browser engines that have been measured or are confidently predicted. */
  allowedBrowsers: readonly BrowserClass[];
  /** If true, the verdict is `'with-warning'` on a mobile form factor. */
  warnIfMobile: boolean;
  /**
   * Restricts the model to iOS/WebKit-mobile devices: any other profile —
   * desktop (Chromium/Safari/Firefox), Android, or the UA-stripped `'mobile'`
   * class — is `'unsupported'`. Absent means "no form-factor restriction."
   */
  requireWebKitMobile?: boolean;
  /**
   * Proven to LOAD and run inside the WebKit-mobile memory envelope by a real
   * iOS device pass. Until an entry sets this, WebKit-mobile declines it to the
   * designed handoff surface BEFORE any download — every ONNX build still
   * crash-loops the tab there (onnxruntime-web fully materializes the weights
   * into the WASM heap, a multiple of the working set).
   */
  webkitMobileValidated?: boolean;
  /**
   * The build emits an op onnxruntime-web's WebGPU EP supports but its CPU/WASM
   * EP does NOT (the proven case: GatherBlockQuantized, from block-quantized
   * embeddings), so it can never load on a `wasm-only` device. Absent means
   * "runs on the CPU EP."
   */
  cpuEpIncompatible?: boolean;
  /**
   * Minimum WebGPU `maxBufferSize` (bytes) the adapter must report. Tightening-only
   * and dormant: it bites only when BOTH the profile carries a probed
   * `webgpuMaxBufferBytes` AND the entry declares a floor. No catalog entry
   * declares one today, so it changes no recommendation.
   */
  minMaxBufferBytes?: number;
  /**
   * The inverse of the shader-f16 gate: this build is a plain-int4 variant
   * published SPECIFICALLY for f16-less-but-WebGPU adapters, so it is declined on
   * an adapter that DOES expose shader-f16 — there its q4f16 sibling is the
   * better pick, and both would otherwise surface as duplicate rows.
   */
  requireNoShaderF16?: boolean;
  /** Provenance for the rules above — the measurement or decision behind them. */
  _rationale?: string;
};

/** Plain-language card copy for the first-run welcome surface. */
export type ModelWelcomePresentation = {
  /** Short product name for the card, no vendor suffix, e.g. "Eco Fast". */
  name: string;
  /** One plain sentence a casual user understands. */
  tagline: string;
  /** 1–4 filled dots: relative snappiness of replies. */
  speed: number;
  /** 1–4 filled dots: relative depth / thoroughness. */
  depth: number;
};

/**
 * A model's presentation copy — the benefit-oriented, brand-safe wording a
 * person actually reads (DESIGN-REFERENCE.md:84, "Never expose model names,
 * VRAM, or token counts in primary UI"). The raw catalog metadata still appears
 * behind "Show technical details".
 *
 * `friendlyName` is deliberately NOT unique: several entries are the SAME model
 * in different builds (the f16 and plain-int4 1.2B) and brand identically on
 * purpose, so `dedupeByDisplayName` collapses them into a single row.
 */
export type ModelDisplay = {
  /** Branded friendly name: "Eco Fast (Liquid)". */
  friendlyName: string;
  /** One-line quality phrase: "Quickest replies · small footprint". */
  qualityPhrase: string;
  /** Attribution for the provenance line: "Liquid AI". */
  provider: string;
  /** Curated welcome-card copy. Absent falls back to a size-scaled heuristic. */
  welcome?: ModelWelcomePresentation;
  /** Why this copy reads the way it does, where that is not self-evident. */
  _rationale?: string;
};

/**
 * Per-model runtime facts only one adapter cares about. Named behaviours only —
 * a quirk field exists because exactly one code path reads it, never as a place
 * to park a model id.
 */
export type ModelQuirks = {
  /**
   * Filename of the vendored WebLLM `model_lib` wasm for this model, resolved
   * under `WEBLLM_MODEL_LIB_BASE_PATH`. Each MLC model architecture needs its
   * own library, compiled per (model arch, quantization, prefill-chunk, web-llm
   * release). Required for every `runtime: 'webllm'` catalog entry.
   */
  webllmModelLibFile?: string;
};

/**
 * The device class a model is the *default* pick for. `preferredModelIdForSlot`
 * walks these best-first — `capable` -> `laptop` -> `phone` -> `floor` — and
 * takes the first rung this device can actually run, so a weaker device steps
 * down the ladder instead of falling back to whatever fit-scoring surfaced.
 *
 *   - `capable`  WebGPU with `shader-f16`: the everyday q4f16 picks.
 *   - `laptop`   WebGPU without `shader-f16`: the plain-int4 / LiteRT builds.
 *   - `phone`    no WebGPU at all (ort-web CPU EP): the `requireWasmOnly` picks.
 *   - `floor`    the universal small fallback, tried last on every device.
 *
 * FOUR rungs, not three device classes: the CPU-only picks and the universal
 * floor are BOTH reachable on a `wasm-only` device (the CPU picks win there), so
 * collapsing them into one rung would change which model such a device is
 * offered. The rung is per-slot — `eco-fast` and `eco-smart` climb separate
 * ladders — and a model that is nobody's default carries an empty assignment.
 */
export type ModelTier = 'capable' | 'laptop' | 'phone' | 'floor';

/** Which slot(s) a model is the tier default for. Empty = never a default. */
export type ModelTierAssignment = Readonly<Partial<Record<Slot, ModelTier>>>;

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
  /**
   * Device rules and presentation copy. Required for every shipping catalog
   * entry (`CatalogModel` makes them non-optional and catalog.ts validates them
   * at load); optional on the type so non-catalog fixtures and eval-lane
   * candidates — which are never offered to a device or rendered in primary UI —
   * don't have to carry them.
   */
  compat?: ModelCompat;
  display?: ModelDisplay;
  /** Adapter-specific facts, present only where an adapter reads one. */
  quirks?: ModelQuirks;
  /**
   * Whether this entry is offered to users. `true` = the shipping catalog
   * (`getCatalog()`); `false` = the dev-only eval lane, reachable through
   * `getEvalCandidateModels()` and the loopback-gated validation proxy alone.
   * Both live in catalog-data.json — this flag is the only thing separating
   * them, and `getCatalog()` filters on it. Required on every catalog-data.json
   * entry (`assertCatalogEntry` throws without it); optional on the type so
   * test fixtures built as bare `ModelConfig`s don't have to carry it.
   */
  shipping?: boolean;
  /**
   * The device tier(s) this model is the default pick for. Required on every
   * shipping catalog entry; the eval lane never carries one because it is never
   * recommended. See {@link ModelTierAssignment}.
   */
  tier?: ModelTierAssignment;
  /**
   * Exempt from the repeated-download-failure auto-demotion because this model
   * is the instant-start floor: demoting it would leave a device with nothing
   * offerable at all. Exactly one shipping entry sets it.
   */
  starterFloor?: boolean;
  /**
   * Why this entry's numbers are what they are, keyed by the field each note
   * justifies (`"tier.eco-fast"`, `"maxNewTokens.ceiling"`, …). A choice on the
   * serving path owes a measurement cited next to the code, so a note records
   * MEASURED/DERIVED/INHERITED provenance and a falsifier.
   *
   * `tier` assignments in particular: the by-eye reads and measured throughputs
   * behind each device-tier default used to live in comments on nine id
   * constants in `selection/recommend.ts`. They live here now, and
   * catalog.test.ts fails if an entry holds a tier rung without citing why.
   * Documentation, not serving data — nothing reads it at runtime, so a missing
   * note is a test failure rather than a load-time throw.
   */
  _provenance?: Readonly<Record<string, string>>;
  /**
   * Was once the everyday `eco-fast` default. Boot self-heal rebinds a slot
   * still pointing at one of these to the CURRENT device-appropriate default.
   * No entry sets it today — the flag is how a future default swap declares the
   * migration on the outgoing entry rather than in a hand-kept list.
   */
  formerEverydayDefault?: boolean;
};

// ─── Below-floor ───────────────────────────────────────────────────────────

export type BelowFloorReason = {
  browser: string;
  version: string;
  constraint: string;
};
