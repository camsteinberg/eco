// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Leaf type module for the inference-capability domain.
 *
 * `InferenceCapability` lives here — with no imports of its own — so that
 * `validation-harness.ts` can reference the type without importing
 * `inference-capability.ts`, which imports the harness at runtime. Keeping the
 * type in a dependency-free leaf breaks that type-only import cycle
 * (enforced by `scripts/check-circular-deps.mjs`, which counts type-only edges).
 *
 * `inference-capability.ts` re-exports this so existing
 * `from './inference-capability'` imports keep resolving unchanged.
 */

/** The browser's best available on-device inference backend. */
export type InferenceCapability = 'webgpu' | 'wasm' | 'unsupported';
