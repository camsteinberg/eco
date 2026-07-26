// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { diagnoseUnsupportedProfile } from '../diagnosis';
import type { DeviceProfile } from '../../types';

function makeProfile(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
    ...overrides,
  };
}

// ─── Profiles that can actually reach this function ────────────────────────
// It fires only when THIS device has nothing assignable, so each fixture is a
// real constraint, not a platform Eco fails to support.

/** Older iPhone/iPad: the shipped MLC lane needs WebGPU, this one lacks it. */
const IOS_NO_WEBGPU = makeProfile({
  browserClass: 'safari',
  isMobile: true,
  webgpuSupport: 'wasm-only',
  deviceMemoryGB: 0,
});
/** Same platform, no runtime tier at all. */
const IOS_NO_RUNTIME = makeProfile({
  browserClass: 'safari',
  isMobile: true,
  webgpuSupport: 'none',
  deviceMemoryGB: 0,
});
/** Android Chrome — a served browser, on hardware nothing fits. */
const ANDROID_UNSERVABLE = makeProfile({
  browserClass: 'chromium',
  isMobile: true,
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 2,
});
/** Mobile browser whose UA we can't classify. */
const MOBILE_UNKNOWN_UA = makeProfile({
  browserClass: 'mobile',
  isMobile: true,
  webgpuSupport: 'wasm-only',
  deviceMemoryGB: 2,
});
const DESKTOP_FIREFOX_NO_RUNTIME = makeProfile({
  browserClass: 'firefox',
  webgpuSupport: 'none',
});
const DESKTOP_SAFARI_WASM_ONLY = makeProfile({
  browserClass: 'safari',
  webgpuSupport: 'wasm-only',
});
const DESKTOP_CHROMIUM_WASM_ONLY = makeProfile({ webgpuSupport: 'wasm-only' });
const DESKTOP_LOW_MEMORY = makeProfile({ deviceMemoryGB: 4 });
const DESKTOP_UNKNOWN_BROWSER = makeProfile({ browserClass: 'unknown' });

const REACHABLE_PROFILES: readonly (readonly [string, DeviceProfile])[] = [
  ['iOS without usable WebGPU', IOS_NO_WEBGPU],
  ['iOS with no runtime at all', IOS_NO_RUNTIME],
  ['Android Chromium that cannot be served', ANDROID_UNSERVABLE],
  ['UA-stripped mobile browser', MOBILE_UNKNOWN_UA],
  ['desktop Firefox with no runtime', DESKTOP_FIREFOX_NO_RUNTIME],
  ['desktop Safari, WASM only', DESKTOP_SAFARI_WASM_ONLY],
  ['desktop Chromium, WASM only', DESKTOP_CHROMIUM_WASM_ONLY],
  ['desktop Chromium, low memory', DESKTOP_LOW_MEMORY],
  ['desktop with an unrecognised browser', DESKTOP_UNKNOWN_BROWSER],
];

describe('diagnoseUnsupportedProfile', () => {
  describe('honesty invariants, across every reachable profile', () => {
    for (const [label, profile] of REACHABLE_PROFILES) {
      it(`claims nothing false for ${label}`, () => {
        const { guidance } = diagnoseUnsupportedProfile(profile);

        // Never denies a platform Eco actually ships on.
        expect(guidance).not.toMatch(/(isn't|is not|not) available on mobile/i);
        // Never quotes a RAM threshold — the real floors span 0–16 GB.
        expect(guidance).not.toMatch(/\d+\s?GB/i);
        // Never sends someone to the browser they are already using.
        if (profile.browserClass === 'chromium') {
          expect(guidance).not.toMatch(/Chrome or Edge/i);
        }
        // Never advises a different browser on iOS — they are all WebKit.
        if (profile.browserClass === 'safari' && profile.isMobile) {
          expect(guidance).not.toMatch(/Chrome|Edge|Firefox/i);
        }
        expect(guidance).not.toContain('Eco Network');
      });
    }
  });

  it('tells an iOS device the truth: the lane exists, this device needs a newer iOS', () => {
    const result = diagnoseUnsupportedProfile(IOS_NO_WEBGPU);
    expect(result.guidance).toMatch(/iPhone and iPad/i);
    expect(result.guidance).toMatch(/latest iOS/i);
    // The stale copy denied Safari support outright.
    expect(result.guidance).not.toMatch(/hasn't validated on-device AI on Safari/i);
  });

  it('puts the iOS branch ahead of the runtime branch', () => {
    expect(diagnoseUnsupportedProfile(IOS_NO_RUNTIME).guidance).toMatch(/iPhone and iPad/i);
  });

  it('tells an unservable Android device about this handset, not about mobile as a category', () => {
    const result = diagnoseUnsupportedProfile(ANDROID_UNSERVABLE);
    expect(result.guidance).toMatch(/doesn't have a model it can run on this phone/i);
    expect(result.guidance).not.toMatch(/open Eco in Chrome or Edge/i);
  });

  it('routes a UA-stripped mobile browser to the phone copy, not the browser-class copy', () => {
    const result = diagnoseUnsupportedProfile(MOBILE_UNKNOWN_UA);
    expect(result.guidance).toMatch(/this phone/i);
    expect(result.guidance).not.toMatch(/hasn't validated on-device AI/i);
  });

  it('names the browser when a desktop browser has no runtime at all', () => {
    const result = diagnoseUnsupportedProfile(DESKTOP_FIREFOX_NO_RUNTIME);
    expect(result.guidance).toContain('Firefox');
    expect(result.guidance).toContain('Chrome or Edge');
  });

  it('points a desktop non-Chromium browser at Chrome or Edge on the same computer', () => {
    const result = diagnoseUnsupportedProfile(DESKTOP_SAFARI_WASM_ONLY);
    expect(result.guidance).toContain('Safari');
    expect(result.guidance).toMatch(/Chrome or Edge on this computer/i);
  });

  it('returns wasm-only guidance for chromium wasm-only', () => {
    const result = diagnoseUnsupportedProfile(DESKTOP_CHROMIUM_WASM_ONLY);
    expect(result.guidance).toContain('WebAssembly');
    expect(result.guidance).toContain('not WebGPU');
  });

  it('states the memory shortfall without quoting a threshold that matches no model', () => {
    const result = diagnoseUnsupportedProfile(DESKTOP_LOW_MEMORY);
    expect(result.guidance).toMatch(/doesn't have enough memory/i);
    expect(result.guidance).toMatch(/Smaller models/i);
  });

  it('puts memory ahead of browser class for a low-memory desktop Safari', () => {
    const result = diagnoseUnsupportedProfile(
      makeProfile({ browserClass: 'safari', deviceMemoryGB: 4 }),
    );
    expect(result.guidance).toMatch(/doesn't have enough memory/i);
  });

  it('invents no cause in the generic fallback', () => {
    const result = diagnoseUnsupportedProfile(DESKTOP_UNKNOWN_BROWSER);
    expect(result.guidance).toMatch(/couldn't find a model that runs on this device/i);
    // The stale copy blamed the browser ("Eco hasn't tested this on …").
    expect(result.guidance).not.toMatch(/hasn't tested/i);
  });
});
