// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Admission — unified gate for (model × profile).
 *
 * v1.0 has no default-vs-manual routing distinction — local AI is the only
 * path — so admission collapses to one decision tree.
 *
 * NOTE: the admission gate has no experimental branch. It used to claim the
 * catalog filtered `evidenceTier: 'experimental'` out of `getCatalog()` —
 * verified FALSE on 2026-08-31: catalog/catalog.ts applies no tier filter and
 * returns every entry in catalog-data.json. Nothing gates on the experimental
 * tier today; it is descriptive metadata the UI surfaces, not a filter.
 *
 * Decision order (the only thing downstream consumers care about):
 *
 *   1. Compatibility (`device/compatibility.isCompatible`)
 *      - `unsupported` → denied/incompatible-device
 *      - `with-warning` propagates as 'with-warning'/mobile-warning unless
 *        another rule overrides it
 *
 *   2. Seed evidence on THIS profile (`evidence/seed.ts`)
 *      - present and fresh → allowed (preserve mobile warning if any)
 *
 *   3. Runtime ledger success on THIS profile (`evidence/ledger.ts`)
 *      - smoke-pass or generate-pass recently → allowed
 *
 *   4. Predicted-fit lane
 *      - `evidenceTier === 'predicted'` (no fresh profile-scoped proof here) → with-warning
 *      - `evidenceTier === 'proven'` (no fresh profile-scoped proof here) → with-warning
 *
 * Recent failures don't auto-deny on a profile where compat+evidence still
 * allow — the lifecycle cascade handles smoke-fail retry. Admission is a
 * structural gate, not a flaky-network detector.
 */

import type { DeviceProfile, ModelConfig } from '../types';
import { isCompatible } from '../device/compatibility';
import { loadSeedEvidenceForModel, type SeedEvidenceSource } from './seed';
import { countRecentDownloadFailures, countRecentFailures, hasRecentSuccess } from './ledger';

export type AdmissionDecision = 'allowed' | 'denied' | 'with-warning';

export type AdmissionReason =
  | 'incompatible-device'
  | 'mobile-warning'
  | 'proven-on-this-profile'
  | 'ledger-success'
  | 'predicted-fit'
  | 'proven-elsewhere'
  | 'snapshot-stale';

export type AdmissionResult = {
  decision: AdmissionDecision;
  reason: AdmissionReason;
  hasSeedProof: boolean;
  hasLedgerSuccess: boolean;
  /**
   * Source of the seed proof when one was found. null when no seed proof
   * exists. The recommendation engine uses this to distinguish a benchmark-
   * proven model from a calculated-confidence prediction in scoring and
   * for the confidence-floor filter.
   */
  seedProofSource: SeedEvidenceSource | null;
  /**
   * Count of recent smoke/generate failures for this (model × profile) in
   * the ledger. `selection/recommend.ts` (`applyConfidenceFloor`) hides a
   * model with any recent failure from the automatic surfaces; the manual
   * Settings list passes `hideOnRecentFailure: false` and shows it anyway.
   */
  recentFailureCount: number;
  /**
   * Count of recent (7-day) genuine download failures for this (model ×
   * profile). Used ONLY to demote a model from AUTO-offer (setup first-pick /
   * upgrade) after repeated environmental download failures — never to hide it
   * from manual selection. See `applyConfidenceFloor` in `selection/recommend`.
   */
  recentDownloadFailureCount: number;
};

export function admit(model: ModelConfig, profile: DeviceProfile): AdmissionResult {
  const compatibility = isCompatible(model, profile);
  const recentFailureCount = countRecentFailures(model.id, profile);
  const recentDownloadFailureCount = countRecentDownloadFailures(model.id, profile);

  if (compatibility === 'unsupported') {
    return {
      decision: 'denied',
      reason: 'incompatible-device',
      hasSeedProof: false,
      hasLedgerSuccess: false,
      seedProofSource: null,
      recentFailureCount,
      recentDownloadFailureCount,
    };
  }

  const seedProof = loadSeedEvidenceForModel(model.id, profile);
  const ledgerSuccess = hasRecentSuccess(model.id, profile);

  if (seedProof) {
    return {
      decision: compatibility === 'with-warning' ? 'with-warning' : 'allowed',
      reason: compatibility === 'with-warning' ? 'mobile-warning' : 'proven-on-this-profile',
      hasSeedProof: true,
      hasLedgerSuccess: ledgerSuccess,
      seedProofSource: seedProof.source,
      recentFailureCount,
      recentDownloadFailureCount,
    };
  }

  if (ledgerSuccess) {
    return {
      decision: compatibility === 'with-warning' ? 'with-warning' : 'allowed',
      reason: compatibility === 'with-warning' ? 'mobile-warning' : 'ledger-success',
      hasSeedProof: false,
      hasLedgerSuccess: true,
      seedProofSource: null,
      recentFailureCount,
      recentDownloadFailureCount,
    };
  }

  return {
    decision: 'with-warning',
    reason: model.evidenceTier === 'predicted' ? 'predicted-fit' : 'proven-elsewhere',
    hasSeedProof: false,
    hasLedgerSuccess: false,
    seedProofSource: null,
    recentFailureCount,
    recentDownloadFailureCount,
  };
}

export function isAdmitted(model: ModelConfig, profile: DeviceProfile): boolean {
  return admit(model, profile).decision !== 'denied';
}
