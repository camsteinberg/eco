// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import type { InferenceCapability } from './inference-capability';
import type { ModelConfig } from '../local-ai/types';
import { getSlot, getSlotDisplayInfos, type SlotDisplayInfo } from '../local-ai/lifecycle/slots';

/**
 * Return a human-friendly description of the device's inference capability.
 * Uses non-technical language so everyday users understand what their device
 * can do without encountering terms like "WebGPU" or "WASM".
 */
export function describeCapability(
  capability: InferenceCapability,
  deviceMemoryGB: number | null,
): string {
  if (capability === 'webgpu') {
    if (deviceMemoryGB && deviceMemoryGB >= 8)
      return 'Your GPU can run powerful models locally';
    return 'Your GPU can run models locally';
  }
  if (capability === 'wasm')
    return 'Your device can run smaller models locally';
  return "Your browser doesn't support local AI yet";
}

/**
 * Return a human-friendly description of device memory.
 */
export function describeMemory(deviceMemoryGB: number | null): string {
  if (!deviceMemoryGB) return '';
  if (deviceMemoryGB >= 16) return 'Plenty of memory for large models';
  if (deviceMemoryGB >= 8) return 'Good memory for standard models';
  return 'Limited memory \u2014 smaller models recommended';
}

/**
 * Recommend the best model for the device based on capability and memory.
 * Returns null if the device is unsupported.
 */
export function recommendModel(
  capability: InferenceCapability,
  _deviceMemoryGB: number | null,
): ModelConfig | null {
  if (capability === 'unsupported') return null;
  const fastSlot = getSlot('eco-fast');
  if (fastSlot.model && fastSlot.status === 'ready') {
    return fastSlot.model;
  }
  return null;
}

export function recommendModelSlots(
  _capability: InferenceCapability,
  _deviceMemoryGB: number | null,
): SlotDisplayInfo[] {
  return getSlotDisplayInfos();
}
