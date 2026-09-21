// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Local model recovery — which on-device model an offline or recovery send
 * may fall back to.
 *
 * Readiness is determined entirely by the slot store (`slots.ts`): a slot
 * whose status is `'ready'` and whose model resolves from the catalog is
 * recovery-eligible. The scan order is `eco-fast` then `eco-smart` — matching
 * the implicit priority in the slot list.
 */

import { getSlot, SLOTS } from './slots';

// ─── Public types ─────────────────────────────────────────────────────────

export type ResolveReadyLocalRecoveryModelIdOptions = {
  currentModelId?: string | null;
  preferredModelId?: string | null;
};

// ─── Implementation ───────────────────────────────────────────────────────

/**
 * Return a ready local model id suitable for offline/recovery inference.
 *
 * Priority:
 *  1. `currentModelId` if it maps to a ready slot-bound model.
 *  2. `preferredModelId` if it maps to a ready slot-bound model.
 *  3. First ready slot in SLOTS order (eco-fast, eco-smart).
 *  4. `null` — nothing is available.
 */
export async function resolveReadyLocalRecoveryModelId(
  opts: ResolveReadyLocalRecoveryModelIdOptions,
): Promise<string | null> {
  const { currentModelId, preferredModelId } = opts;

  // 1. Prefer currentModelId if it's a ready slot model. When it is not
  // (still preparing, errored, or not a slot model at all) keep walking the
  // ladder: callers pass whichever slot has a model BOUND, and a bound-but-
  // preparing eco-fast must not hide a ready eco-smart.
  if (currentModelId && isReadySlotModel(currentModelId)) {
    return currentModelId;
  }

  // 2. Prefer preferredModelId if it's a ready slot model.
  if (preferredModelId && isReadySlotModel(preferredModelId)) {
    return preferredModelId;
  }

  // 3. Scan slots in order.
  for (const slotId of SLOTS) {
    const state = getSlot(slotId);
    if (state.status === 'ready' && state.model) {
      return state.model.id;
    }
  }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isReadySlotModel(modelId: string): boolean {
  for (const slotId of SLOTS) {
    const state = getSlot(slotId);
    if (state.model?.id === modelId && state.status === 'ready') return true;
  }
  return false;
}
