// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase D — device/below-floor.ts unit tests.
 *
 * Spec (vision §2.5):
 *   below-floor when
 *     no WebGPU AND
 *     no viable WASM AND
 *     (≤4 GB OR mobile-low-memory)
 *
 * `device/profile.ts` collapses "no WebGPU AND no viable WASM" into
 * `webgpuSupport === 'none'`, so the test exercises that signal plus the
 * memory tail.
 */

import { describe, expect, it } from 'vitest';
import { getBelowFloorReason, isBelowFloor } from '../below-floor';
import type { DeviceProfile } from '../../types';

function profile(overrides: Partial<DeviceProfile>): DeviceProfile {
  return {
    browserClass: 'unknown',
    webgpuSupport: 'none',
    deviceMemoryGB: 0,
    isMobile: false,
    override: 'auto',
    ...overrides,
  };
}

describe('isBelowFloor', () => {
  it('is true when no WebGPU/WASM AND 4 GB', () => {
    expect(isBelowFloor(profile({ webgpuSupport: 'none', deviceMemoryGB: 4 }))).toBe(true);
  });

  it('is true when no WebGPU/WASM AND 2 GB', () => {
    expect(isBelowFloor(profile({ webgpuSupport: 'none', deviceMemoryGB: 2 }))).toBe(true);
  });

  it('is true when no WebGPU/WASM AND mobile with 2 GB', () => {
    expect(
      isBelowFloor(
        profile({ webgpuSupport: 'none', deviceMemoryGB: 2, isMobile: true }),
      ),
    ).toBe(true);
  });

  it('is false when WebGPU is available (even with 4 GB)', () => {
    expect(
      isBelowFloor(profile({ webgpuSupport: 'webgpu', deviceMemoryGB: 4 })),
    ).toBe(false);
  });

  it('is false when WASM is available (even with 4 GB)', () => {
    expect(
      isBelowFloor(profile({ webgpuSupport: 'wasm-only', deviceMemoryGB: 4 })),
    ).toBe(false);
  });

  it('is false when memory is unreported (deviceMemoryGB === 0)', () => {
    // Without a memory reading we can't conclude below-floor; we err toward
    // letting the user try the lightest model.
    expect(isBelowFloor(profile({ webgpuSupport: 'none', deviceMemoryGB: 0 }))).toBe(false);
  });

  it('is false when no WebGPU/WASM but 8 GB (memory above the floor)', () => {
    expect(
      isBelowFloor(profile({ webgpuSupport: 'none', deviceMemoryGB: 8 })),
    ).toBe(false);
  });
});

describe('getBelowFloorReason', () => {
  it('returns browser/version/constraint when below-floor', () => {
    const reason = getBelowFloorReason(
      profile({ browserClass: 'safari', webgpuSupport: 'none', deviceMemoryGB: 2 }),
    );
    expect(reason.browser).toMatch(/Safari/i);
    expect(reason.version).toBe('');
    expect(reason.constraint).toMatch(/no webgpu|no.*webassembly/i);
    expect(reason.constraint).toMatch(/2 gb/i);
  });

  it('flags mobile in the constraint message when isMobile is true', () => {
    const reason = getBelowFloorReason(
      profile({
        browserClass: 'mobile',
        webgpuSupport: 'none',
        deviceMemoryGB: 2,
        isMobile: true,
      }),
    );
    expect(reason.constraint.toLowerCase()).toContain('mobile');
  });

  it('returns a generic constraint when no specific issue is detected', () => {
    const reason = getBelowFloorReason(
      profile({ browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 16 }),
    );
    expect(reason.constraint).toMatch(/limited browser capability/i);
  });
});
