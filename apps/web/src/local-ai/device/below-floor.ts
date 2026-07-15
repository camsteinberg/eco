// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Below-floor — the "Eco is coming to your device" check.
 *
 * Spec (`docs/design/2026-05-16/vision-and-architecture.md` §2.5):
 *   A device is below floor when ALL of the following are true:
 *     - No WebGPU support, AND
 *     - WASM SIMD / threading unavailable (i.e. the WASM tier is also missing), AND
 *     - (deviceMemoryGB ≤ 4 OR detected as mobile-low-memory)
 *
 * Implementation note: `profile.webgpuSupport === 'none'` is the single signal
 * for "neither WebGPU nor viable WASM available" — `device/profile.ts` only
 * returns `'wasm-only'` after probing for WASM SIMD, so `'none'` already
 * captures the WASM-runtime-unavailable case. Keeping the floor check
 * concentrated on a single property avoids redundant feature probes scattered
 * across modules (invariant 5).
 */

import type { BelowFloorReason, DeviceProfile } from '../types';
import { getDeviceProfile } from './profile';

const MOBILE_LOW_MEMORY_GB = 2;
const LOW_MEMORY_GB = 4;

/**
 * The memory half of the floor: too little RAM for a model to run well,
 * independent of runtime support. Split out so the decline surface can name
 * "not enough memory" as a distinct reason for a capable browser that still
 * can't be served — without duplicating the exact GB thresholds.
 */
export function failsMemoryFloor(profile: DeviceProfile = getDeviceProfile()): boolean {
  const reportedMemory = profile.deviceMemoryGB;
  const lowMemory = reportedMemory > 0 && reportedMemory <= LOW_MEMORY_GB;
  const mobileLowMemory =
    profile.isMobile && reportedMemory > 0 && reportedMemory <= MOBILE_LOW_MEMORY_GB;

  return lowMemory || mobileLowMemory;
}

export function isBelowFloor(profile: DeviceProfile = getDeviceProfile()): boolean {
  if (profile.webgpuSupport !== 'none') return false;
  return failsMemoryFloor(profile);
}

export function getBelowFloorReason(
  profile: DeviceProfile = getDeviceProfile(),
): BelowFloorReason {
  const constraints: string[] = [];

  if (profile.webgpuSupport === 'none') {
    constraints.push('No WebGPU or modern WebAssembly support detected');
  } else if (profile.webgpuSupport === 'wasm-only') {
    constraints.push('Only WebAssembly available (no WebGPU)');
  }

  if (profile.deviceMemoryGB > 0 && profile.deviceMemoryGB <= LOW_MEMORY_GB) {
    constraints.push(
      `Reported ${profile.deviceMemoryGB} GB of memory (need at least ${LOW_MEMORY_GB} GB)`,
    );
  }

  if (profile.isMobile) {
    constraints.push('Mobile browser with limited capability');
  }

  const constraint =
    constraints.length > 0
      ? constraints.join('; ')
      : 'Limited browser capability for on-device AI';

  return {
    browser: friendlyBrowserName(profile.browserClass),
    version: '',
    constraint,
  };
}

function friendlyBrowserName(browserClass: DeviceProfile['browserClass']): string {
  switch (browserClass) {
    case 'chromium':
      return 'Chromium-based browser';
    case 'safari':
      return 'Safari';
    case 'firefox':
      return 'Firefox';
    case 'mobile':
      return 'Mobile browser';
    case 'unknown':
    default:
      return 'this browser';
  }
}
