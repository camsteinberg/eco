// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Onboarding persistence helpers.
 *
 * All onboarding state is stored in localStorage using `eco-` namespaced keys.
 * Tour: single flag set on skip or complete. Discovery: per-feature flags.
 * Every read function is SSR-safe (returns a sensible default when `window`
 * is undefined).
 */

import { safeStorage } from "./local-storage";

export const ONBOARDING_KEYS = {
  TOUR_COMPLETED: "eco-tour-completed",
  DISCOVERY_MODEL_SELECTOR: "eco-discovery-model-selector",
  DISCOVERY_KEYBOARD_SHORTCUTS: "eco-discovery-keyboard-shortcuts",
} as const;

/**
 * Returns `true` when the guided tour has already been completed (or skipped).
 * During SSR (`typeof window === "undefined"`) returns `true` so that
 * server-rendered markup never shows tour UI.
 */
export function isTourCompleted(): boolean {
  if (typeof window === "undefined") return true;
  return safeStorage.get(ONBOARDING_KEYS.TOUR_COMPLETED) === "true";
}

/**
 * Marks the guided tour as completed. Called on tour finish or skip.
 */
export function markTourCompleted(): void {
  safeStorage.set(ONBOARDING_KEYS.TOUR_COMPLETED, "true");
}

/**
 * Checks whether a specific feature discovery hint has been dismissed.
 * @param featureId - The feature identifier, e.g. `"model-selector"`.
 */
export function isFeatureDiscovered(featureId: string): boolean {
  if (typeof window === "undefined") return true;
  return safeStorage.get(`eco-discovery-${featureId}`) === "true";
}

/**
 * Marks a feature's discovery hint as dismissed.
 * @param featureId - The feature identifier, e.g. `"model-selector"`.
 */
export function markFeatureDiscovered(featureId: string): void {
  safeStorage.set(`eco-discovery-${featureId}`, "true");
}
