// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The opt-in failure summary attached to a feedback submission.
 *
 * The local evidence ledger (`local-ai/evidence/ledger.ts`) already records
 * every download / load / smoke / generation failure on this device, and never
 * leaves it. This renders the most recent few failure rows as plain text so a
 * person can choose to send them with their feedback. Shown VERBATIM in the
 * dialog before sending — this string is exactly what leaves the device.
 *
 * Only failure rows, only these fields: date, what failed, which model, the
 * classified error code and the backend it ran on. Never a prompt, never a
 * reply, never a timing that could fingerprint a machine.
 */

import { readAllEntries, type LedgerEntry } from "../local-ai/evidence/ledger";

export const MAX_FAILURE_ROWS = 5;

function isFailure(entry: LedgerEntry): boolean {
  return entry.outcome.endsWith("-fail");
}

function renderRow(entry: LedgerEntry): string {
  const day = entry.recordedAt.slice(0, 10);
  const parts = [day, entry.outcome, entry.modelId];
  if (entry.errorCode) parts.push(entry.errorCode);
  if (entry.backend) parts.push(entry.backend);
  return parts.join(" ");
}

/**
 * Newest failures first, one per line; null when the ledger holds none.
 * Identical failures (same outcome, model, code, backend) collapse into one
 * line carrying the latest date and a count — five retries of the same
 * download failure are one fact, not five.
 */
export function buildFeedbackFailureSummary(): string | null {
  const failures = readAllEntries().filter(isFailure).reverse();
  if (failures.length === 0) return null;
  const counts = new Map<string, number>();
  for (const entry of failures) {
    const line = renderRow(entry);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts.entries()]
    .slice(0, MAX_FAILURE_ROWS)
    .map(([line, count]) => (count > 1 ? `${line} ×${count}` : line))
    .join("\n");
}
