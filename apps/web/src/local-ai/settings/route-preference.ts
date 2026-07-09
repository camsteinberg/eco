// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Route preference — localStorage-backed user preference for local model
 * selection heuristic. Pure storage helpers with no dependency on the
 * routing stack.
 */

import { safeStorage } from '../../lib/local-storage';

export type LocalModelRoutePreference =
  | 'balanced'
  | 'fastest'
  | 'quality'
  | 'battery'
  | 'storage-saver';

export const LOCAL_MODEL_ROUTE_PREFERENCE_CHANGE_EVENT =
  'eco-local-model-route-preference-changed';

const ROUTE_PREFERENCE_STORAGE_KEY = 'eco-local-model-route-preference';

function isLocalModelRoutePreference(
  value: string,
): value is LocalModelRoutePreference {
  return (
    value === 'balanced'
    || value === 'fastest'
    || value === 'quality'
    || value === 'battery'
    || value === 'storage-saver'
  );
}

export function readLocalModelRoutePreference(): LocalModelRoutePreference {
  if (typeof localStorage === 'undefined') return 'balanced';
  try {
    const stored = safeStorage.get(ROUTE_PREFERENCE_STORAGE_KEY);
    if (stored && isLocalModelRoutePreference(stored)) return stored;
    if (stored !== null) {
      safeStorage.remove(ROUTE_PREFERENCE_STORAGE_KEY);
    }
    return 'balanced';
  } catch {
    return 'balanced';
  }
}

export function writeLocalModelRoutePreference(
  preference: LocalModelRoutePreference,
): LocalModelRoutePreference {
  if (typeof localStorage !== 'undefined') {
    try {
      safeStorage.set(ROUTE_PREFERENCE_STORAGE_KEY, preference);
    } catch {
      // Preference changes must remain lightweight and must not block routing.
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(LOCAL_MODEL_ROUTE_PREFERENCE_CHANGE_EVENT, {
        detail: { preference },
      }),
    );
  }
  return preference;
}

export function resetLocalModelRoutePreference(): LocalModelRoutePreference {
  if (typeof localStorage !== 'undefined') {
    try {
      safeStorage.remove(ROUTE_PREFERENCE_STORAGE_KEY);
    } catch {
      // Reset should still return the safe default even if storage is unavailable.
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(LOCAL_MODEL_ROUTE_PREFERENCE_CHANGE_EVENT, {
        detail: {
          preference: 'balanced' satisfies LocalModelRoutePreference,
        },
      }),
    );
  }
  return 'balanced';
}
