// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Local model recovery — v1 implementation.
 *
 * Mirrors the legacy `lib/local-recovery.ts` API so callsites in useChat.ts
 * and chat/page.tsx are a drop-in swap.  The key difference: readiness is
 * determined by the v1 slot store (`slots.ts`) rather than the legacy
 * localInferenceStore + state-matrix + benchmark-evidence pipeline.
 *
 * A slot whose status is `'ready'` and whose model resolves from the catalog
 * is considered recovery-eligible.  The scan order is `eco-fast` then
 * `eco-smart` — matching the implicit priority in the slot list.
 */

import { getSlot, SLOTS } from './slots';

// ─── Public types ─────────────────────────────────────────────────────────

export type ResolveReadyLocalRecoveryModelIdOptions = {
  currentModelId?: string | null;
  preferredModelId?: string | null;
  /**
   * Legacy compat — the v1 implementation ignores this parameter because
   * readiness is fully determined by slot status.  Kept in the signature so
   * callsites that forward `checkStatus` continue to type-check.
   */
  checkStatus?: (modelId: string) => Promise<unknown>;
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

  // 1. Prefer currentModelId if it's a ready slot model.
  if (currentModelId) {
    if (isReadySlotModel(currentModelId)) return currentModelId;
    return null;
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

/**
 * Return the list of model ids that are currently ready across all slots.
 */
export function getLocalRecoveryCandidateIds(): readonly string[] {
  const ids: string[] = [];
  for (const slotId of SLOTS) {
    const state = getSlot(slotId);
    if (state.status === 'ready' && state.model) {
      ids.push(state.model.id);
    }
  }
  return ids;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isReadySlotModel(modelId: string): boolean {
  for (const slotId of SLOTS) {
    const state = getSlot(slotId);
    if (state.model?.id === modelId && state.status === 'ready') return true;
  }
  return false;
}
