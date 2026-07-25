// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Dev gate for the diagnostics surface, sticky across in-app navigation.
 *
 * Generation receipts are held in memory only (generation-receipt.ts — never
 * persisted, by design), so the only export path that can include them is a
 * client-side navigation from the chat session to the diagnostics page. The
 * settings → "Diagnostic info" link is that path, but it was gated on
 * `?eco-diagnostics=1` being present in the *current* URL — a param that
 * in-app navigation drops, which on mobile left no receipt-preserving route
 * to the DOWNLOAD button at all. The sticky flag closes that gap:
 *
 *   /chat?eco-diagnostics=1   → on now AND persisted (sticky across visits)
 *   /chat?eco-diagnostics=0   → off now AND the sticky flag is cleared
 *   (no param)                → whatever the sticky flag says (default off)
 *
 * Mirrors dev-capture.ts exactly. The `search` parameter is injectable for
 * tests; SSR-safe throughout.
 */

import { safeStorage } from './local-storage';

export const DIAGNOSTICS_FLAG_KEY = 'eco-dev-diagnostics';

function readSearch(search?: string): string | null {
  if (search !== undefined) return search;
  if (typeof window === 'undefined') return null;
  return window.location.search;
}

/** Whether diagnostics affordances should render. URL param wins over the sticky flag. */
export function isDiagnosticsEnabled(search?: string): boolean {
  const query = readSearch(search);
  if (query === null) return false;
  const param = new URLSearchParams(query).get('eco-diagnostics');
  if (param === '0') return false;
  if (param === '1') return true;
  return safeStorage.get(DIAGNOSTICS_FLAG_KEY) === '1';
}

/** Persist ?eco-diagnostics=1/0 into the sticky flag. Called once on /chat mount. */
export function syncDiagnosticsFlagFromUrl(search?: string): void {
  const query = readSearch(search);
  if (query === null) return;
  const param = new URLSearchParams(query).get('eco-diagnostics');
  if (param === '1') safeStorage.set(DIAGNOSTICS_FLAG_KEY, '1');
  else if (param === '0') safeStorage.remove(DIAGNOSTICS_FLAG_KEY);
}
