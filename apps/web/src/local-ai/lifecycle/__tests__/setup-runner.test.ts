// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { executeSetup } from '../setup-runner';
import { NoAssignableModelError } from '../../selection/recommend';
import type { ModelConfig, DeviceProfile } from '../../types';
import type { SlotState } from '../slots';

const PROFILE = { browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 16, isMobile: false, override: 'auto' } as DeviceProfile;
const model = (id: string) => ({ id } as ModelConfig);
const emptySlot = { modelId: null, status: 'empty', model: null } as unknown as SlotState;

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

function seams(over = {}) {
  return {
    bootstrap: vi.fn(async () => {}),
    resolveProfile: vi.fn(async () => PROFILE),
    isBelowFloor: vi.fn(() => false),
    getSlot: vi.fn(() => emptySlot),
    setSlot: vi.fn(),
    setSlotStatus: vi.fn(),
    recommend: vi.fn(() => model('a')),
    nextInCascade: vi.fn(() => model('b')),
    recordEvidence: vi.fn(),
    runAttempt: vi.fn(async () => ({ ok: true as const })),
    // Starter-first Stage A is default-on; a null starter falls back to the
    // class-best pick, so the cascade-path tests above keep exercising the
    // recommend() pick directly. Starter policy has its own describe block.
    starterModelForSlot: vi.fn(() => null),
    isModelCached: vi.fn(async () => false),
    ...over,
  };
}

describe('executeSetup', () => {
  it('reaches ready on first-pick success and records a pass', async () => {
    const a = fakeActions(); const s = seams();
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.setReady).toHaveBeenCalledWith(model('a'));
    expect(s.setSlotStatus).toHaveBeenCalledWith('eco-fast', 'ready');
    expect(s.recordEvidence).toHaveBeenCalledWith({ modelId: 'a', profile: PROFILE, outcome: 'smoke-pass' });
  });

  it('routes below-floor devices to the below-floor surface', async () => {
    const a = fakeActions(); const s = seams({ isBelowFloor: vi.fn(() => true) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.setBelowFloor).toHaveBeenCalled();
    expect(s.runAttempt).not.toHaveBeenCalled();
  });

  it('demotes, records a smoke-fail, marks finding-fit, then succeeds', async () => {
    let calls = 0;
    const a = fakeActions();
    const s = seams({
      runAttempt: vi.fn(async () => (++calls === 1
        ? { ok: false as const, phase: 'load-or-smoke' as const, reason: 'OOM' }
        : { ok: true as const })),
    });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(s.recordEvidence).toHaveBeenCalledWith({ modelId: 'a', profile: PROFILE, outcome: 'smoke-fail' });
    expect(a.markFindingFit).toHaveBeenCalled();
    expect(a.setReady).toHaveBeenCalledWith(model('b'));
  });

  it('sets an exhausted error when the ladder is spent', async () => {
    const a = fakeActions();
    const s = seams({
      runAttempt: vi.fn(async () => ({ ok: false as const, phase: 'load-or-smoke' as const, reason: 'x' })),
      nextInCascade: vi.fn(() => null),
    });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    // The count is threaded so the error surface can be honest about how many
    // models were actually attempted (one here — nextInCascade returns null).
    expect(a.setError).toHaveBeenCalledWith(expect.any(String), {
      exhausted: true,
      triedModelCount: 1,
    });
    expect(s.setSlotStatus).toHaveBeenCalledWith('eco-fast', 'error');
  });

  it('surfaces a prior-session error slot', async () => {
    const a = fakeActions();
    const s = seams({ getSlot: vi.fn(() => ({ modelId: 'a', status: 'error', model: null } as unknown as SlotState)) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.markPriorAttemptFailed).toHaveBeenCalled();
  });

  // Regression for final-review I1: the below-floor gate must use the
  // adapter-PROBED profile, not re-derive the optimistic sync profile. This
  // test deliberately does NOT override the isBelowFloor seam, so executeSetup
  // exercises the REAL default seam against the probed profile. With the buggy
  // `../index` import (a zero-arg wrapper that ignores its argument), the
  // decision falls back to the jsdom-ambient profile (webgpuSupport
  // 'wasm-only', not below floor) → setBelowFloor is skipped and recommend is
  // called, failing this test. With the profile-aware `../device/below-floor`
  // import, the probed 'none' + low-memory profile is below floor.
  it('routes a below-floor PROBED profile to the below-floor surface via the real isBelowFloor (final-review I1)', async () => {
    const a = fakeActions();
    const belowFloorProfile = {
      browserClass: 'chromium',
      webgpuSupport: 'none',
      deviceMemoryGB: 2,
      isMobile: false,
      override: 'auto',
    } as DeviceProfile;
    // isBelowFloor intentionally omitted → executeSetup uses the real default seam.
    const s = {
      bootstrap: vi.fn(async () => {}),
      resolveProfile: vi.fn(async () => belowFloorProfile),
      getSlot: vi.fn(() => emptySlot),
      setSlot: vi.fn(),
      setSlotStatus: vi.fn(),
      recommend: vi.fn(() => model('a')),
      nextInCascade: vi.fn(() => model('b')),
      recordEvidence: vi.fn(),
      runAttempt: vi.fn(async () => ({ ok: true as const })),
    };
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.setBelowFloor).toHaveBeenCalled();
    expect(s.recommend).not.toHaveBeenCalled();
    expect(s.runAttempt).not.toHaveBeenCalled();
    expect(a.setError).not.toHaveBeenCalled();
  });

  // When NO model can run on this device at all (not just the low-memory
  // below-floor subset), recommend() throws NoAssignableModelError. That must
  // route to the honest below-floor surface, NOT a retry-promising error the
  // user can never get past.
  it('routes NoAssignableModelError to the below-floor surface, not a retry-promising error', async () => {
    const a = fakeActions();
    const s = seams({
      isBelowFloor: vi.fn(() => false),
      recommend: vi.fn(() => {
        throw new NoAssignableModelError('eco-fast', PROFILE);
      }),
    });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.setBelowFloor).toHaveBeenCalled();
    expect(a.setError).not.toHaveBeenCalled();
    expect(s.runAttempt).not.toHaveBeenCalled();
  });
});

describe('executeSetup — resume a bound preparing pick (phantom-pick fix)', () => {
  const preparingSlot = (modelId: string, model: ModelConfig | null) =>
    ({ modelId, status: 'preparing', model } as unknown as SlotState);

  it('resumes the bound preparing model verbatim — recommend/starter seams not consulted', async () => {
    const a = fakeActions();
    const resumeModel = model('resume-me');
    const s = seams({ getSlot: vi.fn(() => preparingSlot('resume-me', resumeModel)) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.markResuming).toHaveBeenCalled();
    expect(s.runAttempt).toHaveBeenNthCalledWith(1, 'eco-fast', resumeModel, expect.any(Function));
    expect(s.recommend).not.toHaveBeenCalled();
    expect(s.starterModelForSlot).not.toHaveBeenCalled();
    expect(s.isModelCached).not.toHaveBeenCalled();
    expect(a.setReady).toHaveBeenCalledWith(resumeModel);
  });

  it('a resumed model that fails demotes through the cascade', async () => {
    let calls = 0;
    const a = fakeActions();
    const resumeModel = model('resume-me');
    const s = seams({
      getSlot: vi.fn(() => preparingSlot('resume-me', resumeModel)),
      runAttempt: vi.fn(async () => (++calls === 1
        ? { ok: false as const, phase: 'load-or-smoke' as const, reason: 'OOM' }
        : { ok: true as const })),
      nextInCascade: vi.fn(() => model('b')),
    });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(s.recordEvidence).toHaveBeenCalledWith({ modelId: 'resume-me', profile: PROFILE, outcome: 'smoke-fail' });
    expect(a.setReady).toHaveBeenCalledWith(model('b'));
  });

  it('a preparing pick whose id no longer resolves falls through to a fresh recommendation', async () => {
    const a = fakeActions();
    const s = seams({ getSlot: vi.fn(() => preparingSlot('gone/from-catalog', null)) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.markResuming).not.toHaveBeenCalled();
    expect(s.recommend).toHaveBeenCalled();
    expect(a.setReady).toHaveBeenCalledWith(model('a'));
  });

  it('a ready slot short-circuits to setReady without resuming', async () => {
    const a = fakeActions();
    const ready = model('ready-model');
    const s = seams({ getSlot: vi.fn(() => ({ modelId: 'ready-model', status: 'ready', model: ready } as unknown as SlotState)) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.setReady).toHaveBeenCalledWith(ready);
    expect(a.markResuming).not.toHaveBeenCalled();
    expect(s.runAttempt).not.toHaveBeenCalled();
  });
});

describe('executeSetup — starter-first Stage A (instant-start slice 2b)', () => {
  const starterSeams = (over = {}) => seams({
    recommend: vi.fn(() => model('class-best')),
    starterModelForSlot: vi.fn(() => model('starter')),
    isModelCached: vi.fn(async () => false),
    ...over,
  });

  it('leads with the starter when the class-best is not cached', async () => {
    const a = fakeActions(); const s = starterSeams();
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(s.runAttempt).toHaveBeenCalledTimes(1);
    expect(s.runAttempt).toHaveBeenNthCalledWith(1, 'eco-fast', model('starter'), expect.any(Function));
    expect(a.setReady).toHaveBeenCalledWith(model('starter'));
    expect(s.setSlotStatus).toHaveBeenCalledWith('eco-fast', 'ready');
  });

  it('returning-user fast path: a fully-cached class-best keeps the top pick (never downgrade)', async () => {
    const a = fakeActions();
    const s = starterSeams({ isModelCached: vi.fn(async () => true) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(s.runAttempt).toHaveBeenNthCalledWith(1, 'eco-fast', model('class-best'), expect.any(Function));
    expect(a.setReady).toHaveBeenCalledWith(model('class-best'));
    expect(s.starterModelForSlot).not.toHaveBeenCalled();
  });

  it('convergence no-op: starter === class-best runs once, no special-casing', async () => {
    const a = fakeActions();
    const s = starterSeams({ starterModelForSlot: vi.fn(() => model('class-best')) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(s.runAttempt).toHaveBeenCalledTimes(1);
    expect(a.setReady).toHaveBeenCalledWith(model('class-best'));
  });

  it('a null starter falls back to the class-best pick', async () => {
    const a = fakeActions();
    const s = starterSeams({ starterModelForSlot: vi.fn(() => null) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.setReady).toHaveBeenCalledWith(model('class-best'));
  });

  it('a cache-probe failure falls back to the starter (fails toward the fast path)', async () => {
    const a = fakeActions();
    const s = starterSeams({ isModelCached: vi.fn(async () => { throw new Error('storage'); }) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.setReady).toHaveBeenCalledWith(model('starter'));
  });

  it('starterFirst: false restores the class-best-first pipeline (rollback lever)', async () => {
    const a = fakeActions(); const s = starterSeams();
    await executeSetup(a, { slot: 'eco-fast', starterFirst: false, seams: s });
    expect(s.runAttempt).toHaveBeenNthCalledWith(1, 'eco-fast', model('class-best'), expect.any(Function));
    expect(s.starterModelForSlot).not.toHaveBeenCalled();
    expect(s.isModelCached).not.toHaveBeenCalled();
  });

  it('a starter failure walks the normal cascade ladder', async () => {
    let calls = 0;
    const a = fakeActions();
    const s = starterSeams({
      runAttempt: vi.fn(async () => (++calls === 1
        ? { ok: false as const, phase: 'load-or-smoke' as const, reason: 'OOM' }
        : { ok: true as const })),
      nextInCascade: vi.fn(() => model('class-best')),
    });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(s.recordEvidence).toHaveBeenCalledWith({ modelId: 'starter', profile: PROFILE, outcome: 'smoke-fail' });
    expect(a.setReady).toHaveBeenCalledWith(model('class-best'));
  });
});
