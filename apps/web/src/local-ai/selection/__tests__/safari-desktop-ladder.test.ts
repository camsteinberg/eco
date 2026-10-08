// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Desktop Safari with WebGPU + shader-f16: the fallback ladder (owner ruling
 * 2026-10-08).
 *
 * The ladder there is the unquantised MLC Qwen3 build → the iPhone's MLC
 * Qwen2.5-0.5B ("Eco Mobile") → an honest stop. The ONNX Qwen3 build and the
 * LFM2.5-350M are not offered on that class: the ONNX build's recorded Safari
 * peaks sit at the tab-kill line, and the 350M is unmeasured there. Both are
 * declined by their own catalog entries (`compat.declineOn`), so every route
 * that walks the ladder — first pick, starter, cascade demotion, the Switch
 * list, a failed switch's suggestion — is covered by the one compatibility
 * verdict. These tests walk the real catalog through each of those routes.
 *
 * Every other device class keeps exactly the ladder it had: the recorded table
 * at the bottom pins it, captured before this change.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getModel } from '../../catalog/catalog';
import { isAssignable } from '../../device/compatibility';
import { clearEvidence, recordEvidence } from '../../evidence/ledger';
import { runSetupCascade, type AttemptResult } from '../../lifecycle/setup-cascade';
import { cascadePath, nextInCascade } from '../cascade';
import { listCandidates, listCatalog, recommend, starterModelForSlot } from '../recommend';
import type { DeviceProfile, ModelConfig } from '../../types';
import recorded from './ladders-before-safari-ladder.json';

const MAC_MLC = 'candidate/qwen3-0.6b-mlc-q0f16';
const MOBILE_MLC = 'candidate/qwen2.5-0.5b-mlc';
const ONNX_QWEN3 = 'local/qwen3-0.6b';
const LFM_350M = 'candidate/lfm2.5-350m-onnx';

const DESKTOP_SAFARI: DeviceProfile = {
  browserClass: 'safari', webgpuSupport: 'webgpu', deviceMemoryGB: 0, isMobile: false, override: 'auto', webgpuShaderF16: true,
};
// The sync profile before setup's adapter probe lands: f16 unknown, assumed capable.
const DESKTOP_SAFARI_UNPROBED: DeviceProfile = { ...DESKTOP_SAFARI, webgpuShaderF16: undefined };

const model = (id: string): ModelConfig => {
  const found = getModel(id);
  if (!found) throw new Error(`catalog lost ${id}`);
  return found;
};

beforeEach(() => {
  localStorage.clear();
  clearEvidence();
});

describe('desktop Safari with WebGPU + shader-f16 — who is assignable', () => {
  for (const [label, profile] of [
    ['f16 probed', DESKTOP_SAFARI],
    ['f16 unprobed', DESKTOP_SAFARI_UNPROBED],
  ] as const) {
    it(`${label}: both MLC builds, neither ONNX build`, () => {
      expect(isAssignable(model(MAC_MLC), profile)).toBe(true);
      expect(isAssignable(model(MOBILE_MLC), profile)).toBe(true);
      expect(isAssignable(model(ONNX_QWEN3), profile)).toBe(false);
      expect(isAssignable(model(LFM_350M), profile)).toBe(false);
    });
  }

  it('leaves desktop Safari without shader-f16 on the 350M alone', () => {
    const noF16 = { ...DESKTOP_SAFARI, webgpuShaderF16: false };
    expect(isAssignable(model(LFM_350M), noF16)).toBe(true);
    expect(isAssignable(model(MOBILE_MLC), noF16)).toBe(false);
    expect(isAssignable(model(MAC_MLC), noF16)).toBe(false);
  });

  it('leaves desktop Safari without WebGPU on the ONNX build (CPU path)', () => {
    const wasmOnly = { ...DESKTOP_SAFARI, webgpuSupport: 'wasm-only' as const, webgpuShaderF16: undefined };
    expect(isAssignable(model(ONNX_QWEN3), wasmOnly)).toBe(true);
    expect(isAssignable(model(MOBILE_MLC), wasmOnly)).toBe(false);
  });
});

describe('desktop Safari with WebGPU + shader-f16 — the ladder', () => {
  for (const [label, profile] of [
    ['f16 probed', DESKTOP_SAFARI],
    ['f16 unprobed', DESKTOP_SAFARI_UNPROBED],
  ] as const) {
    it(`${label}: both slots walk the Mac build, then Eco Mobile, then stop`, () => {
      expect(cascadePath('eco-fast', profile).map((m) => m.id)).toEqual([MAC_MLC, MOBILE_MLC]);
      expect(cascadePath('eco-smart', profile).map((m) => m.id)).toEqual([MAC_MLC, MOBILE_MLC]);
    });

    // R8: the manual Settings list.
    it(`${label}: the Switch list offers the two MLC builds and nothing else`, () => {
      expect(listCatalog(profile).available.map((a) => a.model.id)).toEqual([MAC_MLC, MOBILE_MLC]);
    });
  }

  it('the step after the Mac build is Eco Mobile, and after Eco Mobile there is none', () => {
    expect(nextInCascade(model(MAC_MLC), 'eco-fast', DESKTOP_SAFARI)?.id).toBe(MOBILE_MLC);
    expect(nextInCascade(model(MOBILE_MLC), 'eco-fast', DESKTOP_SAFARI, undefined, {
      excludeIds: [MAC_MLC],
    })).toBeNull();
  });

  // R4: a smoke-fail row hides the Mac build from auto-offer for 30 days.
  it('starts on Eco Mobile, not the ONNX build, after the Mac build smoke-failed', () => {
    recordEvidence({ modelId: MAC_MLC, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });
    expect(starterModelForSlot('eco-fast', DESKTOP_SAFARI)?.id).toBe(MOBILE_MLC);
    expect(recommend('eco-fast', DESKTOP_SAFARI).id).toBe(MOBILE_MLC);
  });

  // R5: two download failures in 7 days drop the Mac build from auto-offer.
  it('starts on Eco Mobile, not the ONNX build, after two Mac-build download failures', () => {
    recordEvidence({ modelId: MAC_MLC, profile: DESKTOP_SAFARI, outcome: 'download-fail' });
    recordEvidence({ modelId: MAC_MLC, profile: DESKTOP_SAFARI, outcome: 'download-fail' });
    expect(starterModelForSlot('eco-fast', DESKTOP_SAFARI)?.id).toBe(MOBILE_MLC);
  });
});

// R1, R2, R3 and R6 all leave the first pick through the setup cascade. R6 (a
// cooldown after device-lost) fails smoke with `cooldown-active`, so it takes
// the smoke-fail route.
describe('desktop Safari with WebGPU + shader-f16 — the setup cascade on the real catalog', () => {
  const failures: ReadonlyArray<readonly [string, AttemptResult]> = [
    ['R1: load or smoke fails', { ok: false, phase: 'load-or-smoke', reason: 'smoke failed' }],
    ['R2: the download fails twice', { ok: false, phase: 'download', reason: 'HTTP 503' }],
    ['R3: storage runs short', {
      ok: false, phase: 'download', reason: 'no space', reasonCode: 'insufficient-storage',
    }],
    ['R6: a cooldown after device-lost', { ok: false, phase: 'load-or-smoke', reason: 'cooldown-active' }],
  ];

  for (const [label, failure] of failures) {
    it(`${label}: tries the Mac build, then Eco Mobile, then stops`, async () => {
      const tried: string[] = [];
      const result = await runSetupCascade({
        slot: 'eco-fast',
        profile: DESKTOP_SAFARI,
        recommend: (slot, profile) => recommend(slot, profile),
        nextInCascade,
        runAttempt: async (m) => {
          tried.push(m.id);
          return failure;
        },
        recordFailure: (m) => recordEvidence({ modelId: m.id, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' }),
        recordSuccess: () => undefined,
      });

      expect(result.kind).toBe('exhausted');
      expect([...new Set(tried)]).toEqual([MAC_MLC, MOBILE_MLC]);
    });
  }
});

describe('every other device class keeps the ladder it had', () => {
  const ARMS = {
    webgpu: { webgpuSupport: 'webgpu', webgpuShaderF16: true },
    webgpuUnprobed: { webgpuSupport: 'webgpu', webgpuShaderF16: undefined },
    webgpuNoF16: { webgpuSupport: 'webgpu', webgpuShaderF16: false },
    wasmOnly: { webgpuSupport: 'wasm-only', webgpuShaderF16: undefined },
    none: { webgpuSupport: 'none', webgpuShaderF16: undefined },
  } as const satisfies Record<string, Pick<DeviceProfile, 'webgpuSupport' | 'webgpuShaderF16'>>;
  const CLASSES = {
    iphone: { browserClass: 'safari', isMobile: true, deviceMemoryGB: 0 },
    desktopSafari: { browserClass: 'safari', isMobile: false, deviceMemoryGB: 0 },
    desktopChromium8: { browserClass: 'chromium', isMobile: false, deviceMemoryGB: 8 },
    mobileChromium8: { browserClass: 'chromium', isMobile: true, deviceMemoryGB: 8 },
    firefoxDesktop: { browserClass: 'firefox', isMobile: false, deviceMemoryGB: 0 },
    firefoxMobile: { browserClass: 'firefox', isMobile: true, deviceMemoryGB: 0 },
  } as const satisfies Record<string, Pick<DeviceProfile, 'browserClass' | 'isMobile' | 'deviceMemoryGB'>>;
  const CHANGED = new Set(['desktopSafari/webgpu', 'desktopSafari/webgpuUnprobed']);
  const ladders: Record<string, { fast: string[]; smart: string[]; catalog: string[] }> = recorded.ladders;

  for (const [className, cls] of Object.entries(CLASSES)) {
    for (const [armName, arm] of Object.entries(ARMS)) {
      const key = `${className}/${armName}`;
      if (CHANGED.has(key)) continue;
      it(key, () => {
        const profile: DeviceProfile = { ...cls, ...arm, override: 'auto' };
        expect({
          fast: listCandidates('eco-fast', profile).map((c) => c.model.id),
          smart: listCandidates('eco-smart', profile).map((c) => c.model.id),
          catalog: listCatalog(profile).available.map((a) => a.model.id),
        }).toEqual(ladders[key]);
      });
    }
  }
});
