// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { executeSetup } from '../setup-runner';
import type {
  FirstRunChoiceEntry,
  FirstRunChoiceOffer,
} from '../../selection/first-run-choices';
import type { ModelConfig, DeviceProfile } from '../../types';
import type { SlotState } from '../slots';

// First-run model choice: when the runner is given a `requestChoice` bridge and
// the slot is genuinely fresh, it offers the user a choice and downloads exactly
// what they pick — never a starter-first downgrade — and never re-shows the card
// on returning / resuming / retrying devices.

const PROFILE = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 16,
  isMobile: false,
  override: 'auto',
} as DeviceProfile;

const model = (id: string) => ({ id, sizeGB: 1 } as ModelConfig);
const emptySlot = { modelId: null, status: 'empty', model: null } as unknown as SlotState;

const OFFER: FirstRunChoiceOffer = {
  choices: [
    { model: model('fast'), slot: 'eco-fast' },
    { model: model('deeper'), slot: 'eco-smart' },
  ],
  recommendedId: 'deeper',
};

/** The user tapping a tile: resolve with that tile's whole entry. */
const pick = (id: string) => async (offer: FirstRunChoiceOffer): Promise<FirstRunChoiceEntry> =>
  offer.choices.find((c) => c.model.id === id)!;

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
    // The class-best auto-recommendation — a DIFFERENT model than the user's
    // pick, so a test can prove the choice won out over auto-recommend.
    recommend: vi.fn(() => model('fast')),
    nextInCascade: vi.fn(() => null),
    recordEvidence: vi.fn(),
    runAttempt: vi.fn(async () => ({ ok: true as const })),
    // A non-null starter that, if starter-first ran, would be bound instead of
    // the user's pick — so asserting it's untouched proves the bypass.
    starterModelForSlot: vi.fn(() => model('starter')),
    deriveFirstRunChoices: vi.fn(() => OFFER),
    isModelCached: vi.fn(async () => false),
    ...over,
  };
}

describe('executeSetup — first-run model choice', () => {
  it('downloads and binds exactly the chosen model, into the slot it was offered for', async () => {
    const a = fakeActions();
    const s = seams();
    // The user taps "Eco Deeper" — offered for eco-smart.
    const requestChoice = vi.fn(pick('deeper'));

    await executeSetup(a, { slot: 'eco-fast', seams: s, requestChoice });

    // The offer was derived and presented once.
    expect(s.deriveFirstRunChoices).toHaveBeenCalledWith('eco-fast', PROFILE);
    expect(requestChoice).toHaveBeenCalledTimes(1);
    expect(requestChoice).toHaveBeenCalledWith(OFFER);

    // The chosen model is what gets bound and readied — not the auto-recommend
    // pick ('fast') and not the starter ('starter') — and it binds ECO-SMART,
    // the slot the tile was offered for. Writing it into eco-fast was the bug:
    // the deeper pick landed in the everyday slot and eco-smart stayed empty.
    expect(s.setSlot).toHaveBeenCalledWith('eco-smart', model('deeper'));
    expect(s.setSlot).not.toHaveBeenCalledWith('eco-fast', model('deeper'));
    expect(a.setReady).toHaveBeenCalledWith(model('deeper'));
    expect(s.setSlotStatus).toHaveBeenCalledWith('eco-smart', 'ready');
    expect(s.setSlotStatus).not.toHaveBeenCalledWith('eco-fast', 'ready');

    // Starter-first is fully bypassed for an explicit choice: neither the cache
    // probe nor the starter lookup runs.
    expect(s.isModelCached).not.toHaveBeenCalled();
    expect(s.starterModelForSlot).not.toHaveBeenCalled();
  });

  it('binds the everyday pick to the slot being set up', async () => {
    const a = fakeActions();
    const s = seams();
    const requestChoice = vi.fn(pick('fast'));

    await executeSetup(a, { slot: 'eco-fast', seams: s, requestChoice });

    expect(s.setSlot).toHaveBeenCalledWith('eco-fast', model('fast'));
    expect(s.setSlot).not.toHaveBeenCalledWith('eco-smart', model('fast'));
    expect(s.setSlotStatus).toHaveBeenCalledWith('eco-fast', 'ready');
  });

  it('demotes a failed deeper pick onto eco-fast and releases the slot it abandoned', async () => {
    const a = fakeActions();
    const s = seams({
      // The chosen deeper model fails; the ladder finds something smaller.
      runAttempt: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, phase: 'load-or-smoke', reason: 'nope' })
        .mockResolvedValue({ ok: true }),
      nextInCascade: vi.fn(() => model('smaller')),
    });
    const requestChoice = vi.fn(pick('deeper'));

    await executeSetup(a, { slot: 'eco-fast', seams: s, requestChoice });

    // A fallback is never the "strongest model for this device": it binds the
    // slot being set up...
    expect(s.setSlot).toHaveBeenCalledWith('eco-fast', model('smaller'));
    // ...and the abandoned deeper pick is released rather than left 'preparing'
    // forever on a download that will never arrive.
    expect(s.setSlot).toHaveBeenCalledWith('eco-smart', null);
    expect(a.markFindingFit).toHaveBeenCalled();
    expect(s.setSlotStatus).toHaveBeenCalledWith('eco-fast', 'ready');
    expect(s.setSlotStatus).not.toHaveBeenCalledWith('eco-smart', 'ready');
  });

  it('does NOT offer a choice when the slot already holds a ready model (returning user)', async () => {
    const a = fakeActions();
    const readySlot = { modelId: 'x', status: 'ready', model: model('x') } as unknown as SlotState;
    const s = seams({ getSlot: vi.fn(() => readySlot) });
    const requestChoice = vi.fn(pick('deeper'));

    await executeSetup(a, { slot: 'eco-fast', seams: s, requestChoice });

    expect(requestChoice).not.toHaveBeenCalled();
    expect(s.deriveFirstRunChoices).not.toHaveBeenCalled();
    expect(a.setReady).toHaveBeenCalledWith(model('x'));
  });

  it('does NOT offer a choice when resuming an interrupted download', async () => {
    const a = fakeActions();
    const preparingSlot = { modelId: 'bound', status: 'preparing', model: model('bound') } as unknown as SlotState;
    const s = seams({ getSlot: vi.fn(() => preparingSlot) });
    const requestChoice = vi.fn(pick('deeper'));

    await executeSetup(a, { slot: 'eco-fast', seams: s, requestChoice });

    expect(requestChoice).not.toHaveBeenCalled();
    expect(a.markResuming).toHaveBeenCalled();
    // Resumes the exact bound model, not a fresh choice.
    expect(a.setReady).toHaveBeenCalledWith(model('bound'));
  });

  it('does NOT offer a choice on a prior-error slot (retry auto-recommends)', async () => {
    const a = fakeActions();
    const errorSlot = { modelId: 'a', status: 'error', model: model('a') } as unknown as SlotState;
    const s = seams({ getSlot: vi.fn(() => errorSlot) });
    const requestChoice = vi.fn(pick('deeper'));

    await executeSetup(a, { slot: 'eco-fast', seams: s, requestChoice });

    expect(requestChoice).not.toHaveBeenCalled();
    expect(a.markPriorAttemptFailed).toHaveBeenCalled();
    // Falls through to the normal auto-recommend ladder (starter-first here),
    // not the choice card — retry re-attempts, it does not re-prompt.
    expect(a.setReady).toHaveBeenCalledWith(model('starter'));
  });

  it('auto-recommends as before when no choice bridge is wired', async () => {
    const a = fakeActions();
    const s = seams();

    await executeSetup(a, { slot: 'eco-fast', seams: s }); // no requestChoice

    expect(s.deriveFirstRunChoices).not.toHaveBeenCalled();
    // With starterModelForSlot returning a model and the class-best uncached,
    // starter-first is free to run — proving the choice path is what suppresses it.
    expect(a.setReady).toHaveBeenCalledWith(model('starter'));
  });
});
