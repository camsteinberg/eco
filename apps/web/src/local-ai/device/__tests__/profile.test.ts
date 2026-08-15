// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase D — device/profile.ts unit tests.
 *
 * These tests cover:
 *   - Known device-profile fixtures (Chromium WebGPU desktop, Chromium 8GB,
 *     Safari, Firefox WASM, mobile-low).
 *   - URL-param overrides (?eco-force-*) — match `validation-harness.ts`
 *     param names so existing test harnesses keep working.
 *   - SSR safety: no window / no navigator returns a safe fallback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetGpuEnvelopeForTesting,
  describeDevice,
  getDeviceProfile,
  getDeviceProfileSnapshot,
  getHardwareConcurrency,
  getLastProbedGpuEnvelope,
  getServerDeviceProfileSnapshot,
  probeWebGPUAdapter,
  probeWebgpuSupport,
  readForcedWasm,
  readForcedOrtArtifact,
  readForcedOrtArena,
  readForcedOrtMemPattern,
  readForcedOrtGraphOpt,
  readForcedThreads,
  resetProbedWebgpuCapability,
  resolveSetupProfile,
  subscribeDeviceProfile,
} from '../profile';
import type { DeviceProfile } from '../../types';

const ORIGINAL_USER_AGENT = navigator.userAgent;
const ORIGINAL_LOCATION_SEARCH = window.location.search;

function setUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    value,
    configurable: true,
  });
}

function setDeviceMemory(value: number | undefined): void {
  Object.defineProperty(navigator, 'deviceMemory', {
    value,
    configurable: true,
  });
}

function setHardwareConcurrency(value: number | undefined): void {
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    value,
    configurable: true,
  });
}

function setGpu(value: unknown): void {
  if (value === undefined) {
    delete (navigator as { gpu?: unknown }).gpu;
    return;
  }
  Object.defineProperty(navigator, 'gpu', {
    value,
    configurable: true,
  });
}

function setSearch(value: string): void {
  window.history.replaceState({}, '', `/${value}`);
}

beforeEach(() => {
  setUserAgent(ORIGINAL_USER_AGENT);
  setSearch(ORIGINAL_LOCATION_SEARCH);
  setGpu(undefined);
  setDeviceMemory(undefined);
  resetProbedWebgpuCapability();
  _resetGpuEnvelopeForTesting();
});

afterEach(() => {
  setUserAgent(ORIGINAL_USER_AGENT);
  setSearch(ORIGINAL_LOCATION_SEARCH);
  setGpu(undefined);
  setDeviceMemory(undefined);
  resetProbedWebgpuCapability();
  _resetGpuEnvelopeForTesting();
  vi.restoreAllMocks();
});

describe('getDeviceProfile — detection from navigator', () => {
  it('returns Chromium WebGPU high-memory profile when navigator.gpu present and Chrome UA', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    );
    setGpu({});
    setDeviceMemory(16);

    const profile = getDeviceProfile();

    expect(profile.browserClass).toBe('chromium');
    expect(profile.webgpuSupport).toBe('webgpu');
    expect(profile.deviceMemoryGB).toBe(16);
    expect(profile.isMobile).toBe(false);
    expect(profile.override).toBe('auto');
  });

  it('detects Firefox WASM-only when navigator.gpu absent on Firefox UA', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
    );
    setDeviceMemory(16);
    // jsdom's WebAssembly.validate does not accept the SIMD probe bytes, so we
    // simulate a real browser that does (Firefox 128+ supports SIMD).
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(true);

    const profile = getDeviceProfile();

    expect(profile.browserClass).toBe('firefox');
    expect(profile.webgpuSupport).toBe('wasm-only');
    expect(profile.isMobile).toBe(false);
  });

  it('falls back to none when WebGPU absent AND WASM SIMD probe rejected (jsdom default)', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
    );
    setDeviceMemory(16);
    // No WebAssembly.validate spy — exercises the SIMD-rejected path.

    const profile = getDeviceProfile();
    expect(profile.webgpuSupport).toBe('none');
  });

  it('detects Safari', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    );
    setDeviceMemory(16);

    const profile = getDeviceProfile();

    expect(profile.browserClass).toBe('safari');
    expect(profile.isMobile).toBe(false);
  });

  it('detects mobile UA', () => {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    );
    setDeviceMemory(4);

    const profile = getDeviceProfile();

    expect(profile.isMobile).toBe(true);
    expect(profile.deviceMemoryGB).toBe(4);
  });

  it('returns deviceMemoryGB = 0 when navigator.deviceMemory is undefined', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    );

    const profile = getDeviceProfile();
    expect(profile.deviceMemoryGB).toBe(0);
  });
});

describe('getDeviceProfile — URL-param overrides', () => {
  it('honors ?eco-force-device-memory=24 and marks override=user', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    );
    setGpu({});
    setDeviceMemory(16);
    setSearch('?eco-force-device-memory=24');

    const profile = getDeviceProfile();

    expect(profile.deviceMemoryGB).toBe(24);
    expect(profile.override).toBe('user');
  });

  it('honors ?eco-force-capability=wasm', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    );
    setGpu({});
    setSearch('?eco-force-capability=wasm');

    const profile = getDeviceProfile();
    expect(profile.webgpuSupport).toBe('wasm-only');
    expect(profile.override).toBe('user');
  });

  it('honors ?eco-force-capability=unsupported', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    );
    setGpu({});
    setSearch('?eco-force-capability=unsupported');

    const profile = getDeviceProfile();
    expect(profile.webgpuSupport).toBe('none');
  });

  it('honors ?eco-force-browser=firefox even on Chrome UA', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    );
    setSearch('?eco-force-browser=firefox');

    const profile = getDeviceProfile();
    expect(profile.browserClass).toBe('firefox');
  });

  it('honors ?eco-force-platform=mobile to force isMobile=true', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    );
    setSearch('?eco-force-platform=mobile');

    const profile = getDeviceProfile();
    expect(profile.isMobile).toBe(true);
  });

  it('honors ?eco-force-platform=desktop to force isMobile=false on mobile UA', () => {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    );
    setSearch('?eco-force-platform=desktop');

    const profile = getDeviceProfile();
    expect(profile.isMobile).toBe(false);
  });

  it('ignores invalid memory values and falls back to navigator.deviceMemory', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    );
    setGpu({});
    setDeviceMemory(8);
    setSearch('?eco-force-device-memory=not-a-number');

    const profile = getDeviceProfile();
    expect(profile.deviceMemoryGB).toBe(8);
    expect(profile.override).toBe('auto');
  });

  it('ignores invalid browser values and falls back to UA detection', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    );
    setSearch('?eco-force-browser=internet-explorer');

    const profile = getDeviceProfile();
    expect(profile.browserClass).toBe('chromium');
    expect(profile.override).toBe('auto');
  });
});

// ─── describeDevice — honest human label for the below-floor screen ─────────

describe('describeDevice — honest device labels', () => {
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

  it('labels desktop Safari "Safari"', () => {
    expect(describeDevice(profile({ browserClass: 'safari', isMobile: false }))).toBe('Safari');
  });

  it('labels mobile Safari "Safari on iPhone or iPad"', () => {
    expect(describeDevice(profile({ browserClass: 'safari', isMobile: true }))).toBe(
      'Safari on iPhone or iPad',
    );
  });

  it('labels desktop Firefox "Firefox"', () => {
    expect(describeDevice(profile({ browserClass: 'firefox', isMobile: false }))).toBe('Firefox');
  });

  it('labels mobile Firefox "Firefox on mobile"', () => {
    expect(describeDevice(profile({ browserClass: 'firefox', isMobile: true }))).toBe(
      'Firefox on mobile',
    );
  });

  it('labels a generic mobile browser "your mobile browser"', () => {
    expect(describeDevice(profile({ browserClass: 'mobile', isMobile: true }))).toBe(
      'your mobile browser',
    );
  });

  it('returns undefined for Chromium (below-floor there is a hardware limit, not a browser gap)', () => {
    expect(describeDevice(profile({ browserClass: 'chromium' }))).toBeUndefined();
  });

  it('returns undefined for an unknown browser class (keeps generic copy)', () => {
    expect(describeDevice(profile({ browserClass: 'unknown' }))).toBeUndefined();
  });
});

// ─── probeWebgpuSupport — adapter-aware capability for the setup decision ────

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

describe('probeWebgpuSupport', () => {
  it('returns "webgpu" when requestAdapter resolves an adapter', async () => {
    setUserAgent(CHROME_UA);
    setGpu({ requestAdapter: async () => ({ features: new Set(), limits: {} }) });

    await expect(probeWebgpuSupport()).resolves.toBe('webgpu');
  });

  it('downgrades to "wasm-only" when requestAdapter resolves null but WASM SIMD is viable', async () => {
    setUserAgent(CHROME_UA);
    setGpu({ requestAdapter: async () => null });
    // jsdom's WebAssembly.validate rejects the SIMD probe bytes; simulate a
    // real browser that accepts them so the WASM tier is reached.
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(true);

    await expect(probeWebgpuSupport()).resolves.toBe('wasm-only');
  });

  it('falls back to the WASM verdict if requestAdapter throws', async () => {
    setUserAgent(CHROME_UA);
    setGpu({
      requestAdapter: async () => {
        throw new Error('no adapter');
      },
    });
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(true);

    await expect(probeWebgpuSupport()).resolves.toBe('wasm-only');
  });

  it('honors ?eco-force-capability=webgpu without probing', async () => {
    const requestAdapter = vi.fn(async () => null);
    setUserAgent(CHROME_UA);
    setGpu({ requestAdapter });
    setSearch('?eco-force-capability=webgpu');

    await expect(probeWebgpuSupport()).resolves.toBe('webgpu');
    expect(requestAdapter).not.toHaveBeenCalled();
  });
});

describe('resolveSetupProfile', () => {
  it('overwrites webgpuSupport with the probed value, preserving other fields', async () => {
    setUserAgent(CHROME_UA);
    setDeviceMemory(8);
    setGpu({ requestAdapter: async () => null });
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(true);

    const profile = await resolveSetupProfile();

    expect(profile.webgpuSupport).toBe('wasm-only'); // probed (adapter null)
    expect(profile.deviceMemoryGB).toBe(8); // from getDeviceProfile
    expect(profile.browserClass).toBe('chromium');
  });
});

describe('resolveSetupProfile — shader-f16 capability', () => {
  it('sets webgpuShaderF16 true when the adapter exposes shader-f16', async () => {
    setUserAgent(CHROME_UA);
    setGpu({ requestAdapter: async () => ({ features: new Set(['shader-f16', 'subgroups']), limits: {} }) });

    const profile = await resolveSetupProfile();

    expect(profile.webgpuSupport).toBe('webgpu');
    expect(profile.webgpuShaderF16).toBe(true);
  });

  it('sets webgpuShaderF16 false when the adapter lacks shader-f16 (Cam\'s Windows PC)', async () => {
    setUserAgent(CHROME_UA);
    // Mirrors the real diagnostic: many features, none of them shader-f16.
    setGpu({ requestAdapter: async () => ({ features: new Set(['subgroups', 'timestamp-query']), limits: {} }) });

    const profile = await resolveSetupProfile();

    expect(profile.webgpuSupport).toBe('webgpu');
    expect(profile.webgpuShaderF16).toBe(false);
  });

  it('leaves webgpuShaderF16 undefined when the device is not WebGPU (wasm-only)', async () => {
    setUserAgent(CHROME_UA);
    setGpu({ requestAdapter: async () => null });
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(true);

    const profile = await resolveSetupProfile();

    expect(profile.webgpuSupport).toBe('wasm-only');
    expect(profile.webgpuShaderF16).toBeUndefined();
  });

  it('?eco-force-shader-f16=off forces false on a WebGPU device (reproduces the f16-less adapter anywhere)', async () => {
    setUserAgent(CHROME_UA);
    // Adapter actually HAS shader-f16, but the override wins so we can repro.
    setGpu({ requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: {} }) });
    setSearch('?eco-force-shader-f16=off');

    const profile = await resolveSetupProfile();

    expect(profile.webgpuSupport).toBe('webgpu');
    expect(profile.webgpuShaderF16).toBe(false);
  });

  it('?eco-force-shader-f16=on forces true even when the adapter lacks it', async () => {
    setUserAgent(CHROME_UA);
    setGpu({ requestAdapter: async () => ({ features: new Set(), limits: {} }) });
    setSearch('?eco-force-shader-f16=on');

    const profile = await resolveSetupProfile();

    expect(profile.webgpuShaderF16).toBe(true);
  });
});

describe('resolveSetupProfile — maxBufferSize surfacing (Wave 3 scaffolding)', () => {
  it('surfaces the adapter maxBufferSize onto webgpuMaxBufferBytes', async () => {
    setUserAgent(CHROME_UA);
    setGpu({
      requestAdapter: async () => ({
        features: new Set(['shader-f16']),
        limits: { maxBufferSize: 2_147_483_648 },
      }),
    });

    const profile = await resolveSetupProfile();

    expect(profile.webgpuSupport).toBe('webgpu');
    expect(profile.webgpuMaxBufferBytes).toBe(2_147_483_648);
  });

  it('leaves webgpuMaxBufferBytes undefined when the adapter reports no limit', async () => {
    setUserAgent(CHROME_UA);
    setGpu({ requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: {} }) });

    const profile = await resolveSetupProfile();

    expect(profile.webgpuSupport).toBe('webgpu');
    expect(profile.webgpuMaxBufferBytes).toBeUndefined();
  });

  it('leaves webgpuMaxBufferBytes undefined on a non-WebGPU (wasm-only) device', async () => {
    setUserAgent(CHROME_UA);
    setGpu({ requestAdapter: async () => null });
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(true);

    const profile = await resolveSetupProfile();

    expect(profile.webgpuSupport).toBe('wasm-only');
    expect(profile.webgpuMaxBufferBytes).toBeUndefined();
  });

  it('?eco-force-max-buffer-size overrides the probed value (reproduce a small-buffer adapter anywhere)', async () => {
    setUserAgent(CHROME_UA);
    // Adapter reports a large ceiling, but the override wins so we can repro a
    // constrained adapter on the Mac.
    setGpu({
      requestAdapter: async () => ({
        features: new Set(['shader-f16']),
        limits: { maxBufferSize: 4_000_000_000 },
      }),
    });
    setSearch('?eco-force-max-buffer-size=134217728');

    const profile = await resolveSetupProfile();

    expect(profile.webgpuMaxBufferBytes).toBe(134_217_728);
  });

  it('the sync getDeviceProfile() reflects the probed maxBufferSize once the probe lands', async () => {
    setUserAgent(CHROME_UA);
    setGpu({
      requestAdapter: async () => ({
        features: new Set(['shader-f16']),
        limits: { maxBufferSize: 1_500_000_000 },
      }),
    });

    // Before the probe: sync surface has no probed ceiling.
    expect(getDeviceProfile().webgpuMaxBufferBytes).toBeUndefined();

    await resolveSetupProfile(); // runs + caches the adapter probe

    // After: every sync surface reflects the real adapter ceiling.
    expect(getDeviceProfile().webgpuMaxBufferBytes).toBe(1_500_000_000);
  });
});

describe('readForcedWasm — ?eco-force-wasm override', () => {
  it('defaults to false with no param', () => {
    setSearch('?');
    expect(readForcedWasm()).toBe(false);
  });

  it.each(['1', 'on', 'true'])('?eco-force-wasm=%s forces the WASM execution path', (value) => {
    setSearch(`?eco-force-wasm=${value}`);
    expect(readForcedWasm()).toBe(true);
  });

  it('treats the bare flag (?eco-force-wasm) as on', () => {
    setSearch('?eco-force-wasm');
    expect(readForcedWasm()).toBe(true);
  });

  it('ignores unrecognized values', () => {
    setSearch('?eco-force-wasm=off');
    expect(readForcedWasm()).toBe(false);
  });
});

describe('readForcedOrtArtifact — ?eco-force-ort-artifact override', () => {
  it('returns null with no param', () => {
    setSearch('?');
    expect(readForcedOrtArtifact()).toBeNull();
  });

  it.each(['standard', 'asyncify', 'jspi'] as const)('honors ?eco-force-ort-artifact=%s', (value) => {
    setSearch(`?eco-force-ort-artifact=${value}`);
    expect(readForcedOrtArtifact()).toBe(value);
  });

  it('ignores an unknown artifact value', () => {
    setSearch('?eco-force-ort-artifact=jsep');
    expect(readForcedOrtArtifact()).toBeNull();
  });
});

describe('readForcedThreads — ?eco-force-threads override', () => {
  it('returns null with no param', () => {
    setSearch('?');
    expect(readForcedThreads()).toBeNull();
  });

  it.each([['1', 1], ['4', 4], ['16', 16]])('parses ?eco-force-threads=%s as %i', (value, expected) => {
    setSearch(`?eco-force-threads=${value}`);
    expect(readForcedThreads()).toBe(expected);
  });

  it.each(['0', '-2', '2.5', 'many', ''])('rejects non-positive-integer value %s', (value) => {
    setSearch(`?eco-force-threads=${value}`);
    expect(readForcedThreads()).toBeNull();
  });
});

describe('readForcedOrtArena — ?eco-force-ort-arena override', () => {
  it('returns null with no param', () => {
    setSearch('?');
    expect(readForcedOrtArena()).toBeNull();
  });

  it('honors on/off', () => {
    setSearch('?eco-force-ort-arena=off');
    expect(readForcedOrtArena()).toBe(false);
    setSearch('?eco-force-ort-arena=on');
    expect(readForcedOrtArena()).toBe(true);
  });

  it('ignores unrecognized values', () => {
    setSearch('?eco-force-ort-arena=maybe');
    expect(readForcedOrtArena()).toBeNull();
  });
});

describe('readForcedOrtMemPattern — ?eco-force-ort-mem-pattern override', () => {
  it('returns null with no param', () => {
    setSearch('?');
    expect(readForcedOrtMemPattern()).toBeNull();
  });

  it('honors on/off', () => {
    setSearch('?eco-force-ort-mem-pattern=off');
    expect(readForcedOrtMemPattern()).toBe(false);
    setSearch('?eco-force-ort-mem-pattern=on');
    expect(readForcedOrtMemPattern()).toBe(true);
  });

  it('ignores unrecognized values', () => {
    setSearch('?eco-force-ort-mem-pattern=1');
    expect(readForcedOrtMemPattern()).toBeNull();
  });
});

describe('readForcedOrtGraphOpt — ?eco-force-ort-graph-opt override', () => {
  it('returns null with no param', () => {
    setSearch('?');
    expect(readForcedOrtGraphOpt()).toBeNull();
  });

  it.each(['disabled', 'basic', 'extended', 'all'] as const)(
    'honors ?eco-force-ort-graph-opt=%s',
    (value) => {
      setSearch(`?eco-force-ort-graph-opt=${value}`);
      expect(readForcedOrtGraphOpt()).toBe(value);
    },
  );

  it('ignores an unknown level', () => {
    setSearch('?eco-force-ort-graph-opt=max');
    expect(readForcedOrtGraphOpt()).toBeNull();
  });
});

describe('getDeviceProfile — reflects the cached adapter probe', () => {
  it('carries the probed shader-f16 verdict once setup has probed (f16-less adapter)', async () => {
    setUserAgent(CHROME_UA);
    // Adapter exists but lacks shader-f16 (Cam's Windows iGPU class).
    setGpu({ requestAdapter: async () => ({ features: new Set(['subgroups']), limits: {} }) });
    setDeviceMemory(16);

    // Before the probe, the sync profile has only the optimistic guess and no
    // shader-f16 knowledge — every UI surface would still offer f16 models.
    expect(getDeviceProfile().webgpuShaderF16).toBeUndefined();

    // Setup runs the async probe (its only caller), which caches the verdict.
    await resolveSetupProfile();

    // Now the sync profile — what the model pickers read — reflects reality.
    const profile = getDeviceProfile();
    expect(profile.webgpuSupport).toBe('webgpu');
    expect(profile.webgpuShaderF16).toBe(false);
  });

  it('downgrades webgpuSupport to the probed tier when no working adapter exists', async () => {
    setUserAgent(CHROME_UA);
    setGpu({ requestAdapter: async () => null }); // API present, no usable adapter
    setDeviceMemory(16);
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(true);

    // Optimistic sync verdict before the probe.
    expect(getDeviceProfile().webgpuSupport).toBe('webgpu');

    await resolveSetupProfile();

    // After the probe the sync profile reflects the real (wasm-only) tier.
    expect(getDeviceProfile().webgpuSupport).toBe('wasm-only');
  });
});

// ─── getDiagnosticEnv — high-entropy UA Client Hints ────────────────────────

describe('getDiagnosticEnv — UA Client Hints (Apple Silicon detection)', () => {
  function setUserAgentData(data: unknown): void {
    Object.defineProperty(navigator, 'userAgentData', {
      value: data,
      configurable: true,
      writable: true,
    });
  }

  function clearUserAgentData(): void {
    Object.defineProperty(navigator, 'userAgentData', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    clearUserAgentData();
  });

  it('populates architecture and platform from userAgentData when available', async () => {
    const { getDiagnosticEnv } = await import('../profile');
    setUserAgentData({
      getHighEntropyValues: vi.fn().mockResolvedValue({
        architecture: 'arm',
        platform: 'macOS',
        platformVersion: '15.5.0',
        model: '',
        bitness: '64',
      }),
    });

    const env = await getDiagnosticEnv();
    expect(env.architecture).toBe('arm');
    expect(env.platform).toBe('macOS');
    expect(env.platformVersion).toBe('15.5.0');
    expect(env.bitness).toBe('64');
    // uaModel should be omitted when empty
    expect(env.uaModel).toBeUndefined();
  });

  it('returns basic env without high-entropy fields when userAgentData is absent', async () => {
    const { getDiagnosticEnv } = await import('../profile');
    clearUserAgentData();

    const env = await getDiagnosticEnv();
    expect(typeof env.userAgent).toBe('string');
    expect(env.architecture).toBeUndefined();
    expect(env.platform).toBeUndefined();
    expect(env.bitness).toBeUndefined();
  });

  it('returns basic env when getHighEntropyValues rejects', async () => {
    const { getDiagnosticEnv } = await import('../profile');
    setUserAgentData({
      getHighEntropyValues: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
    });

    const env = await getDiagnosticEnv();
    expect(typeof env.userAgent).toBe('string');
    // Should not throw — fields simply remain undefined
    expect(env.architecture).toBeUndefined();
  });

  it('includes uaModel when non-empty', async () => {
    const { getDiagnosticEnv } = await import('../profile');
    setUserAgentData({
      getHighEntropyValues: vi.fn().mockResolvedValue({
        architecture: 'arm',
        platform: 'Android',
        platformVersion: '14.0.0',
        model: 'Pixel 9',
        bitness: '64',
      }),
    });

    const env = await getDiagnosticEnv();
    expect(env.uaModel).toBe('Pixel 9');
  });
});

// ─── Reactive device-profile store (useSyncExternalStore backing) ───────────
//
// The store lets UI surfaces recompute the instant the async adapter probe
// resolves. Two contracts matter: (1) the client snapshot is referentially
// STABLE while the value is unchanged (else useSyncExternalStore re-renders
// forever), and (2) subscribers are notified — and a NEW snapshot reference is
// returned — once the probe verdict lands.
describe('reactive device-profile store', () => {
  /** A Chromium WebGPU env whose adapter lacks shader-f16 (Cam's PC class). */
  function setF16LessChromiumWebgpu(): void {
    setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    );
    setGpu({
      requestAdapter: async () => ({
        features: new Set(['subgroups', 'timestamp-query']),
        limits: {},
      }),
    });
  }

  it('getServerDeviceProfileSnapshot returns the stable SSR fallback', () => {
    const a = getServerDeviceProfileSnapshot();
    const b = getServerDeviceProfileSnapshot();
    expect(a).toBe(b); // same frozen reference — safe for hydration
    expect(a.webgpuSupport).toBe('none');
    expect(a.browserClass).toBe('unknown');
  });

  it('returns a referentially-stable snapshot while the value is unchanged', () => {
    setF16LessChromiumWebgpu();
    const first = getDeviceProfileSnapshot();
    const second = getDeviceProfileSnapshot();
    // Identity stability is the anti-infinite-loop guarantee for the hook.
    expect(second).toBe(first);
  });

  it('returns a NEW snapshot reflecting shader-f16=false after the probe lands', async () => {
    setF16LessChromiumWebgpu();
    const optimistic = getDeviceProfileSnapshot();
    expect(optimistic.webgpuSupport).toBe('webgpu');
    expect(optimistic.webgpuShaderF16).toBeUndefined(); // not probed yet

    await probeWebgpuSupport(); // runs the adapter probe + caches the verdict

    const probed = getDeviceProfileSnapshot();
    expect(probed).not.toBe(optimistic); // new reference → surfaces re-render
    expect(probed.webgpuShaderF16).toBe(false); // f16-less adapter detected
  });

  it('notifies subscribers when the probe verdict lands', async () => {
    setF16LessChromiumWebgpu();
    const listener = vi.fn();
    const unsubscribe = subscribeDeviceProfile(listener);

    await probeWebgpuSupport();

    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('notifies subscribers when the cached verdict is reset', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDeviceProfile(listener);

    resetProbedWebgpuCapability();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('stops notifying after unsubscribe', async () => {
    setF16LessChromiumWebgpu();
    const listener = vi.fn();
    const unsubscribe = subscribeDeviceProfile(listener);
    unsubscribe();

    await probeWebgpuSupport();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('getHardwareConcurrency', () => {
  const ORIGINAL_HARDWARE_CONCURRENCY = navigator.hardwareConcurrency;

  afterEach(() => {
    setHardwareConcurrency(ORIGINAL_HARDWARE_CONCURRENCY);
  });

  it('returns the reported positive core count', () => {
    setHardwareConcurrency(4);
    expect(getHardwareConcurrency()).toBe(4);
  });

  it('returns null when the count is zero', () => {
    setHardwareConcurrency(0);
    expect(getHardwareConcurrency()).toBeNull();
  });

  it('returns null when the count is unavailable', () => {
    setHardwareConcurrency(undefined);
    expect(getHardwareConcurrency()).toBeNull();
  });
});

// ─── probeWebGPUAdapter — GPU-envelope caching (shadow evidence) ─────────────

describe('probeWebGPUAdapter GPU-envelope cache', () => {
  it('starts empty', () => {
    expect(getLastProbedGpuEnvelope()).toBeNull();
  });

  it('caches maxBufferSize and maxStorageBufferBindingSize after a successful probe', async () => {
    setGpu({
      requestAdapter: async () => ({
        features: new Set(),
        limits: { maxBufferSize: 750_000_000, maxStorageBufferBindingSize: 128_000_000 },
      }),
    });

    await probeWebGPUAdapter();

    expect(getLastProbedGpuEnvelope()).toEqual({
      maxBufferSize: 750_000_000,
      maxStorageBufferBindingSize: 128_000_000,
    });
  });

  it('caches a partial envelope when only maxBufferSize is exposed', async () => {
    setGpu({
      requestAdapter: async () => ({
        features: new Set(),
        limits: { maxBufferSize: 750_000_000 },
      }),
    });

    await probeWebGPUAdapter();

    expect(getLastProbedGpuEnvelope()).toEqual({ maxBufferSize: 750_000_000 });
  });

  it('a later failed probe does not erase a previously cached envelope', async () => {
    setGpu({
      requestAdapter: async () => ({
        features: new Set(),
        limits: { maxBufferSize: 750_000_000 },
      }),
    });
    await probeWebGPUAdapter();

    setGpu({ requestAdapter: async () => null });
    await probeWebGPUAdapter();

    expect(getLastProbedGpuEnvelope()).toEqual({ maxBufferSize: 750_000_000 });
  });

  it('a probe whose adapter exposes no numeric limits leaves the cache untouched', async () => {
    setGpu({ requestAdapter: async () => ({ features: new Set(), limits: {} }) });

    await probeWebGPUAdapter();

    expect(getLastProbedGpuEnvelope()).toBeNull();
  });
});
