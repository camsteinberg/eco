// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Device diagnosis — generates honest, profile-specific guidance copy when the
 * current device cannot run browser-local AI.
 *
 * The return shape is intentionally narrow: the only callsite (useChat.ts
 * `streamResponse`) reads `.guidance` only, and renders it verbatim in chat.
 * It fires solely when THIS device has nothing assignable — so every line must
 * explain this device's constraint without denying platform support Eco really
 * ships (iOS via the WebLLM/MLC lane; Android Chromium via the floor tier).
 */

import type { DeviceProfile } from '../types';
import { isWebKitMobile } from './compatibility';

/**
 * Routes WHICH explanation a memory-constrained device gets — it is NOT a
 * catalog floor. The real per-model floors live in `device/compatibility.ts`
 * and span 0–16 GB, so no number is ever quoted to the user: a device below
 * one model's floor is comfortably above another's.
 */
const LOW_MEMORY_GUIDANCE_THRESHOLD_GB = 8;

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
 * Diagnose why THIS device cannot run browser-local AI right now, and return a
 * user-friendly guidance string.
 *
 * The only thing this function may claim is why *this* device is stuck. It must
 * never deny support for a platform Eco actually serves — iPhone/iPad run a
 * validated lane through Safari, and Android Chromium is served today — so the
 * branches are ordered by the device's real constraint (form factor → runtime →
 * memory → browser), not by browser class.
 */
export function diagnoseUnsupportedProfile(
  profile: DeviceProfile,
): UnsupportedDiagnosis {
  // iOS / WebKit mobile FIRST. Eco ships a validated iPhone/iPad lane, so a
  // device landing here is blocked by its own capability (most often an iOS
  // version without WebGPU), not by a missing platform. "Try Chrome" would be
  // doubly false here: the lane exists, and every iOS browser is WebKit anyway.
  if (isWebKitMobile(profile)) {
    return {
      guidance:
        `Eco does run on iPhone and iPad — it just can't run on this one yet.`
        + ` Updating to the latest iOS is the most likely fix.`,
    };
  }

  // Neither WebGPU nor a viable WebAssembly tier: nothing can run here at all.
  if (profile.webgpuSupport === 'none') {
    if (profile.isMobile) {
      return {
        guidance:
          `Eco runs its AI right on your device, and this phone's browser can't do that yet.`
          + ` Updating the browser is the most likely fix.`,
      };
    }
    return {
      guidance:
        `Eco isn't ready for ${browserLabel(profile.browserClass)} yet.`
        + ` Eco runs its AI right on your device, and this browser can't do that yet — try Chrome or Edge on a recent device.`,
    };
  }

  // Mobile (non-iOS: Android Chromium and UA-stripped mobile browsers). These
  // browsers are served today, so the honest statement is about this handset,
  // not about mobile as a category — and never "open Chrome" to someone who is
  // already in it.
  if (profile.isMobile) {
    return {
      guidance:
        `Eco doesn't have a model it can run on this phone yet.`
        + ` It runs today on most recent computers, and we're working on covering more phones.`,
    };
  }

  // Capable browser, too little memory for anything Eco currently ships.
  if (
    profile.deviceMemoryGB > 0
    && profile.deviceMemoryGB < LOW_MEMORY_GUIDANCE_THRESHOLD_GB
    && profile.webgpuSupport === 'webgpu'
  ) {
    return {
      guidance:
        `This device doesn't have enough memory for the models Eco currently ships.`
        + ` Smaller models do exist and we expect to surface them once they pass review.`,
    };
  }

  // Desktop browsers Eco hasn't validated its models on. Reached only after the
  // form-factor and runtime branches above, so recommending Chrome or Edge here
  // means a different browser on the same computer — advice that holds.
  if (profile.browserClass !== 'chromium' && profile.browserClass !== 'unknown') {
    return {
      guidance:
        `Eco hasn't validated on-device AI on ${browserLabel(profile.browserClass)} yet.`
        + ` For now, try Chrome or Edge on this computer.`,
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

  // Generic fallback: a capable-looking desktop profile that still has nothing
  // assignable (e.g. every candidate ruled out by this device's own failure
  // evidence). We don't know the cause, so we don't invent one — and we don't
  // send a Chromium user to Chrome.
  return {
    guidance:
      `Eco couldn't find a model that runs on this device yet.`
      + ` We're steadily widening the range of devices Eco supports.`,
  };
}
