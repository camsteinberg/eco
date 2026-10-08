// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * executeSetup × the load breaker — what a landing does after a tab died
 * loading a model.
 *
 * Seeds localStorage exactly as a killed tab leaves it (a load mark from a tab
 * that is gone; jsdom has no Web Locks, so any other tab's mark reads as dead)
 * and asserts the runner never loads that model again on its own.
 *
 * Contract pinned here:
 *   - one kill → ask (Try again, plus a lighter model or the previous model
 *     when there is one); the slot keeps its binding and status;
 *   - two kills in a row → step down to a smaller rung with the demotion
 *     notice, or, with nowhere smaller to go, an honest stop — never the
 *     below-floor screen;
 *   - the person's answer is honoured exactly once per click.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSetup } from '../setup-runner';
import type { DeviceProfile, ModelConfig, Slot } from '../../types';
import type { SlotState } from '../slots';

const MARK_KEY = 'eco-local-ai-load-mark-v1';
const KILLS_KEY = 'eco-local-ai-load-kills-v1';

const PROFILE = { browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 16, isMobile: false, override: 'auto' } as DeviceProfile;
const BIG = { id: 'local/big', friendlyName: 'Eco Big (Vendor)', sizeGB: 1.2 } as ModelConfig;
const SMALL = { id: 'local/small', friendlyName: 'Eco Small', sizeGB: 0.5 } as ModelConfig;
const LARGER = { id: 'local/larger', friendlyName: 'Eco Larger', sizeGB: 2.4 } as ModelConfig;
const PREVIOUS = { id: 'local/prev', friendlyName: 'Eco Previous', sizeGB: 0.8 } as ModelConfig;

const empty = { modelId: null, status: 'empty', model: null } as unknown as SlotState;
const bound = (model: ModelConfig, status: 'preparing' | 'ready') =>
  ({ modelId: model.id, status, model } as unknown as SlotState);

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

function seams(slots: Partial<Record<Slot, SlotState>>, over = {}) {
  return {
    bootstrap: vi.fn(async () => {}),
    resolveProfile: vi.fn(async () => PROFILE),
    isBelowFloor: vi.fn(() => false),
    getSlot: vi.fn((slot: Slot) => slots[slot] ?? empty),
    setSlot: vi.fn(),
    setSlotStatus: vi.fn(),
    recommend: vi.fn(() => BIG),
    nextInCascade: vi.fn(() => SMALL),
    recordEvidence: vi.fn(),
    runAttempt: vi.fn(async () => ({ ok: true as const })),
    starterModelForSlot: vi.fn(() => null),
    isModelCached: vi.fn(async () => false),
    getModel: vi.fn((id: string) => (id === PREVIOUS.id ? PREVIOUS : null)),
    ...over,
  };
}

function seedDeadMark(modelId: string, loadId = 'dead-load', rollbackModelId?: string): void {
  const mark = {
    tabId: 'dead-tab', loadId, modelId, startedAt: 1,
    ...(rollbackModelId ? { rollbackModelId } : {}),
  };
  localStorage.setItem(MARK_KEY, JSON.stringify({ [loadId]: mark }));
}

function seedKillRecord(
  modelId: string,
  decision: 'ask' | 'retry' | 'step-down' | 'roll-back',
  extra: Record<string, unknown> = {},
): void {
  localStorage.setItem(KILLS_KEY, JSON.stringify({
    [modelId]: {
      modelId, kills: 1, lastLoadId: 'old-load', lastKilledAt: 1, reason: 'no-lock', decision, ...extra,
    },
  }));
}

const loadInterruptedError = (info: Record<string, unknown>) => [
  expect.any(String),
  expect.objectContaining({
    reasonCode: 'load-interrupted',
    loadInterrupted: expect.objectContaining(info) as unknown,
  }),
];

beforeEach(() => {
  localStorage.clear();
});

describe('executeSetup — one kill asks instead of loading again', () => {
  it('does not resume a preparing model whose load killed the last tab', async () => {
    seedDeadMark(BIG.id);
    const a = fakeActions();
    const s = seams({ 'eco-fast': bound(BIG, 'preparing') });

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    expect(s.runAttempt).not.toHaveBeenCalled();
    expect(a.setError).toHaveBeenCalledWith(...loadInterruptedError({
      modelName: 'Eco Big',
      alternative: { kind: 'lighter', modelName: 'Eco Small' },
    }));
    // The binding and status are left as they were, so Try again resumes the
    // same model rather than re-entering recommend (and its 30-day verdicts).
    expect(s.setSlotStatus).not.toHaveBeenCalled();
    expect(s.setSlot).not.toHaveBeenCalled();
    expect(a.setBelowFloor).not.toHaveBeenCalled();
  });

  it('does not pass a ready slot through to the warm-up', async () => {
    seedDeadMark(BIG.id);
    const a = fakeActions();
    const s = seams({ 'eco-fast': bound(BIG, 'ready') });

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    expect(a.setReady).not.toHaveBeenCalled();
    expect(a.setError).toHaveBeenCalledWith(...loadInterruptedError({ modelName: 'Eco Big' }));
  });

  it('asks about a killed model on the other slot even when this slot is ready', async () => {
    seedDeadMark(BIG.id);
    const a = fakeActions();
    const s = seams({ 'eco-fast': bound(SMALL, 'ready'), 'eco-smart': bound(BIG, 'ready') });

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    expect(a.setReady).not.toHaveBeenCalled();
    expect(a.setError).toHaveBeenCalledWith(...loadInterruptedError({ modelName: 'Eco Big' }));
  });

  it('offers no lighter model when the next rung is larger', async () => {
    seedDeadMark(BIG.id);
    const a = fakeActions();
    const s = seams(
      { 'eco-fast': bound(BIG, 'preparing') },
      { nextInCascade: vi.fn((_failed: ModelConfig, _slot: Slot, _p: DeviceProfile, _i: unknown, opts: { excludeIds: string[] }) =>
        (opts.excludeIds.includes(LARGER.id) ? null : LARGER)) },
    );

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    const opts = a.setError.mock.calls[0]?.[1] as { loadInterrupted?: { alternative?: unknown } };
    expect(opts.loadInterrupted?.alternative).toBeUndefined();
    expect(s.runAttempt).not.toHaveBeenCalled();
  });

  it('offers the previous model back when the killed load was a switch', async () => {
    seedDeadMark(BIG.id, 'dead-load', PREVIOUS.id);
    const a = fakeActions();
    const s = seams({ 'eco-fast': bound(BIG, 'preparing') });

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    expect(a.setError).toHaveBeenCalledWith(...loadInterruptedError({
      alternative: { kind: 'roll-back', modelName: 'Eco Previous' },
    }));
    expect(s.runAttempt).not.toHaveBeenCalled();
  });
});

describe('executeSetup — the person’s answer', () => {
  it('Try again resumes the same model exactly once', async () => {
    seedKillRecord(BIG.id, 'retry');
    const a = fakeActions();
    const s = seams({ 'eco-fast': bound(BIG, 'preparing') });

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    expect(s.runAttempt).toHaveBeenCalledTimes(1);
    expect(s.runAttempt).toHaveBeenCalledWith('eco-fast', BIG, expect.any(Function));
  });

  it('Use a lighter model sets up the lighter rung with the demotion notice, without a 30-day verdict', async () => {
    seedKillRecord(BIG.id, 'step-down');
    const a = fakeActions();
    const s = seams({ 'eco-fast': bound(BIG, 'preparing') });

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    expect(s.runAttempt).toHaveBeenNthCalledWith(1, 'eco-fast', SMALL, expect.any(Function));
    expect(s.setSlot).toHaveBeenCalledWith('eco-fast', SMALL);
    expect(a.markFindingFit).toHaveBeenCalled();
    expect(a.markResuming).not.toHaveBeenCalled();
    expect(s.recordEvidence).not.toHaveBeenCalledWith(expect.objectContaining({ modelId: BIG.id, outcome: 'smoke-fail' }));
    expect(JSON.parse(localStorage.getItem('eco-local-ai-slot-demoted-from-eco-fast') ?? 'null')).toMatchObject({ modelId: BIG.id });
    expect(a.setReady).toHaveBeenCalledWith(SMALL);
  });

  it('Go back restores the previous model as ready without loading anything', async () => {
    seedKillRecord(BIG.id, 'roll-back', { rollbackModelId: PREVIOUS.id });
    const a = fakeActions();
    const slots: Partial<Record<Slot, SlotState>> = { 'eco-fast': bound(BIG, 'preparing') };
    const s = seams(slots, {
      setSlot: vi.fn((slot: Slot, model: ModelConfig | null) => {
        slots[slot] = model ? bound(model, 'preparing') : empty;
      }),
      setSlotStatus: vi.fn((slot: Slot, status: 'ready') => {
        const current = slots[slot];
        if (current?.model) slots[slot] = bound(current.model, status);
      }),
    });

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    expect(s.setSlot).toHaveBeenCalledWith('eco-fast', PREVIOUS);
    expect(s.setSlotStatus).toHaveBeenCalledWith('eco-fast', 'ready');
    expect(s.runAttempt).not.toHaveBeenCalled();
    expect(a.setReady).toHaveBeenCalledWith(PREVIOUS);
  });
});

describe('executeSetup — two kills in a row step down', () => {
  it('moves to the lighter rung, records the killer as failed, and shows the demotion notice', async () => {
    seedKillRecord(BIG.id, 'retry');
    seedDeadMark(BIG.id, 'second-load');
    const a = fakeActions();
    const s = seams({ 'eco-fast': bound(BIG, 'preparing') });

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    expect(s.runAttempt).toHaveBeenNthCalledWith(1, 'eco-fast', SMALL, expect.any(Function));
    expect(s.runAttempt).not.toHaveBeenCalledWith('eco-fast', BIG, expect.any(Function));
    expect(s.recordEvidence).toHaveBeenCalledWith({ modelId: BIG.id, profile: PROFILE, outcome: 'smoke-fail' });
    expect(a.markFindingFit).toHaveBeenCalled();
    expect(a.setReady).toHaveBeenCalledWith(SMALL);
  });

  it('with no lighter rung (a one-model device) stops honestly instead of looping or blaming iOS', async () => {
    seedKillRecord(BIG.id, 'retry');
    seedDeadMark(BIG.id, 'second-load');
    const a = fakeActions();
    const s = seams({ 'eco-fast': bound(BIG, 'preparing') }, { nextInCascade: vi.fn(() => null) });

    await executeSetup(a, { slot: 'eco-fast', seams: s });

    expect(s.runAttempt).not.toHaveBeenCalled();
    expect(a.setBelowFloor).not.toHaveBeenCalled();
    expect(a.setError).toHaveBeenCalledWith(...loadInterruptedError({ repeated: 'only-model' }));
    const opts = a.setError.mock.calls[0]?.[1] as { loadInterrupted?: { alternative?: unknown } };
    expect(opts.loadInterrupted?.alternative).toBeUndefined();
    // No verdict row: on a one-model device it would only strand the person on
    // the below-floor screen at the next fresh setup.
    expect(s.recordEvidence).not.toHaveBeenCalled();
  });
});
