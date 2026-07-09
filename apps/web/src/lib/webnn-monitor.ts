// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebNN capability detection (NEXT-09).
 *
 * Detects whether the browser supports WebNN (Neural Processing Unit
 * access) and reports the available device type. This is passive
 * observation only — it does NOT switch inference to WebNN.
 *
 * WebNN shipped in Chrome 146 stable (March 2026) via origin trial.
 * Adoption is near-zero (0.000029% of page loads per Chrome metrics).
 * This module prepares for future WebNN-accelerated inference by
 * detecting capability on load.
 *
 * **Status:**
 * - Detection-only. Does not activate WebNN inference.
 * - Checks once on load (capability doesn't change within a page session).
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type WebNNDeviceType = 'npu' | 'gpu' | 'cpu';

export type WebNNStatus = {
  /** Whether WebNN is available in this browser */
  available: boolean;
  /** The device type WebNN would use, or null if unavailable */
  deviceType: WebNNDeviceType | null;
  /** Name of the WebNN backend, or null if unavailable */
  backendName: string | null;
};

// ── Detection ──────────────────────────────────────────────────────────────────

/**
 * Check WebNN capability and determine available device type.
 *
 * Detection flow:
 * 1. Check if `navigator.ml` exists (WebNN API surface)
 * 2. Attempt `navigator.ml.createContext()` to verify backend availability
 * 3. Read `deviceType` from the context to determine NPU/GPU/CPU
 *
 * If any step fails, returns `{ available: false }`.
 */
export async function getWebNNStatus(): Promise<WebNNStatus> {
  const unavailable: WebNNStatus = {
    available: false,
    deviceType: null,
    backendName: null,
  };

  // Guard: server-side rendering
  if (typeof navigator === 'undefined') {
    return unavailable;
  }

  // Check for WebNN API surface
  if (!navigator.ml) {
    return unavailable;
  }

  try {
    // Attempt to create a WebNN context to verify backend availability
    const context = await navigator.ml.createContext();

    // Determine device type from context
    const rawDeviceType = context.deviceType as string | undefined;
    let deviceType: WebNNDeviceType | null = null;

    if (rawDeviceType === 'npu') {
      deviceType = 'npu';
    } else if (rawDeviceType === 'gpu') {
      deviceType = 'gpu';
    } else if (rawDeviceType === 'cpu') {
      deviceType = 'cpu';
    } else {
      // Unknown device type — still available, default to GPU
      deviceType = 'gpu';
    }

    return {
      available: true,
      deviceType,
      backendName: rawDeviceType ?? 'unknown',
    };
  } catch {
    // createContext failed — WebNN not functional
    return unavailable;
  }
}

// ── Cached Result ──────────────────────────────────────────────────────────────

let cachedStatus: WebNNStatus | null = null;

/**
 * Check WebNN capability once and cache the result.
 *
 * WebNN availability doesn't change within a page session (requires
 * browser update or flag toggle, both of which reload the page).
 * Checking once on load avoids wasting resources polling every 60s.
 *
 * @returns Cached WebNNStatus (resolves immediately after first call)
 */
export async function checkWebNNOnce(): Promise<WebNNStatus> {
  if (cachedStatus !== null) return cachedStatus;
  cachedStatus = await getWebNNStatus();
  return cachedStatus;
}
