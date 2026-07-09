// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Dev gate for the failure-capture affordance (chat #7 W2.1).
 *
 * The "Flag for eval" control on assistant messages is a dogfooding tool, not
 * a product feature — it must never appear for regular users. It enables via
 * URL param and stays sticky so a prod dogfooding session survives navigation:
 *
 *   /chat?eco-capture=1   → on now AND persisted (sticky across visits)
 *   /chat?eco-capture=0   → off now AND the sticky flag is cleared
 *   (no param)            → whatever the sticky flag says (default off)
 *
 * Mirrors the `?eco-diagnostics=1` gating posture of the diagnostics page.
 * The `search` parameter is injectable for tests; SSR-safe throughout.
 */

import { safeStorage } from './local-storage';

export const CAPTURE_FLAG_KEY = 'eco-dev-capture';

function readSearch(search?: string): string | null {
  if (search !== undefined) return search;
  if (typeof window === 'undefined') return null;
  return window.location.search;
}

/** Whether the flag-for-eval affordance should render. URL param wins over the sticky flag. */
export function isCaptureEnabled(search?: string): boolean {
  const query = readSearch(search);
  if (query === null) return false;
  const param = new URLSearchParams(query).get('eco-capture');
  if (param === '0') return false;
  if (param === '1') return true;
  return safeStorage.get(CAPTURE_FLAG_KEY) === '1';
}

/** Persist ?eco-capture=1/0 into the sticky flag. Called once on /chat mount. */
export function syncCaptureFlagFromUrl(search?: string): void {
  const query = readSearch(search);
  if (query === null) return;
  const param = new URLSearchParams(query).get('eco-capture');
  if (param === '1') safeStorage.set(CAPTURE_FLAG_KEY, '1');
  else if (param === '0') safeStorage.remove(CAPTURE_FLAG_KEY);
}
