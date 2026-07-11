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
   * catalog build (`onnx-q4f16` / `onnx-q2f16` / `mlc-q4f16`) needs it to run
   * on the WebGPU EP — an adapter without it loads the model then dies on the
   * first f16 op. Only the setup path (`resolveSetupProfile`) probes and sets
   * this; `undefined` means "not probed → assume capable" so the synchronous
   * `getDeviceProfile()` and every existing caller behave exactly as before.
   */
  webgpuShaderF16?: boolean;
};

// ─── Intent ────────────────────────────────────────────────────────────────

export type Intent = 'snappy' | 'balanced' | 'quality';

// ─── Catalog model ─────────────────────────────────────────────────────────

export type ModelRuntime = 'transformers' | 'litert';

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

export type ModelConfig = {
  id: string;
  friendlyName: string;
  vendor: string;
  sizeGB: number;
  runtime: ModelRuntime;
  format: 'onnx-q4' | 'onnx-q4f16' | 'onnx-q2f16' | 'mlc-q4f16' | 'litertlm';
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
};

// ─── Below-floor ───────────────────────────────────────────────────────────

export type BelowFloorReason = {
  browser: string;
  version: string;
  constraint: string;
};
