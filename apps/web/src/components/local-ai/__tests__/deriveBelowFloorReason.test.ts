// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Reason-derivation ordering for the below-floor gate. The load-bearing
 * property is precedence: iOS WebKit must resolve to 'mobile' BEFORE the
 * runtime/memory branches, because it looks capable (it has WebGPU) yet is
 * gated before load. A regression that reordered these would mis-message iOS.
 */

import { describe, expect, it } from 'vitest';
import { deriveBelowFloorReason } from '../LocalAiSetupGate';
import type { DeviceProfile } from '../../../local-ai/index';

const base: DeviceProfile = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 8,
  isMobile: false,
  override: 'auto',
};

describe('deriveBelowFloorReason — precedence', () => {
  it('iOS WebKit resolves to mobile even with WebGPU present', () => {
    expect(
      deriveBelowFloorReason({ ...base, browserClass: 'safari', isMobile: true }),
    ).toBe('mobile');
  });

  it('mobile beats runtime (iOS WebKit with no runtime still reads mobile)', () => {
    expect(
      deriveBelowFloorReason({
        ...base,
        browserClass: 'safari',
        isMobile: true,
        webgpuSupport: 'none',
      }),
    ).toBe('mobile');
  });

  it('mobile beats memory (iOS WebKit short on memory still reads mobile)', () => {
    expect(
      deriveBelowFloorReason({
        ...base,
        browserClass: 'safari',
        isMobile: true,
        deviceMemoryGB: 2,
      }),
    ).toBe('mobile');
  });

  it('non-WebKit-mobile still falls through: no runtime → runtime', () => {
    expect(deriveBelowFloorReason({ ...base, webgpuSupport: 'none' })).toBe('runtime');
  });

  it('non-WebKit-mobile capable browser short on memory → memory', () => {
    expect(deriveBelowFloorReason({ ...base, deviceMemoryGB: 2 })).toBe('memory');
  });

  it('capable-but-unclassified → fallback', () => {
    expect(deriveBelowFloorReason(base)).toBe('fallback');
  });

  it('Android Chrome is not WebKit-mobile → not mobile reason', () => {
    expect(
      deriveBelowFloorReason({ ...base, browserClass: 'chromium', isMobile: true }),
    ).not.toBe('mobile');
  });
});
