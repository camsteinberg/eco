// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase D — device/compatibility.ts unit tests.
 *
 * Tests:
 *   - Every v1.0 catalog model has a compatibility rule (no silent drift if
 *     someone adds a sixth model without updating the table).
 *   - Hardware floor enforced (≥16 GB for Phi-3, ≥8 GB for Bonsai,
 *     ≥4 GB for Qwen3, ≥3 GB for LFM2.5).
 *   - WebGPU floor enforced (Phi-3 / Bonsai require WebGPU).
 *   - Browser-engine floor enforced (only Chromium for WebGPU-required models).
 *   - `with-warning` for mobile form factor on desktop-targeted models.
 *   - `isAssignable` agrees with `isCompatible !== 'unsupported'`.
 */

import { describe, expect, it } from 'vitest';
import { getCatalog, getModel } from '../../catalog/catalog';
import {
  hasCompatibilityRule,
  isAssignable,
  isCompatible,
  isWebKitMobile,
  WEBKIT_MOBILE_VALIDATED_MODEL_IDS,
} from '../compatibility';
import type { DeviceProfile, ModelConfig } from '../../types';

const PROFILES = {
  chromiumHighMem: {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
  },
  chromiumCapableLaptop: {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 8,
    isMobile: false,
    override: 'auto',
  },
  chromiumLowMem: {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 4,
    isMobile: false,
    override: 'auto',
  },
  chromiumWasmOnly: {
    browserClass: 'chromium',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 8,
    isMobile: false,
    override: 'auto',
  },
  // WebGPU adapter present but WITHOUT the shader-f16 feature (e.g. Cam's
  // Windows PC, Chrome 149: 18 features, none of them shader-f16). f16 catalog
  // builds load then die on the first f16 op; only non-f16 (onnx-q4) models run.
  chromiumNoShaderF16: {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
    webgpuShaderF16: false,
  },
  // Same device class but the adapter DOES expose shader-f16 (the common case).
  chromiumShaderF16: {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
    webgpuShaderF16: true,
  },
  safariDesktop: {
    browserClass: 'safari',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
  },
  firefoxDesktop: {
    browserClass: 'firefox',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
  },
  mobileIphone: {
    browserClass: 'safari',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 4,
    isMobile: true,
    override: 'auto',
  },
  // Unclassifiable user-agent on otherwise-capable hardware. Post-change these
  // get the floor tier (safari/firefox parity), gated only by real capability.
  unknownWebgpu: {
    browserClass: 'unknown',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 8,
    isMobile: false,
    override: 'auto',
  },
  unknownWasmOnly: {
    browserClass: 'unknown',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 8,
    isMobile: false,
    override: 'auto',
  },
  unknownNoCapability: {
    browserClass: 'unknown',
    webgpuSupport: 'none',
    deviceMemoryGB: 8,
    isMobile: false,
    override: 'auto',
  },
  belowFloor: {
    browserClass: 'unknown',
    webgpuSupport: 'none',
    deviceMemoryGB: 2,
    isMobile: false,
    override: 'auto',
  },
} as const satisfies Record<string, DeviceProfile>;

function model(id: string): ModelConfig {
  const m = getModel(id);
  if (!m) throw new Error(`expected catalog model ${id}`);
  return m;
}

describe('device/compatibility — catalog coverage', () => {
  it('has a rule for every v1.0 catalog model', () => {
    for (const m of getCatalog()) {
      expect(hasCompatibilityRule(m.id), `missing rule for ${m.id}`).toBe(true);
    }
  });
});

describe('device/compatibility — Phi-3 Mini (high-memory WebGPU)', () => {
  const phi3 = () => model('local/phi3-mini-4k-q4f16');

  it('supported on Chromium WebGPU ≥16 GB', () => {
    expect(isCompatible(phi3(), PROFILES.chromiumHighMem)).toBe('supported');
    expect(isAssignable(phi3(), PROFILES.chromiumHighMem)).toBe(true);
  });

  it('unsupported on Chromium WebGPU 8 GB (below 16 GB floor)', () => {
    expect(isCompatible(phi3(), PROFILES.chromiumCapableLaptop)).toBe('unsupported');
    expect(isAssignable(phi3(), PROFILES.chromiumCapableLaptop)).toBe(false);
  });

  it('unsupported on Chromium WASM-only (requires WebGPU)', () => {
    expect(isCompatible(phi3(), PROFILES.chromiumWasmOnly)).toBe('unsupported');
  });

  it('unsupported on Safari and Firefox', () => {
    expect(isCompatible(phi3(), PROFILES.safariDesktop)).toBe('unsupported');
    expect(isCompatible(phi3(), PROFILES.firefoxDesktop)).toBe('unsupported');
  });
});

describe('device/compatibility — Qwen3 (universal small)', () => {
  const qwen = () => model('local/qwen3-0.6b');

  it('supported on Chromium WebGPU ≥4 GB', () => {
    expect(isCompatible(qwen(), PROFILES.chromiumLowMem)).toBe('supported');
    expect(isCompatible(qwen(), PROFILES.chromiumCapableLaptop)).toBe('supported');
    expect(isCompatible(qwen(), PROFILES.chromiumHighMem)).toBe('supported');
  });

  it('supported on Chromium WASM-only ≥4 GB', () => {
    expect(isCompatible(qwen(), PROFILES.chromiumWasmOnly)).toBe('supported');
  });

  it('supported on Safari', () => {
    expect(isCompatible(qwen(), PROFILES.safariDesktop)).toBe('supported');
  });

  it('supported on Firefox WASM (universal-small coverage)', () => {
    expect(isCompatible(qwen(), PROFILES.firefoxDesktop)).toBe('supported');
  });

  it('unsupported when webgpuSupport is none', () => {
    expect(isCompatible(qwen(), PROFILES.belowFloor)).toBe('unsupported');
  });
});

describe('device/compatibility — LFM2.5 350M (f16-less WebGPU rung, NOT a WASM model)', () => {
  const lfm = () => model('candidate/lfm2.5-350m-onnx');

  // Finding E / Every-Device Phase 0: the 350m onnx-q4 build block-quantizes its
  // embeddings → GatherBlockQuantized, which ort-web's CPU/WASM EP does not
  // implement ("Kernel not found"). It can NEVER load on a wasm-only device, so
  // it must be unsupported on every wasm-only profile — leaving qwen3-0.6b the
  // sole WASM floor and keeping it out of the doomed 4-minute setup cascade.
  it('UNSUPPORTED on Firefox WASM (CPU EP lacks GatherBlockQuantized)', () => {
    expect(isCompatible(lfm(), PROFILES.firefoxDesktop)).toBe('unsupported');
    expect(isAssignable(lfm(), PROFILES.firefoxDesktop)).toBe(false);
  });

  it('UNSUPPORTED on mobile Safari WASM', () => {
    expect(isCompatible(lfm(), PROFILES.mobileIphone)).toBe('unsupported');
  });

  it('UNSUPPORTED on Chromium WASM-only', () => {
    expect(isCompatible(lfm(), PROFILES.chromiumWasmOnly)).toBe('unsupported');
  });

  // It DOES load on the WebGPU EP, so it stays offerable on WebGPU devices —
  // including the f16-less adapter tier, where it is the light onnx-q4 rung.
  it('supported on Chromium WebGPU (memory floor permitting)', () => {
    expect(isCompatible(lfm(), PROFILES.chromiumLowMem)).toBe('supported');
  });

  it('supported on an f16-less WebGPU adapter (onnx-q4 needs no shader-f16)', () => {
    expect(isCompatible(lfm(), PROFILES.chromiumNoShaderF16)).toBe('supported');
    expect(isAssignable(lfm(), PROFILES.chromiumNoShaderF16)).toBe(true);
  });

  it('unsupported when webgpuSupport is none', () => {
    expect(isCompatible(lfm(), PROFILES.belowFloor)).toBe('unsupported');
  });
});

describe('device/compatibility — CPU-EP incompatibility (Finding E)', () => {
  // qwen3-0.6b is the ONLY genuinely WASM-viable model: its q4f16 build has no
  // block-quant embeddings, so it runs on the CPU EP. It must stay the WASM floor.
  it('keeps qwen3-0.6b assignable on every wasm-only profile', () => {
    // mobileIphone is excluded: iOS WebKit is now gated before load entirely
    // (see the WebKit-mobile gate suite below), so no model — qwen included —
    // is assignable there regardless of CPU-EP viability.
    for (const p of [PROFILES.chromiumWasmOnly, PROFILES.firefoxDesktop, PROFILES.safariDesktop]) {
      expect(isAssignable(model('local/qwen3-0.6b'), p)).toBe(true);
    }
  });

  it('leaves qwen3-0.6b the sole assignable model on a wasm-only device', () => {
    const assignable = getCatalog()
      .filter((m) => isAssignable(m, PROFILES.chromiumWasmOnly))
      .map((m) => m.id);
    expect(assignable).toEqual(['local/qwen3-0.6b']);
  });

  it('does NOT change WebGPU behavior — the CPU-EP rule only bites on wasm-only', () => {
    // The 350m stays supported on a WebGPU device; the rule is scoped to the CPU EP.
    expect(isCompatible(model('candidate/lfm2.5-350m-onnx'), PROFILES.chromiumLowMem)).toBe('supported');
  });
});

describe('device/compatibility — WebGPU adapter without shader-f16', () => {
  // f16 builds (onnx-q4f16 / onnx-q2f16) cannot run on the WebGPU EP
  // of an adapter that lacks shader-f16 — they load, then OrtRun dies on the
  // first f16 op. They must be flagged unsupported so the cascade never offers
  // them (and never burns a multi-minute download on a model that can't run).
  const f16Models = [
    'candidate/qwen3.5-2b-onnx',
    'candidate/lfm2.5-1.2b-instruct-onnx',
    'local/phi3-mini-4k-q4f16',
    'local/qwen3-0.6b',
  ] as const;

  it.each(f16Models)('flags f16 model %s unsupported on an f16-less WebGPU adapter', (id) => {
    expect(isCompatible(model(id), PROFILES.chromiumNoShaderF16)).toBe('unsupported');
    expect(isAssignable(model(id), PROFILES.chromiumNoShaderF16)).toBe(false);
  });

  // The non-f16 ONNX survivor — what the cascade surfaces for this device
  // instead of an honest dead-end. LFM2.5-350M is the f16-free q4 build
  // (instant-start plan slice 1, 2026-07-01), the light option a weak f16-less
  // iGPU can actually load. (Bonsai, the other non-f16 rung, retired 2026-07-11.)
  const nonF16OnnxModels = ['candidate/lfm2.5-350m-onnx'] as const;

  it.each(nonF16OnnxModels)('keeps non-f16 model %s runnable on an f16-less adapter', (id) => {
    expect(isCompatible(model(id), PROFILES.chromiumNoShaderF16)).toBe('supported');
    expect(isAssignable(model(id), PROFILES.chromiumNoShaderF16)).toBe(true);
  });

  it('does NOT restrict f16 models when the adapter DOES expose shader-f16', () => {
    expect(isCompatible(model('candidate/qwen3.5-2b-onnx'), PROFILES.chromiumShaderF16)).toBe('supported');
    expect(isCompatible(model('candidate/lfm2.5-1.2b-instruct-onnx'), PROFILES.chromiumShaderF16)).toBe('supported');
  });

  it('does NOT restrict f16 models when shader-f16 is unprobed (undefined → assume capable)', () => {
    // chromiumHighMem has no webgpuShaderF16 field — the synchronous profile and
    // every existing caller must behave exactly as before this gate existed.
    expect(isCompatible(model('candidate/qwen3.5-2b-onnx'), PROFILES.chromiumHighMem)).toBe('supported');
    expect(isCompatible(model('local/phi3-mini-4k-q4f16'), PROFILES.chromiumHighMem)).toBe('supported');
  });

  it('does NOT fire for f16 models on a WASM-only profile (WASM EP runs f16)', () => {
    // The gate is WebGPU-EP-specific: a wasm-only device runs f16 models on the
    // CPU WASM backend, which supports f16. qwen3-0.6b stays supported there.
    expect(isCompatible(model('local/qwen3-0.6b'), PROFILES.chromiumWasmOnly)).toBe('supported');
  });
});

describe('device/compatibility — unclassifiable browser (unknown UA)', () => {
  // An unknown UA no longer categorically rejects: it gets the floor tier
  // (qwen3-0.6b, and lfm2.5-350m on WebGPU), the same as safari/firefox. Its
  // real capability probes + the first-use smoke gate remain the gate.
  const qwen = () => model('local/qwen3-0.6b');
  const lfm = () => model('candidate/lfm2.5-350m-onnx');

  it('serves the WASM floor (qwen3-0.6b) on a capable WebGPU device', () => {
    expect(isCompatible(qwen(), PROFILES.unknownWebgpu)).toBe('supported');
    expect(isAssignable(qwen(), PROFILES.unknownWebgpu)).toBe(true);
  });

  it('serves qwen3-0.6b on a wasm-only device (the sole WASM floor)', () => {
    expect(isCompatible(qwen(), PROFILES.unknownWasmOnly)).toBe('supported');
    expect(isAssignable(qwen(), PROFILES.unknownWasmOnly)).toBe(true);
  });

  it('offers lfm2.5-350m on WebGPU but not wasm-only (CPU-EP incompatible)', () => {
    expect(isAssignable(lfm(), PROFILES.unknownWebgpu)).toBe(true);
    expect(isAssignable(lfm(), PROFILES.unknownWasmOnly)).toBe(false);
  });

  it('assigns NOTHING when the device has no WebGPU and no viable WASM', () => {
    for (const m of getCatalog()) {
      expect(isAssignable(m, PROFILES.unknownNoCapability), `${m.id} must stay unassignable`).toBe(false);
    }
  });

  it('does NOT open premium models to unknown UAs (they stay chromium-only)', () => {
    for (const id of ['candidate/qwen3.5-2b-onnx', 'candidate/lfm2.5-1.2b-instruct-onnx', 'local/phi3-mini-4k-q4f16', 'candidate/gemma-4-e2b-litert']) {
      expect(isAssignable(model(id), PROFILES.unknownWebgpu), `${id} must stay chromium-only`).toBe(false);
    }
  });
});

describe('device/compatibility — unknown model id', () => {
  it('returns unsupported for non-catalog ids', () => {
    const fakeModel: ModelConfig = {
      id: 'lab/experimental-9.99b',
      friendlyName: 'Experimental',
      vendor: 'Lab',
      sizeGB: 10,
      runtime: 'transformers',
      format: 'onnx-q4',
      capabilities: {
        intent: ['balanced'],
        tasks: ['chat'],
        contextTokens: 4096,
      },
      bestFor: '',
      knownLimitation: '',
      evidenceTier: 'experimental',
    };
    expect(isCompatible(fakeModel, PROFILES.chromiumHighMem)).toBe('unsupported');
    expect(isAssignable(fakeModel, PROFILES.chromiumHighMem)).toBe(false);
  });
});

describe('device/compatibility — WebKit-mobile gate (D1 designed tier)', () => {
  // iOS WebKit (Safari and every iOS browser, all classify safari+isMobile) has
  // WebGPU, but the model LOAD crash-loops the tab (iPhone-13 spike). It must be
  // declined BEFORE any load, and no model may be attempted until a
  // phone-validated config lands in WEBKIT_MOBILE_VALIDATED_MODEL_IDS.
  const iosSafariWebgpu: DeviceProfile = {
    browserClass: 'safari',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 8,
    isMobile: true,
    override: 'auto',
  };
  const safariDesktop: DeviceProfile = {
    browserClass: 'safari',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
  };
  const androidChrome: DeviceProfile = {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 8,
    isMobile: true,
    override: 'auto',
  };
  const strippedMobile: DeviceProfile = {
    browserClass: 'mobile',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 8,
    isMobile: true,
    override: 'auto',
  };

  it('isWebKitMobile truth table', () => {
    expect(isWebKitMobile(iosSafariWebgpu)).toBe(true); // safari + mobile
    expect(isWebKitMobile(safariDesktop)).toBe(false); // safari, desktop
    expect(isWebKitMobile(androidChrome)).toBe(false); // chromium + mobile
    expect(isWebKitMobile(strippedMobile)).toBe(false); // 'mobile' class
  });

  it('declines EVERY catalog model on iOS WebKit (no load ever attempted)', () => {
    for (const m of getCatalog()) {
      expect(isCompatible(m, iosSafariWebgpu), `${m.id} must decline on iOS WebKit`).toBe('unsupported');
      expect(isAssignable(m, iosSafariWebgpu)).toBe(false);
    }
  });

  it('the validated-list override lets a listed model serve on iOS WebKit', () => {
    // The retest trigger: adding an id to WEBKIT_MOBILE_VALIDATED_MODEL_IDS
    // (after a real-device pass) must flip that model from declined to offerable.
    const id = 'local/qwen3-0.6b';
    (WEBKIT_MOBILE_VALIDATED_MODEL_IDS as string[]).push(id);
    try {
      expect(isCompatible(model(id), iosSafariWebgpu)).not.toBe('unsupported');
    } finally {
      (WEBKIT_MOBILE_VALIDATED_MODEL_IDS as string[]).length = 0;
    }
  });

  it('does NOT gate Android Chrome — chromium+mobile keeps serving with-warning', () => {
    // The regression net for the Android guard: Android is not implicated and
    // must keep serving. qwen3-0.6b (warnIfMobile: false) stays 'supported';
    // a warn-on-mobile model stays offerable as 'with-warning'.
    expect(isCompatible(model('local/qwen3-0.6b'), androidChrome)).toBe('supported');
    expect(isCompatible(model('candidate/qwen3.5-2b-onnx'), androidChrome)).toBe('with-warning');
    expect(isAssignable(model('candidate/qwen3.5-2b-onnx'), androidChrome)).toBe(true);
  });

  it('starts with an empty validated list (every current build crash-loops on load)', () => {
    expect(WEBKIT_MOBILE_VALIDATED_MODEL_IDS).toEqual([]);
  });
});
