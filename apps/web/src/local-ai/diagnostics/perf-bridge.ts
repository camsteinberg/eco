// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Performance-gate read bridge — harness-only, read-only.
 *
 * The E2E performance gate (`e2e-perf/`) must measure the app's own
 * instrumentation, not the DOM: per-turn `firstTokenMs`/`durationMs`/token
 * counts already exist in the generation-receipt ring buffer, and "is the model
 * actually loaded" already exists as `runtime/lifecycle.getActiveModel()`. Both
 * live in module-scoped memory, which `page.evaluate` cannot reach.
 *
 * This module exposes those two EXISTING accessors — and nothing else — on
 * `window.__ecoPerf` so an out-of-page harness can read them. It is:
 *
 *   - read-only: no setter, no way to drive the app from the bridge;
 *   - gated on `isValidationHarnessEnabled()`, exactly like the rest of the
 *     validation-harness seams, so it never exists on a production host;
 *   - free of message content — receipts carry timings, phases and token
 *     counts only (see `generation-receipt.ts`).
 *
 * Installing it changes no app behavior. If you need a NEW measurement, prefer
 * recording it in the receipt (where the product can also use it) over widening
 * this surface.
 */

import { isValidationHarnessEnabled } from '../../lib/validation-harness';
import { getActiveModel } from '../runtime/lifecycle';
import {
  getRecentReceipts,
  pendingReceiptCount,
  type GenerationReceipt,
} from '../lifecycle/generation-receipt';

/** Bump when the shape changes so a stale gate fails loudly instead of silently. */
export const PERF_BRIDGE_VERSION = 2;

export type EcoPerfBridge = {
  readonly version: typeof PERF_BRIDGE_VERSION;
  /** Catalog id of the model currently resident in the runtime, or null. */
  activeModelId: () => string | null;
  /** Recent generation receipts, newest first — one per GENERATION, not per turn. */
  receipts: (limit?: number) => GenerationReceipt[];
  /**
   * Receipts hashed but not yet in the ring. A harness must wait for this to
   * reach 0 before reading `receipts()` for a turn that just finalized, or it
   * races the recording and measures the previous turn.
   */
  pendingReceipts: () => number;
};

declare global {
  var __ecoPerf: EcoPerfBridge | undefined;
}

/**
 * Install the bridge on `window` when the validation harness is enabled.
 * Idempotent. Returns whether the bridge is present after the call.
 */
export function installPerfBridge(): boolean {
  if (typeof window === 'undefined') return false;
  if (!isValidationHarnessEnabled()) return false;
  if (window.__ecoPerf) return true;

  window.__ecoPerf = {
    version: PERF_BRIDGE_VERSION,
    activeModelId: () => getActiveModel()?.id ?? null,
    receipts: (limit?: number) => getRecentReceipts(limit),
    pendingReceipts: () => pendingReceiptCount(),
  };
  return true;
}

/** @internal Remove the bridge. Exported for test isolation only. */
export function uninstallPerfBridge(): void {
  if (typeof window === 'undefined') return;
  delete window.__ecoPerf;
}
