// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Device diagnosis — generates honest, profile-specific guidance copy when the
 * current device cannot run browser-local AI.
 *
 * This is the v1 equivalent of `lib/local-model-recommendation.ts`'s
 * `diagnoseUnsupportedLocalProfile`. The return shape is intentionally narrow:
 * the only callsite (useChat.ts `streamResponse`) reads `.guidance` only.
 */

import type { DeviceProfile } from '../types';

const LOW_MEMORY_THRESHOLD_GB = 8;

export type UnsupportedDiagnosis = {
  guidance: string;
};

function browserLabel(browserClass: DeviceProfile['browserClass']): string {
  switch (browserClass) {
    case 'chromium':
      return 'Chromium';
    case 'safari':
      return 'Safari';
    case 'firefox':
      return 'Firefox';
    case 'mobile':
      return 'this mobile browser';
    case 'unknown':
    default:
      return 'this browser';
  }
}

/**
 * Diagnose why the user's device profile cannot run browser-local AI and
 * return a user-friendly guidance string. Covers the same branches as the
 * legacy `diagnoseUnsupportedLocalProfile` but uses the v1 `DeviceProfile`
 * shape (§2 A.5 of the execution map).
 */
export function diagnoseUnsupportedProfile(
  profile: DeviceProfile,
): UnsupportedDiagnosis {
  // WebGPU fully missing + non-Chromium browser: browser-class unsupported
  if (profile.webgpuSupport === 'none') {
    return {
      guidance:
        `Eco isn't ready for ${browserLabel(profile.browserClass)} yet.`
        + ` Eco runs its AI right on your device, and this browser can't do that yet — try Chrome or Edge on a recent device.`,
    };
  }

  // Non-Chromium browsers that have some GPU support but haven't been validated
  if (profile.browserClass !== 'chromium' && profile.browserClass !== 'unknown') {
    return {
      guidance:
        `Eco hasn't validated on-device AI on ${browserLabel(profile.browserClass)} yet.`
        + ` For now, try Chrome or Edge on a recent device.`,
    };
  }

  // Mobile device
  if (profile.isMobile) {
    return {
      guidance:
        `On-device AI isn't available on mobile devices yet.`
        + ` For now, open Eco in Chrome or Edge on a recent computer.`,
    };
  }

  // Low memory with WebGPU support
  if (
    profile.deviceMemoryGB > 0
    && profile.deviceMemoryGB < LOW_MEMORY_THRESHOLD_GB
    && profile.webgpuSupport === 'webgpu'
  ) {
    return {
      guidance:
        `Eco hasn't validated browser-local AI for devices below ${LOW_MEMORY_THRESHOLD_GB} GB of RAM yet.`
        + ` Smaller models do exist and we expect to surface them once they pass review.`,
    };
  }

  // WASM-only fallback (detected WASM SIMD but no WebGPU)
  if (profile.webgpuSupport === 'wasm-only') {
    return {
      guidance:
        `This browser supports WebAssembly but not WebGPU. A WebAssembly fallback is available`
        + ` but slower — Eco hasn't validated it for production use yet.`,
    };
  }

  // Generic fallback
  return {
    guidance:
      `Eco hasn't tested this on ${browserLabel(profile.browserClass)} yet.`
      + ` A local model will surface here once validation lands — for now, try Chrome or Edge on a recent device.`,
  };
}
