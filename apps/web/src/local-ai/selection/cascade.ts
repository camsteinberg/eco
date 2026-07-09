// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Cascade — smoke-fail fallback within local-only.
 *
 * When a model passes admission + scoring but the actual smoke test
 * fails on this specific device (network drop, OPFS quota, runtime
 * crash), the lifecycle calls `nextInCascade(failed, slot, profile,
 * intent)` to find the next-best model to try instead.
 *
 * v1.0 lock: NO Eco Network bridge. The cascade only walks the local
 * catalog. If every local candidate has been exhausted, the function
 * returns null — the lifecycle then surfaces SetupErrorState, which is
 * recoverable but not silent.
 *
 * The cascade is the global fallback in v1.0, not per-call-site. Every
 * smoke failure routes through here; there is no second cascade
 * implementation scattered through the UI.
 */

import type { DeviceProfile, Intent, ModelConfig, Slot } from '../types';
import { listCandidates } from './recommend';
import { logger } from '../../lib/logger';

export type CascadeOptions = {
  /**
   * Additional models to skip beyond `failed`. Useful when the lifecycle has
   * tried several models in succession and wants to avoid retrying them.
   */
  excludeIds?: ReadonlyArray<string>;
};

/**
 * Telemetry: track which failed.ids have passed through `nextInCascade` in
 * this session. If the same id appears twice, the upstream lifecycle most
 * likely has a contract bug — it's supposed to add the previously-failed
 * model to `options.excludeIds` across retries. This is purely advisory:
 * the cascade body already guards correctness by including `failed.id`
 * in the per-call exclusion set.
 */
const seenFailedIds = new Set<string>();

export function nextInCascade(
  failed: ModelConfig,
  slot: Slot,
  profile: DeviceProfile,
  intent?: Intent,
  options: CascadeOptions = {},
): ModelConfig | null {
  if (seenFailedIds.has(failed.id) && typeof console !== 'undefined') {
    // Debug level — silent under normal test/CI configurations, surfaces only
    // when devtools verbose logging is enabled.
    logger.debug(
      `[local-ai] cascade: nextInCascade called twice for failed.id=${failed.id}. `
      + 'Upstream should add the failed model to options.excludeIds across retries.',
    );
  }
  seenFailedIds.add(failed.id);

  const excluded = new Set<string>([failed.id, ...(options.excludeIds ?? [])]);
  const ranked = listCandidates(slot, profile, intent);
  for (const candidate of ranked) {
    if (excluded.has(candidate.model.id)) continue;
    return candidate.model;
  }
  return null;
}

/** Test-only: reset the seen-id telemetry. Production never calls this. */
export function _resetCascadeTelemetryForTesting(): void {
  seenFailedIds.clear();
}

/**
 * Convenience: full ordered cascade path for a slot/profile, including
 * the recommended model first. Tests use this; the lifecycle prefers
 * `nextInCascade` because it can pass excludeIds across retries.
 */
export function cascadePath(
  slot: Slot,
  profile: DeviceProfile,
  intent?: Intent,
): ModelConfig[] {
  return listCandidates(slot, profile, intent).map((candidate) => candidate.model);
}
