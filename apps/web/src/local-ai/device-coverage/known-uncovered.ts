// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Baseline + ratchet allowlist of device cells that are currently NOT covered
 * by the graceful-everywhere guarantee. Every entry cites a finding id in the
 * eco-notes coverage-audit decision doc and exists ONLY to keep the guarantee
 * net honest while cycle-2 fixes are pending. The net fails if a NEW uncovered
 * cell appears (regression) OR if an entry no longer matches any uncovered cell
 * (stale — remove it). The list may only shrink.
 *
 * Starts EMPTY. Task 4 adds an entry per confirmed silent-broken hunt (or the
 * hunt is cleared and no entry is added).
 */

import type { MatrixCell } from './device-matrix';

export type UncoveredEntry = {
  match: (c: MatrixCell) => boolean;
  findingId: string;
  note: string;
};

export const KNOWN_UNCOVERED: readonly UncoveredEntry[] = [];
