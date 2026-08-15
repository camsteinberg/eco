// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * First-run model choice — the domain side of the welcome card.
 *
 * On a fresh device the setup runner offers the user a choice of model instead
 * of silently auto-recommending one. This module decides WHICH models to offer
 * for a given device, purely from the catalog + recommendation logic (no React,
 * no presentation). The component layer maps the returned `ModelConfig`s to card
 * copy.
 *
 * The offer is at most two models, best-first:
 *   - the everyday pick — `recommend(slot, profile)` (the fast tier), and
 *   - a deeper pick — `recommend('eco-smart', profile)`, when the device can run
 *     a genuinely different, larger model.
 *
 * A device that can only run one model (mobile / WASM-only / low-memory) gets a
 * single option — the card shows it as "your model", not a false choice. The
 * PRESELECTED / "Recommended" id is always the everyday fast pick: a fresh device
 * instant-starts on the small, quick download, and the deeper model stays a
 * visible opt-in tile the user can choose deliberately. Preselecting the deeper
 * model would defeat instant-start (FR-1).
 */

import type { DeviceProfile, ModelConfig, Slot } from '../types';
import { recommend } from './recommend';

export type FirstRunChoiceOffer = {
  /** Device-appropriate models to offer, best-first (1–2). */
  models: ModelConfig[];
  /** Which offered model carries the "Recommended" badge / preselection. */
  recommendedId: string;
};

/**
 * Derive the first-run model offer for a device. `slot` is the slot being set
 * up (eco-fast), whose recommendation is the everyday option; the deeper option
 * comes from the eco-smart recommendation when it resolves to a different model.
 *
 * Callers reach this only after the below-floor gate, so `recommend(slot, …)`
 * for the everyday pick is assumed to succeed; the deeper lookup is guarded
 * because eco-smart can have no assignable candidate on a marginal device.
 */
export function deriveFirstRunChoices(slot: Slot, profile: DeviceProfile): FirstRunChoiceOffer {
  const everyday = recommend(slot, profile);

  let deeper: ModelConfig | null = null;
  try {
    const smart = recommend('eco-smart', profile);
    if (smart.id !== everyday.id) deeper = smart;
  } catch {
    // No distinct deeper model this device can run — single-option offer.
  }

  // recommendedId is always the everyday pick — the deeper model is offered as a
  // visible tile but never auto-preselected, so instant-start is preserved (FR-1).
  return deeper
    ? { models: [everyday, deeper], recommendedId: everyday.id }
    : { models: [everyday], recommendedId: everyday.id };
}
