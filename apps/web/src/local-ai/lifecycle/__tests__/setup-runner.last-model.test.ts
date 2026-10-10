// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * executeSetup after a device's model failed — the real catalog and ledger.
 *
 * A capable device whose model failed is never sent to the below-floor screen
 * (which, on iOS, tells the person to update iOS). Instead:
 *   - Try again (a click, `retryFailed`) attempts what can still run here;
 *   - a landing on the errored slot shows the exhausted error surface with Try
 *     again and attempts nothing, so a failed model is never reloaded without a
 *     click;
 *   - a multi-model device keeps today's behaviour: the failed model stays
 *     hidden and the landing goes straight on to the next rung.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSetup, type SetupRunnerOptions, type SetupSeams } from '../setup-runner';
import { SETUP_EXHAUSTED_REASON, type AttemptResult } from '../setup-cascade';
import { getModel } from '../../catalog/catalog';
import { getDeviceProfile } from '../../device/profile';
import { isBelowFloor } from '../../device/below-floor';
import { clearEvidence, recordEvidence } from '../../evidence/ledger';
import { nextInCascade } from '../../selection/cascade';
import { deriveFirstRunChoices } from '../../selection/first-run-choices';
import { recommend, starterModelForSlot } from '../../selection/recommend';
import type { DeviceProfile, ModelConfig, Slot } from '../../types';
import type { SlotState } from '../slots';

const MOBILE_MLC = 'candidate/qwen2.5-0.5b-mlc';
const MAC_MLC = 'candidate/qwen3-0.6b-mlc-q0f16';
const LFM_350M = 'candidate/lfm2.5-350m-onnx';
const EVERYDAY_12B = 'candidate/lfm2.5-1.2b-instruct-onnx';
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

const IPHONE: DeviceProfile = {
  browserClass: 'safari', webgpuSupport: 'webgpu', deviceMemoryGB: 0, isMobile: true, override: 'auto', webgpuShaderF16: true,
};
const DESKTOP_SAFARI: DeviceProfile = { ...IPHONE, isMobile: false };
const CHROMIUM: DeviceProfile = {
  browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 16, isMobile: false, override: 'auto', webgpuShaderF16: true,
};

/** As profile.ts builds an iPad: a desktop Mac user agent, told apart by touch. */
function iPadProfile(): DeviceProfile {
  const ua = navigator.userAgent;
  Object.defineProperty(navigator, 'userAgent', { value: MAC_SAFARI_UA, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
  try {
    return { ...getDeviceProfile(), webgpuSupport: 'webgpu', webgpuShaderF16: true };
  } finally {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
  }
}

const real = (id: string): ModelConfig => {
  const model = getModel(id);
  if (!model) throw new Error(`catalog lost ${id}`);
  return model;
};

const errored = (model: ModelConfig) =>
  ({ modelId: model.id, status: 'error', model } as unknown as SlotState);
const empty = { modelId: null, status: 'empty', model: null } as unknown as SlotState;

function fakeActions() {
  return {
    onProgressEvent: vi.fn(),
    setBelowFloor: vi.fn(),
    setReady: vi.fn(),
    setError: vi.fn(),
    markPriorAttemptFailed: vi.fn(),
    markFindingFit: vi.fn(),
    markResuming: vi.fn(),
  };
}

/** The real selection pipeline; only storage of the slot and the attempt are faked. */
function realSeams(
  profile: DeviceProfile,
  slots: Partial<Record<Slot, SlotState>>,
  runAttempt: (slot: Slot, model: ModelConfig) => Promise<AttemptResult>,
) {
  const seams = {
    bootstrap: vi.fn(async () => {}),
    resolveProfile: vi.fn(async () => profile),
    isBelowFloor,
    getSlot: vi.fn((slot: Slot) => slots[slot] ?? empty),
    setSlot: vi.fn(),
    setSlotStatus: vi.fn(),
    recommend,
    nextInCascade,
    recordEvidence,
    runAttempt: vi.fn(runAttempt),
    starterModelForSlot: (slot: Slot, p: DeviceProfile) => starterModelForSlot(slot, p),
    deriveFirstRunChoices,
    isModelCached: vi.fn(async () => false),
    waitForNetwork: vi.fn(async () => false),
    getModel,
  } satisfies Partial<SetupSeams>;
  return seams;
}

const attempted = (seams: ReturnType<typeof realSeams>): string[] =>
  seams.runAttempt.mock.calls.map(([, model]) => model.id);

const passes = async (): Promise<AttemptResult> => ({ ok: true });
const smokeFails = async (): Promise<AttemptResult> => ({ ok: false, phase: 'load-or-smoke', reason: 'smoke failed' });

/** Try again on the setup screen: a click, so a failed model may be retried. */
const tryAgain = (seams: ReturnType<typeof realSeams>) =>
  ({ slot: 'eco-fast', seams, retryFailed: true }) as SetupRunnerOptions;
/** A landing: setup starts on its own. */
const landing = (seams: ReturnType<typeof realSeams>): SetupRunnerOptions => ({ slot: 'eco-fast', seams });

beforeEach(() => {
  localStorage.clear();
  clearEvidence();
});

describe('one-model devices after their model failed once', () => {
  for (const [label, profileOf] of [
    ['an iPhone', () => IPHONE],
    ['an iPad', iPadProfile],
  ] as const) {
    it(`${label}: Try again attempts the model again, never the below-floor screen`, async () => {
      const profile = profileOf();
      recordEvidence({ modelId: MOBILE_MLC, profile, outcome: 'smoke-fail' });
      const a = fakeActions();
      const s = realSeams(profile, { 'eco-fast': errored(real(MOBILE_MLC)) }, passes);

      await executeSetup(a, tryAgain(s));

      expect(a.setBelowFloor).not.toHaveBeenCalled();
      expect(attempted(s)).toEqual([MOBILE_MLC]);
      expect(a.setReady).toHaveBeenCalledWith(expect.objectContaining({ id: MOBILE_MLC }));
    });

    it(`${label}: a landing shows the exhausted error with Try again, and loads nothing`, async () => {
      const profile = profileOf();
      recordEvidence({ modelId: MOBILE_MLC, profile, outcome: 'smoke-fail' });
      const a = fakeActions();
      const s = realSeams(profile, { 'eco-fast': errored(real(MOBILE_MLC)) }, passes);

      await executeSetup(a, landing(s));

      // The below-floor screen (iOS reason: "update iOS") is for devices that
      // cannot run any model; this one can.
      expect(a.setBelowFloor).not.toHaveBeenCalled();
      expect(s.runAttempt).not.toHaveBeenCalled();
      expect(a.setError).toHaveBeenCalledWith(
        SETUP_EXHAUSTED_REASON,
        expect.objectContaining({ exhausted: true, triedModelCount: 1 }),
      );
    });
  }
});

describe('desktop Safari after both MLC rungs failed once', () => {
  it('a landing goes on to the 350M, no click needed', async () => {
    recordEvidence({ modelId: MAC_MLC, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });
    recordEvidence({ modelId: MOBILE_MLC, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });
    const a = fakeActions();
    const s = realSeams(DESKTOP_SAFARI, { 'eco-fast': errored(real(MOBILE_MLC)) }, passes);

    await executeSetup(a, landing(s));

    expect(a.setBelowFloor).not.toHaveBeenCalled();
    expect(a.setError).not.toHaveBeenCalled();
    expect(attempted(s)).toEqual([LFM_350M]);
    expect(a.setReady).toHaveBeenCalledWith(expect.objectContaining({ id: LFM_350M }));
  });
});

describe('desktop Safari after all three rungs failed once', () => {
  it('Try again attempts the Mac build, then Eco Mobile', async () => {
    recordEvidence({ modelId: MAC_MLC, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });
    recordEvidence({ modelId: MOBILE_MLC, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });
    recordEvidence({ modelId: LFM_350M, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });
    const a = fakeActions();
    const s = realSeams(
      DESKTOP_SAFARI,
      { 'eco-fast': errored(real(MOBILE_MLC)) },
      async (_slot, model) => (model.id === MAC_MLC ? smokeFails() : passes()),
    );

    await executeSetup(a, tryAgain(s));

    expect(a.setBelowFloor).not.toHaveBeenCalled();
    expect(attempted(s)).toEqual([MAC_MLC, MOBILE_MLC]);
    expect(a.setReady).toHaveBeenCalledWith(expect.objectContaining({ id: MOBILE_MLC }));
  });

  it('a landing shows the exhausted error over all three rungs, and loads nothing', async () => {
    recordEvidence({ modelId: MAC_MLC, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });
    recordEvidence({ modelId: MOBILE_MLC, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });
    recordEvidence({ modelId: LFM_350M, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });
    const a = fakeActions();
    const s = realSeams(DESKTOP_SAFARI, { 'eco-fast': errored(real(MOBILE_MLC)) }, passes);

    await executeSetup(a, landing(s));

    expect(a.setBelowFloor).not.toHaveBeenCalled();
    expect(s.runAttempt).not.toHaveBeenCalled();
    expect(a.setError).toHaveBeenCalledWith(
      SETUP_EXHAUSTED_REASON,
      expect.objectContaining({ exhausted: true, triedModelCount: 3 }),
    );
  });
});

describe('a multi-model device keeps today\'s behaviour', () => {
  it('Chromium: a landing after the everyday model failed goes on to the next rung, no click needed', async () => {
    recordEvidence({ modelId: EVERYDAY_12B, profile: CHROMIUM, outcome: 'smoke-fail' });
    const a = fakeActions();
    const s = realSeams(CHROMIUM, { 'eco-fast': errored(real(EVERYDAY_12B)) }, passes);

    await executeSetup(a, landing(s));

    expect(a.setBelowFloor).not.toHaveBeenCalled();
    expect(a.setError).not.toHaveBeenCalled();
    expect(attempted(s).length).toBeGreaterThan(0);
    expect(attempted(s)).not.toContain(EVERYDAY_12B);
  });
});
