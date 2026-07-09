// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
/// <reference types="@webgpu/types" />

import {
  getValidationLocalDeviceProfileOverride,
  isValidationHarnessEnabled,
} from './validation-harness';

/**
 * Detect the browser's inference capability for on-device AI.
 *
 * Priority: WebGPU > WASM > unsupported
 */

// Re-exported from a dependency-free leaf so `validation-harness.ts` can name
// the type without importing this module (which imports the harness at runtime)
// — that was the type-only cycle. Existing `from './inference-capability'`
// imports of the type keep resolving through this re-export.
import type { InferenceCapability } from './inference-capability-types';
export type { InferenceCapability } from './inference-capability-types';

function readCapabilityOverride(): InferenceCapability | null {
  if (typeof window === 'undefined' || !isValidationHarnessEnabled()) {
    return null;
  }

  const profileOverride = getValidationLocalDeviceProfileOverride();
  if (profileOverride?.capability) {
    return profileOverride.capability;
  }

  try {
    const override = new URLSearchParams(window.location.search).get(
      'eco-force-capability',
    );

    if (
      override === 'webgpu'
      || override === 'wasm'
      || override === 'unsupported'
    ) {
      return override;
    }
  } catch {
    // Ignore malformed URL state and fall through to real detection.
  }

  return null;
}

function hasWasmInferenceSupport(): boolean {
  return typeof WebAssembly !== 'undefined' && typeof WebAssembly.validate === 'function';
}

/**
 * Synchronous capability snapshot for state hydration and default selection.
 *
 * This intentionally shares the same override-aware URL contract as the async
 * detector, while avoiding async work during store initialization.
 */
export function getInferenceCapabilitySync(): InferenceCapability {
  if (typeof window === 'undefined') {
    return 'unsupported';
  }

  const override = readCapabilityOverride();
  if (override) {
    return override;
  }

  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    return 'webgpu';
  }

  if (hasWasmInferenceSupport()) {
    return 'wasm';
  }

  return 'unsupported';
}

/**
 * Detect the best available inference backend.
 *
 * - Returns 'webgpu' when `navigator.gpu.requestAdapter()` succeeds.
 * - Returns 'wasm' when WebAssembly is available but WebGPU is not.
 * - Returns 'unsupported' when neither is available (or during SSR).
 *
 * On any error, falls back to 'wasm' as a safe default since WASM
 * has broader browser support than WebGPU.
 */
export async function getInferenceCapability(): Promise<InferenceCapability> {
  const override = readCapabilityOverride();
  if (override) {
    return override;
  }

  const capability = getInferenceCapabilitySync();
  if (capability !== 'webgpu') {
    return capability;
  }

  try {
    // Check for WebGPU support
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      const gpu = navigator.gpu as GPU | undefined;
      if (gpu) {
        const adapter = await gpu.requestAdapter();
        if (adapter) {
          return 'webgpu';
        }
      }
    }

    // Fall back to WASM if WebAssembly is available
    if (hasWasmInferenceSupport()) {
      return 'wasm';
    }

    return 'unsupported';
  } catch {
    // On any error (e.g., requestAdapter throws), fall back to WASM
    // since it has broader support and is more reliable
    if (hasWasmInferenceSupport()) {
      return 'wasm';
    }
    return 'unsupported';
  }
}
