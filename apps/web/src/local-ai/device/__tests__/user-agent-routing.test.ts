// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * User-agent → device profile → model pick, end to end, for real user agents.
 *
 * Every browser on iOS renders through WebKit, and so does every iOS in-app
 * browser (the WKWebView inside Instagram, Facebook, LinkedIn, TikTok, …). Those
 * in-app views usually send the iPhone user agent WITHOUT the `Safari/…` token,
 * so a classifier keyed on that token reads them as a generic mobile browser and
 * misses the WebKit-mobile gate that declines every ONNX build on iOS before
 * load (see `isWebKitMobile` in ../compatibility.ts). These cases pin that every
 * iOS user agent, in-app or not, classifies as WebKit mobile and is offered only
 * the iPhone entry — and that every non-iOS control keeps exactly the profile
 * and picks it had before the in-app fix.
 *
 * The capability axis (WebGPU, shader-f16, WASM) does not come from the user
 * agent, so each user agent is crossed with the four capability arms a real
 * device can report. Device memory follows what the engine reports: Chromium
 * exposes `navigator.deviceMemory` (8 here), WebKit and Gecko do not (0).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getModel } from '../../catalog/catalog';
import {
  canServe,
  listCandidates,
  listCatalog,
  NoAssignableModelError,
  recommend,
  starterModelForSlot,
} from '../../selection/recommend';
import type { BrowserClass, DeviceProfile, Slot } from '../../types';
import { isWebKitMobile, WEBKIT_MOBILE_VALIDATED_MODEL_IDS } from '../compatibility';
import { diagnoseUnsupportedProfile } from '../diagnosis';
import { getDeviceProfile, resetProbedWebgpuCapability } from '../profile';
import recordedLadders from '../../selection/__tests__/ladders-before-safari-ladder.json';

type UaCase = {
  label: string;
  ua: string;
  /** `navigator.maxTouchPoints`: 5 on an iPhone, iPad or Android phone; 0 on a Mac or PC. */
  maxTouchPoints: number;
  /** `navigator.deviceMemory`; undefined where the engine does not expose it. */
  deviceMemory?: number;
  /** Where the format comes from. */
  source: string;
};

const ARMS = {
  webgpu: { webgpuSupport: 'webgpu', webgpuShaderF16: true },
  webgpuNoF16: { webgpuSupport: 'webgpu', webgpuShaderF16: false },
  wasmOnly: { webgpuSupport: 'wasm-only', webgpuShaderF16: undefined },
  none: { webgpuSupport: 'none', webgpuShaderF16: undefined },
} as const satisfies Record<string, Pick<DeviceProfile, 'webgpuSupport' | 'webgpuShaderF16'>>;
type Arm = keyof typeof ARMS;
const ARM_NAMES = Object.keys(ARMS) as Arm[];
const SLOTS: readonly Slot[] = ['eco-fast', 'eco-smart'];

/** [eco-fast, eco-smart] per capability arm; null = no assignable model. */
type PicksByArm = Record<Arm, readonly [string | null, string | null]>;

type ControlCase = UaCase & {
  expected: { browserClass: BrowserClass; isMobile: boolean; picks: PicksByArm };
};

// The picks below were recorded from main at 2924958 (before the in-app fix) by
// running each control user agent through getDeviceProfile() and recommend().
const DESKTOP_SAFARI_PICKS: PicksByArm = {
  webgpu: ['candidate/qwen3-0.6b-mlc-q0f16', 'candidate/qwen3-0.6b-mlc-q0f16'],
  webgpuNoF16: ['candidate/lfm2.5-350m-onnx', null],
  wasmOnly: ['candidate/smollm2-360m-instruct-onnx', 'candidate/granite-4.0-350m-onnx'],
  none: [null, null],
};
const DESKTOP_CHROMIUM_8GB_PICKS: PicksByArm = {
  webgpu: ['candidate/lfm2.5-1.2b-instruct-onnx', 'candidate/lfm2-2.6b-onnx'],
  webgpuNoF16: ['candidate/lfm2.5-1.2b-instruct-q4-onnx', 'candidate/gemma-4-e2b-litert'],
  wasmOnly: ['candidate/smollm2-360m-instruct-onnx', 'candidate/granite-4.0-350m-onnx'],
  none: [null, null],
};
const MOBILE_CHROMIUM_8GB_PICKS: PicksByArm = {
  webgpu: ['candidate/lfm2.5-1.2b-instruct-onnx', 'local/qwen3-0.6b'],
  webgpuNoF16: ['candidate/lfm2.5-1.2b-instruct-q4-onnx', 'candidate/lfm2.5-1.2b-instruct-q4-onnx'],
  wasmOnly: ['candidate/smollm2-360m-instruct-onnx', 'candidate/granite-4.0-350m-onnx'],
  none: [null, null],
};
const FIREFOX_PICKS: PicksByArm = {
  webgpu: ['local/qwen3-0.6b', 'local/qwen3-0.6b'],
  webgpuNoF16: ['candidate/lfm2.5-350m-onnx', null],
  wasmOnly: ['candidate/smollm2-360m-instruct-onnx', 'candidate/granite-4.0-350m-onnx'],
  none: [null, null],
};

const IPHONE_ENTRY_ID = 'candidate/qwen2.5-0.5b-mlc';

const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
// A WKWebView with no application name: the Mac user agent minus any
// `Version/… Safari/…` suffix.
const MAC_WKWEBVIEW_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const IPHONE_PREFIX =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';

const IOS_CASES: readonly UaCase[] = [
  {
    label: 'iOS Safari (iPhone)',
    ua: `${IPHONE_PREFIX} Version/18.5 Mobile/15E148 Safari/604.1`,
    maxTouchPoints: 5,
    source: 'Apple Safari on iPhone, standard format',
  },
  {
    label: 'iOS Chrome (CriOS)',
    ua: `${IPHONE_PREFIX} CriOS/138.0.7204.119 Mobile/15E148 Safari/604.1`,
    maxTouchPoints: 5,
    source: 'Chrome for iOS documented format (CriOS token)',
  },
  {
    label: 'iOS Firefox (FxiOS)',
    ua: `${IPHONE_PREFIX} FxiOS/140.0 Mobile/15E148 Safari/605.1.15`,
    maxTouchPoints: 5,
    source: 'Firefox for iOS documented format (FxiOS token, MDN UA reference)',
  },
  {
    label: 'iOS Edge (EdgiOS)',
    ua: `${IPHONE_PREFIX} Version/18.0 EdgiOS/138.0.3351.95 Mobile/15E148 Safari/605.1.15`,
    maxTouchPoints: 5,
    source: 'Microsoft Edge for iOS documented format (EdgiOS token)',
  },
  {
    label: 'Facebook iOS in-app (FBAN/FBIOS)',
    ua: `${IPHONE_PREFIX} Mobile/15E148 [FBAN/FBIOS;FBAV/520.0.0.38.101;FBBV/736268744;FBDV/iPhone16,2;FBMD/iPhone;FBSN/iOS;FBSV/18.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/0]`,
    maxTouchPoints: 5,
    source: 'widely logged Facebook in-app pattern: WKWebView default UA + [FBAN/FBIOS;…] app token, no Safari token',
  },
  {
    label: 'Instagram iOS in-app',
    ua: `${IPHONE_PREFIX} Mobile/15E148 Instagram 385.0.0.31.87 (iPhone16,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 745683436)`,
    maxTouchPoints: 5,
    source: 'widely logged Instagram in-app pattern: WKWebView default UA + "Instagram <version> (<device>; iOS …)", no Safari token',
  },
  {
    label: 'LinkedIn iOS in-app',
    ua: `${IPHONE_PREFIX} Mobile/15E148 [LinkedInApp]/9.31.1426`,
    maxTouchPoints: 5,
    source: 'widely logged LinkedIn in-app pattern: WKWebView default UA + [LinkedInApp]/<version>, no Safari token',
  },
  {
    label: 'TikTok iOS in-app',
    ua: `${IPHONE_PREFIX} Mobile/15E148 musical_ly_40.6.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US isDarkMode/0 WKWebView/1 BytedanceWebview/d8a21c6`,
    maxTouchPoints: 5,
    source: 'widely logged TikTok in-app pattern: WKWebView default UA + musical_ly_<version> … BytedanceWebview, no Safari token',
  },
  {
    label: 'bare WKWebView (no app token)',
    ua: `${IPHONE_PREFIX} Mobile/15E148`,
    maxTouchPoints: 5,
    source: 'WKWebView default: applicationNameForUserAgent defaults to "Mobile/15E148" on iOS',
  },
  {
    label: 'iPad Safari (desktop-mode Mac UA)',
    ua: MAC_SAFARI_UA,
    maxTouchPoints: 5,
    source: 'iPadOS Safari sends the desktop Mac UA by default; an iPad reports 5 touch points',
  },
  {
    label: 'iPad in-app (Mac UA, no Safari token)',
    ua: MAC_WKWEBVIEW_UA,
    maxTouchPoints: 5,
    source: 'shape of a WKWebView in desktop content mode with no application name (iPadOS default); not captured on a device here',
  },
];

const CONTROL_CASES: readonly ControlCase[] = [
  {
    label: 'desktop Mac Safari',
    ua: MAC_SAFARI_UA,
    maxTouchPoints: 0,
    source: 'Apple Safari on macOS, standard format',
    expected: { browserClass: 'safari', isMobile: false, picks: DESKTOP_SAFARI_PICKS },
  },
  {
    label: 'desktop Chrome (Windows)',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    maxTouchPoints: 0,
    deviceMemory: 8,
    source: 'Chrome reduced UA, documented format',
    expected: { browserClass: 'chromium', isMobile: false, picks: DESKTOP_CHROMIUM_8GB_PICKS },
  },
  {
    label: 'desktop Chrome (Mac)',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    maxTouchPoints: 0,
    deviceMemory: 8,
    source: 'Chrome reduced UA, documented format',
    expected: { browserClass: 'chromium', isMobile: false, picks: DESKTOP_CHROMIUM_8GB_PICKS },
  },
  {
    label: 'desktop Edge (Windows)',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
    maxTouchPoints: 0,
    deviceMemory: 8,
    source: 'Microsoft Edge documented format (Edg/ token)',
    expected: { browserClass: 'chromium', isMobile: false, picks: DESKTOP_CHROMIUM_8GB_PICKS },
  },
  {
    label: 'desktop Firefox (Windows)',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
    maxTouchPoints: 0,
    source: 'Firefox desktop documented format (MDN UA reference)',
    expected: { browserClass: 'firefox', isMobile: false, picks: FIREFOX_PICKS },
  },
  {
    label: 'Android Chrome',
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
    maxTouchPoints: 5,
    deviceMemory: 8,
    source: 'Chrome for Android reduced UA, documented format',
    expected: { browserClass: 'chromium', isMobile: true, picks: MOBILE_CHROMIUM_8GB_PICKS },
  },
  {
    label: 'Android Samsung Internet',
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    maxTouchPoints: 5,
    deviceMemory: 8,
    source: 'Samsung Internet documented format (SamsungBrowser token + Chrome token)',
    expected: { browserClass: 'chromium', isMobile: true, picks: MOBILE_CHROMIUM_8GB_PICKS },
  },
  {
    label: 'Android Firefox',
    ua: 'Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
    maxTouchPoints: 5,
    source: 'Firefox for Android documented format (MDN UA reference)',
    expected: { browserClass: 'firefox', isMobile: true, picks: FIREFOX_PICKS },
  },
  {
    label: 'Android in-app WebView',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.63 Mobile Safari/537.36',
    maxTouchPoints: 5,
    deviceMemory: 8,
    source: 'Android WebView documented format ("; wv)" + Version/4.0 + Chrome token)',
    expected: { browserClass: 'chromium', isMobile: true, picks: MOBILE_CHROMIUM_8GB_PICKS },
  },
];

const ORIGINAL_USER_AGENT = navigator.userAgent;

function setNavigatorValue(key: 'userAgent' | 'maxTouchPoints' | 'deviceMemory', value: unknown): void {
  Object.defineProperty(navigator, key, { value, configurable: true });
}

/** The real detected profile for a user agent, with one capability arm applied. */
function profileFor(uaCase: UaCase, arm: Arm): DeviceProfile {
  setNavigatorValue('userAgent', uaCase.ua);
  setNavigatorValue('maxTouchPoints', uaCase.maxTouchPoints);
  setNavigatorValue('deviceMemory', uaCase.deviceMemory);
  return { ...getDeviceProfile(), ...ARMS[arm] };
}

function pick(slot: Slot, profile: DeviceProfile): string | null {
  try {
    return recommend(slot, profile).id;
  } catch (err) {
    if (err instanceof NoAssignableModelError) return null;
    throw err;
  }
}

/** Every model id any surface would offer this profile: picks, candidates, starters, the Switch list. */
function offeredIds(profile: DeviceProfile): Set<string> {
  const ids = new Set<string>();
  for (const slot of SLOTS) {
    const picked = pick(slot, profile);
    if (picked !== null) ids.add(picked);
    for (const candidate of listCandidates(slot, profile)) ids.add(candidate.model.id);
    const starter = starterModelForSlot(slot, profile);
    if (starter) ids.add(starter.id);
  }
  for (const { model } of listCatalog(profile).available) ids.add(model.id);
  return ids;
}

beforeEach(() => {
  resetProbedWebgpuCapability();
});

afterEach(() => {
  setNavigatorValue('userAgent', ORIGINAL_USER_AGENT);
  setNavigatorValue('maxTouchPoints', 0);
  setNavigatorValue('deviceMemory', undefined);
  resetProbedWebgpuCapability();
});

describe('iOS user agents — every one is WebKit mobile, in-app or not', () => {
  it.each(IOS_CASES)('$label classifies as WebKit mobile', (uaCase) => {
    const profile = profileFor(uaCase, 'webgpu');
    expect(profile.browserClass).toBe('safari');
    expect(profile.isMobile).toBe(true);
    expect(isWebKitMobile(profile)).toBe(true);
  });

  it.each(IOS_CASES)('$label gets the iPhone entry, alone, with WebGPU + shader-f16', (uaCase) => {
    const profile = profileFor(uaCase, 'webgpu');
    for (const slot of SLOTS) expect(pick(slot, profile), slot).toBe(IPHONE_ENTRY_ID);
    expect(listCatalog(profile).available.map((a) => a.model.id)).toEqual([IPHONE_ENTRY_ID]);
  });

  it.each(IOS_CASES)('$label is offered no ONNX build on any capability arm', (uaCase) => {
    for (const arm of ARM_NAMES) {
      const profile = profileFor(uaCase, arm);
      for (const id of offeredIds(profile)) {
        expect(getModel(id)?.format, `${arm}: ${id}`).not.toMatch(/^onnx-/);
        expect(WEBKIT_MOBILE_VALIDATED_MODEL_IDS, `${arm}: ${id}`).toContain(id);
      }
    }
  });

  // Pinned when desktop Safari's ladder changed (2026-10-08): every iOS user
  // agent, iPad included, keeps exactly the ladders it had, slot by slot.
  it.each(IOS_CASES)('$label keeps its full ladders on every capability arm', (uaCase) => {
    const ladders: Record<string, { fast: string[]; smart: string[]; catalog: string[] }> = recordedLadders.ladders;
    for (const arm of ARM_NAMES) {
      const profile = profileFor(uaCase, arm);
      expect({
        fast: listCandidates('eco-fast', profile).map((c) => c.model.id),
        smart: listCandidates('eco-smart', profile).map((c) => c.model.id),
        catalog: listCatalog(profile).available.map((a) => a.model.id),
      }, arm).toEqual(ladders[`iphone/${arm}`]);
    }
  });

  it.each(IOS_CASES)('$label without WebGPU + shader-f16 is declined to the iPhone handoff', (uaCase) => {
    for (const arm of ['webgpuNoF16', 'wasmOnly', 'none'] as const) {
      const profile = profileFor(uaCase, arm);
      expect(canServe(profile), arm).toBe(false);
      expect(diagnoseUnsupportedProfile(profile).guidance, arm).toContain('iPhone and iPad');
    }
  });
});

describe('non-iOS controls keep the profile and picks they had before the in-app fix', () => {
  it.each(CONTROL_CASES)('$label', (controlCase) => {
    const { expected } = controlCase;
    const base = profileFor(controlCase, 'webgpu');
    expect(base.browserClass).toBe(expected.browserClass);
    expect(base.isMobile).toBe(expected.isMobile);
    expect(isWebKitMobile(base)).toBe(false);
    for (const arm of ARM_NAMES) {
      const profile = profileFor(controlCase, arm);
      expect([pick('eco-fast', profile), pick('eco-smart', profile)], arm).toEqual(expected.picks[arm]);
      // Desktop Safari with WebGPU + shader-f16 has the iPhone entry as its
      // fallback after the Mac build (2026-10-08); no other control is offered it.
      const fallbackHere = expected.browserClass === 'safari' && arm === 'webgpu';
      expect(offeredIds(profile).has(IPHONE_ENTRY_ID), arm).toBe(fallbackHere);
    }
  });
});

// A Mac app's embedded WKWebView is WebKit on a Mac, so it now routes exactly
// like Safari on that Mac. Before the in-app fix it read 'unknown'; the picks
// were the same on every arm except WebGPU + shader-f16, where it got the ONNX
// Qwen3 build instead of the MLC build chosen for WebKit's tab memory limit.
describe('a Mac app WKWebView (Mac UA, no Safari token, no touch)', () => {
  const macApp: UaCase = {
    label: 'Mac app WKWebView',
    ua: MAC_WKWEBVIEW_UA,
    maxTouchPoints: 0,
    source: 'WKWebView default on macOS with no application name',
  };

  it('stays on the desktop path and routes like desktop Safari', () => {
    const base = profileFor(macApp, 'webgpu');
    expect(base.browserClass).toBe('safari');
    expect(base.isMobile).toBe(false);
    expect(isWebKitMobile(base)).toBe(false);
    for (const arm of ARM_NAMES) {
      const profile = profileFor(macApp, arm);
      expect([pick('eco-fast', profile), pick('eco-smart', profile)], arm).toEqual(DESKTOP_SAFARI_PICKS[arm]);
      expect(offeredIds(profile).has(IPHONE_ENTRY_ID), arm).toBe(arm === 'webgpu');
    }
  });
});

// Constructed, not a captured user agent: an Android WebView whose app replaced
// the Chrome/Safari suffix. Android WebKit-derived engines are Chromium, so the
// WebKit rule must not reach them — this stays the generic mobile class.
it('an Android WebKit UA with neither a Chrome nor a Safari token stays generic mobile', () => {
  const profile = profileFor(
    {
      label: 'Android WebView, suffix replaced',
      ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Mobile',
      maxTouchPoints: 5,
      deviceMemory: 8,
      source: 'constructed',
    },
    'webgpu',
  );
  expect(profile.browserClass).toBe('mobile');
  expect(profile.isMobile).toBe(true);
  expect(isWebKitMobile(profile)).toBe(false);
});
