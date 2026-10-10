// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Failure evidence never empties a slot.
 *
 * A recent failure hides a model from auto-offer (30 days for a smoke or
 * generate failure, 7 days after two download failures) only while another
 * model can still serve the slot. When hiding it would leave nothing, the
 * evidence is set aside and the slot's ladder runs in its normal order — so a
 * device whose one model failed once is offered that model again rather than
 * declined as if it could run nothing. The rule reads no device class: a
 * one-model ladder (iPhone, iPad, f16-less Safari) and desktop Safari's
 * three-model eco-fast ladder reach it the same way, and a multi-model ladder
 * keeps hiding a failed model while another rung serves.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearEvidence, recordEvidence } from '../../evidence/ledger';
import { getModel } from '../../catalog/catalog';
import { nextInCascade } from '../cascade';
import { listCandidates, recommend, starterModelForSlot } from '../recommend';
import type { DeviceProfile } from '../../types';

const MOBILE_MLC = 'candidate/qwen2.5-0.5b-mlc';
const MAC_MLC = 'candidate/qwen3-0.6b-mlc-q0f16';
const LFM_350M = 'candidate/lfm2.5-350m-onnx';
const EVERYDAY_12B = 'candidate/lfm2.5-1.2b-instruct-onnx';

const IPHONE: DeviceProfile = {
  browserClass: 'safari', webgpuSupport: 'webgpu', deviceMemoryGB: 0, isMobile: true, override: 'auto', webgpuShaderF16: true,
};
const DESKTOP_SAFARI: DeviceProfile = { ...IPHONE, isMobile: false };
const SAFARI_NO_F16: DeviceProfile = { ...DESKTOP_SAFARI, webgpuShaderF16: false };
const CHROMIUM: DeviceProfile = {
  browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 16, isMobile: false, override: 'auto', webgpuShaderF16: true,
};

function fail(modelId: string, profile: DeviceProfile, outcome: 'smoke-fail' | 'download-fail', times = 1): void {
  for (let i = 0; i < times; i++) recordEvidence({ modelId, profile, outcome });
}

const ids = (slot: 'eco-fast' | 'eco-smart', profile: DeviceProfile) =>
  listCandidates(slot, profile).map((c) => c.model.id);

beforeEach(() => {
  localStorage.clear();
  clearEvidence();
});

describe('a one-model ladder is never emptied by its own failure', () => {
  it('an iPhone whose model smoke-failed once is still offered it, for both slots and the starter', () => {
    fail(MOBILE_MLC, IPHONE, 'smoke-fail');
    expect(recommend('eco-fast', IPHONE).id).toBe(MOBILE_MLC);
    expect(recommend('eco-smart', IPHONE).id).toBe(MOBILE_MLC);
    expect(starterModelForSlot('eco-fast', IPHONE)?.id).toBe(MOBILE_MLC);
  });

  it('an iPhone whose model failed to download twice is still offered it', () => {
    fail(MOBILE_MLC, IPHONE, 'download-fail', 2);
    expect(recommend('eco-fast', IPHONE).id).toBe(MOBILE_MLC);
  });

  it('f16-less Safari keeps its one model (the 350M) after it smoke-failed or failed to download', () => {
    fail(LFM_350M, SAFARI_NO_F16, 'smoke-fail');
    expect(recommend('eco-fast', SAFARI_NO_F16).id).toBe(LFM_350M);
    clearEvidence();
    fail(LFM_350M, SAFARI_NO_F16, 'download-fail', 3);
    expect(recommend('eco-fast', SAFARI_NO_F16).id).toBe(LFM_350M);
  });
});

describe('desktop Safari: three eco-fast rungs', () => {
  it('after all three rungs smoke-failed, the ladder is offered again in its normal order', () => {
    fail(MAC_MLC, DESKTOP_SAFARI, 'smoke-fail');
    fail(MOBILE_MLC, DESKTOP_SAFARI, 'smoke-fail');
    fail(LFM_350M, DESKTOP_SAFARI, 'smoke-fail');
    expect(ids('eco-fast', DESKTOP_SAFARI)).toEqual([MAC_MLC, MOBILE_MLC, LFM_350M]);
    expect(recommend('eco-fast', DESKTOP_SAFARI).id).toBe(MAC_MLC);
  });

  // The 7-day download demotion on the last rung (the Safari-ladder PR's R-a).
  it('after all three rungs failed to download twice, the ladder is offered again', () => {
    fail(MAC_MLC, DESKTOP_SAFARI, 'download-fail', 2);
    fail(MOBILE_MLC, DESKTOP_SAFARI, 'download-fail', 2);
    fail(LFM_350M, DESKTOP_SAFARI, 'download-fail', 2);
    expect(recommend('eco-fast', DESKTOP_SAFARI).id).toBe(MAC_MLC);
  });

  it('while a rung is clean, the failed ones stay hidden', () => {
    fail(MOBILE_MLC, DESKTOP_SAFARI, 'download-fail', 2);
    expect(ids('eco-fast', DESKTOP_SAFARI)).toEqual([MAC_MLC, LFM_350M]);
    clearEvidence();
    fail(MAC_MLC, DESKTOP_SAFARI, 'smoke-fail');
    fail(MOBILE_MLC, DESKTOP_SAFARI, 'smoke-fail');
    expect(ids('eco-fast', DESKTOP_SAFARI)).toEqual([LFM_350M]);
  });

  it('the step after the Mac build skips an Eco Mobile that failed earlier while the 350M is clean', () => {
    fail(MOBILE_MLC, DESKTOP_SAFARI, 'smoke-fail');
    expect(nextInCascade(getModel(MAC_MLC)!, 'eco-fast', DESKTOP_SAFARI)?.id).toBe(LFM_350M);
  });

  // The rule is judged after a cascade's own exclusions: with the Mac build
  // being stepped away from and both later rungs failed, the ladder's order
  // decides.
  it('the step after the Mac build is Eco Mobile when Eco Mobile and the 350M both failed earlier', () => {
    fail(MOBILE_MLC, DESKTOP_SAFARI, 'smoke-fail');
    fail(LFM_350M, DESKTOP_SAFARI, 'smoke-fail');
    expect(nextInCascade(getModel(MAC_MLC)!, 'eco-fast', DESKTOP_SAFARI)?.id).toBe(MOBILE_MLC);
  });

  it('a cascade still ends: after the 350M with both MLC builds excluded, there is nothing', () => {
    fail(MAC_MLC, DESKTOP_SAFARI, 'smoke-fail');
    fail(MOBILE_MLC, DESKTOP_SAFARI, 'smoke-fail');
    fail(LFM_350M, DESKTOP_SAFARI, 'smoke-fail');
    expect(nextInCascade(getModel(LFM_350M)!, 'eco-fast', DESKTOP_SAFARI, undefined, {
      excludeIds: [MAC_MLC, MOBILE_MLC],
    })).toBeNull();
  });

  it('an iPhone cascade ends after its one model: no loop back onto it', () => {
    fail(MOBILE_MLC, IPHONE, 'smoke-fail');
    expect(nextInCascade(getModel(MOBILE_MLC)!, 'eco-fast', IPHONE)).toBeNull();
  });
});

describe('a multi-model ladder keeps hiding a failed model while another rung serves', () => {
  it('Chromium: one smoke failure of the everyday model hides it for 30 days', () => {
    fail(EVERYDAY_12B, CHROMIUM, 'smoke-fail');
    expect(ids('eco-fast', CHROMIUM)).not.toContain(EVERYDAY_12B);
    expect(recommend('eco-fast', CHROMIUM).id).not.toBe(EVERYDAY_12B);
  });

  it('Chromium: two download failures demote the everyday model for 7 days', () => {
    fail(EVERYDAY_12B, CHROMIUM, 'download-fail', 2);
    expect(ids('eco-fast', CHROMIUM)).not.toContain(EVERYDAY_12B);
  });
});
