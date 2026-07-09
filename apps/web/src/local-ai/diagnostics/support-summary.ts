// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Compact, privacy-safe support summary for a user-initiated email handoff.
 * Contains device class + recent smoke outcomes + error messages ONLY — never
 * conversation or file content (the source LocalAiDiagnostic carries none).
 * Bounded in length so it fits a mailto body; the full report is the separate
 * "Copy as JSON" action.
 */

import type { LocalAiDiagnostic } from './capture';

const MAX_ENTRIES = 5;

export function buildSupportSummary(entries: LocalAiDiagnostic[]): string {
  if (entries.length === 0) return 'No diagnostics were recorded on this device.';
  const recent = entries.slice(-MAX_ENTRIES).reverse();
  const env = recent[0]!.env;
  const lines = recent.map((e) => {
    const err = e.error?.message ? ` — ${e.error.message}` : '';
    const ep = e.resolvedBackend ? ` ep=${e.resolvedBackend}` : '';
    return `• ${e.modelId} [${e.profileKey}]${ep} ${e.outcome} (load=${e.durations.loadMs ?? '—'}ms total=${Math.round(e.durations.totalMs)}ms)${err}`;
  });
  return [
    `Device: mem=${env.deviceMemoryGB ?? '—'}GB cores=${env.hardwareConcurrency ?? '—'} ${env.platform ?? ''} ${env.architecture ?? ''}`.trim(),
    `Recent on-device AI setup outcomes (newest first):`,
    ...lines,
    ``,
    `(Paste the full report below — use "Copy as JSON" on the diagnostics page.)`,
  ].join('\n');
}
