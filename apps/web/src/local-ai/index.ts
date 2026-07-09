// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Public API barrel for the local-ai module.
 *
 * Most consumers import from the sub-module paths directly. This barrel
 * forwards only the cross-cutting entry points that have a stable contract:
 * device profiling, the below-floor gate, and the recommendation surface.
 *
 * Status/progress/assignment/switch/clearCache/generate were never wired
 * through the barrel — every consumer reaches the owning sub-module
 * directly (download/, runtime/lifecycle, lifecycle/slots, …). The unused
 * `LocalAiNotImplementedError` placeholders were removed in C-05; resurrect
 * a forwarder here only if a real cross-module consumer appears.
 */

import type {
  Slot,
  DeviceProfile,
  Intent,
  ModelConfig,
  BelowFloorReason,
} from './types';
import {
  getDeviceProfile as getDeviceProfileImpl,
  describeDevice as describeDeviceImpl,
} from './device/profile';
import {
  isBelowFloor as isBelowFloorImpl,
  getBelowFloorReason as getBelowFloorReasonImpl,
} from './device/below-floor';
import {
  recommend as recommendImpl,
  listCatalog as listCatalogImpl,
  type ListCandidatesOptions,
} from './selection/recommend';

export type {
  Slot,
  DeviceProfile,
  Intent,
  ModelConfig,
  BelowFloorReason,
};

// ─── Recommendation ───────────────────────────────────────────────────────

export function recommend(
  slot: Slot,
  profile: DeviceProfile,
  intent?: Intent,
  options?: ListCandidatesOptions,
): ModelConfig {
  return recommendImpl(slot, profile, intent, options);
}

// ─── Catalog ──────────────────────────────────────────────────────────────

export function listCatalog(
  profile: DeviceProfile,
  options?: { currentlyBoundModelId?: string | null },
): ReturnType<typeof listCatalogImpl> {
  return listCatalogImpl(profile, options);
}

// ─── Device ───────────────────────────────────────────────────────────────

export function getDeviceProfile(): DeviceProfile {
  return getDeviceProfileImpl();
}

export function describeDevice(profile: DeviceProfile): string | undefined {
  return describeDeviceImpl(profile);
}

export function isBelowFloor(profile?: DeviceProfile): boolean {
  return isBelowFloorImpl(profile);
}

export function getBelowFloorReason(): BelowFloorReason {
  return getBelowFloorReasonImpl();
}
