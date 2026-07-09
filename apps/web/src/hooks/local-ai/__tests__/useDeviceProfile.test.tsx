// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * useDeviceProfile — the reactive device-profile hook.
 *
 * The reactive transition itself (the store notifying subscribers + returning a
 * NEW snapshot reference once the async adapter probe lands) is unit-tested
 * directly in `local-ai/device/__tests__/profile.test.ts` —
 * `subscribeDeviceProfile` / `getDeviceProfileSnapshot` against the real probe.
 * That is the contract `useSyncExternalStore` consumes.
 *
 * These tests cover the React wiring on top of it: the hook surfaces the LIVE
 * client snapshot (not the SSR fallback), and returns a referentially-STABLE
 * value across an unrelated re-render (the guarantee that keeps
 * useSyncExternalStore from re-rendering forever).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDeviceProfile } from '../useDeviceProfile';

const ORIGINAL_SEARCH = window.location.search;

function setSearch(value: string): void {
  window.history.replaceState({}, '', `/${value}`);
}

// These tests don't touch the cached probe verdict, so no reset is needed —
// and resetting here would fire the store notify while RTL's auto-unmount has
// not yet run, re-rendering the still-mounted hook outside act().
afterEach(() => {
  setSearch(ORIGINAL_SEARCH);
});

describe('useDeviceProfile', () => {
  it('surfaces the live client profile, not the SSR fallback', () => {
    // SSR fallback is { webgpuSupport: 'none', override: 'auto' }. Forcing a
    // different client profile proves the hook reads the client snapshot — so a
    // consumer reflects the real device, not the server placeholder.
    setSearch('?eco-force-capability=webgpu');

    const { result } = renderHook(() => useDeviceProfile());

    expect(result.current.webgpuSupport).toBe('webgpu');
    expect(result.current.override).toBe('user');
  });

  it('keeps a stable reference across an unrelated re-render', () => {
    const { result, rerender } = renderHook(() => useDeviceProfile());

    const before = result.current;
    rerender();
    // No store change → same referential snapshot. If getSnapshot returned a
    // fresh object here, useSyncExternalStore would re-render forever.
    expect(result.current).toBe(before);
  });
});
