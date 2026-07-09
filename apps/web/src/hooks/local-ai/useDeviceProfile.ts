// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useSyncExternalStore } from 'react';
import {
  getDeviceProfileSnapshot,
  getServerDeviceProfileSnapshot,
  subscribeDeviceProfile,
} from '../../local-ai/device/profile';
import type { DeviceProfile } from '../../local-ai/types';

/**
 * Reactive device profile.
 *
 * The device's real capability (working WebGPU adapter + `shader-f16`) is only
 * known after the async adapter probe runs during setup — AFTER the first
 * paint. Surfaces that read the sync `getDeviceProfile()` inside a frozen
 * `useMemo` never recomputed when that verdict landed, so an f16-less device
 * could keep being offered f16 models it can't run until an unrelated
 * re-render. This hook subscribes to the device-profile store so the component
 * recomputes the instant the probe resolves — across every surface, with no
 * per-component async wiring.
 *
 * SSR-safe: returns the SSR fallback during server render + hydration, then the
 * real client profile post-hydration (the sanctioned useSyncExternalStore
 * pattern — no hydration mismatch). Use this in render paths that must reflect
 * device capability (model pickers, the "Recommended" tag). Call-site reads
 * (event handlers, effects) can keep using `getDeviceProfile()` directly.
 */
export function useDeviceProfile(): DeviceProfile {
  return useSyncExternalStore(
    subscribeDeviceProfile,
    getDeviceProfileSnapshot,
    getServerDeviceProfileSnapshot,
  );
}
