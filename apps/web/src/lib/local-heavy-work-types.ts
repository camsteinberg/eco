// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Leaf type module for the local heavy-work owner domain.
 *
 * `LocalHeavyWorkKind` lives here — with no imports of its own — so that
 * `validation-harness.ts` can reference the type without importing
 * `local-heavy-work-owner.ts`, which imports the harness at runtime. Keeping the
 * type in a dependency-free leaf breaks that type-only import cycle
 * (enforced by `scripts/check-circular-deps.mjs`, which counts type-only edges).
 *
 * `local-heavy-work-owner.ts` re-exports this so existing
 * `from './local-heavy-work-owner'` imports keep resolving unchanged.
 */

/** The kinds of heavy on-device work that contend for the model runtime. */
export type LocalHeavyWorkKind =
  | "benchmark"
  | "download"
  | "readiness"
  | "generation"
  | "warmup"
  | "switch-model"
  | "unload";
