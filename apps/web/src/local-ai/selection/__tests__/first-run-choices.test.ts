// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate the offer LOGIC (dedup + which model is recommended) from the real
// recommendation engine — recommend()'s device behavior is covered by recommend.test.ts.
vi.mock('../recommend', () => ({ recommend: vi.fn() }));

import { recommend } from '../recommend';
import { deriveFirstRunChoices } from '../first-run-choices';
import type { DeviceProfile, ModelConfig, Slot } from '../../types';

const PROFILE = {} as DeviceProfile;
const model = (id: string, sizeGB = 1) => ({ id, sizeGB } as ModelConfig);
const mockRecommend = vi.mocked(recommend);

beforeEach(() => {
  mockRecommend.mockReset();
});

describe('deriveFirstRunChoices', () => {
  it('offers the everyday + deeper models and preselects the deeper one for quality (capable desktop)', () => {
    mockRecommend.mockImplementation((slot: Slot) =>
      slot === 'eco-smart' ? model('deeper', 1.65) : model('fast', 0.76),
    );

    const offer = deriveFirstRunChoices('eco-fast', PROFILE);

    // Both are offered — the everyday pick stays listed first...
    expect(offer.choices.map((c) => c.model.id)).toEqual(['fast', 'deeper']);
    // ...and the PRESELECTED / "Recommended" default is the deeper model:
    // quality sampling (s19/s20, 2026-08-28) showed it produces materially
    // better answers, outweighing the longer first download.
    expect(offer.recommendedId).toBe('deeper');
  });

  it('carries the slot each model was recommended for, so a pick binds where it belongs', () => {
    mockRecommend.mockImplementation((slot: Slot) =>
      slot === 'eco-smart' ? model('deeper', 1.65) : model('fast', 0.76),
    );

    const offer = deriveFirstRunChoices('eco-fast', PROFILE);

    // The offer is built from TWO slot recommendations. Dropping the slot here
    // is what let a deliberate "deeper" pick be written into eco-fast.
    expect(offer.choices).toEqual([
      { model: model('fast', 0.76), slot: 'eco-fast' },
      { model: model('deeper', 1.65), slot: 'eco-smart' },
    ]);
  });

  it('collapses to a single option when the deeper pick is the same model', () => {
    mockRecommend.mockReturnValue(model('fast')); // both slots resolve to the same model

    const offer = deriveFirstRunChoices('eco-fast', PROFILE);

    expect(offer.choices.map((c) => c.model.id)).toEqual(['fast']);
    expect(offer.recommendedId).toBe('fast');
  });

  it('offers a single option when no deeper model is assignable (mobile / WASM-only)', () => {
    mockRecommend.mockImplementation((slot: Slot) => {
      if (slot === 'eco-smart') throw new Error('no assignable model');
      return model('fast');
    });

    const offer = deriveFirstRunChoices('eco-fast', PROFILE);

    expect(offer.choices.map((c) => c.model.id)).toEqual(['fast']);
    expect(offer.recommendedId).toBe('fast');
  });

  it('drops a deeper pick that is SMALLER than the everyday pick (no downgrade-as-upgrade)', () => {
    // A memory-constrained device can resolve eco-smart to a floor model smaller
    // than the everyday fast pick — e.g. a 4-7GB WebGPU device recovers the 1.2B
    // (0.76GB) for eco-fast but eco-smart still floors to the 0.57GB qwen3-0.6b.
    // Offering that as "deeper" would be a downgrade; the size guard suppresses it.
    mockRecommend.mockImplementation((slot: Slot) =>
      slot === 'eco-smart' ? model('smaller-floor', 0.57) : model('good-fast', 0.76),
    );

    const offer = deriveFirstRunChoices('eco-fast', PROFILE);

    expect(offer.choices.map((c) => c.model.id)).toEqual(['good-fast']);
    expect(offer.recommendedId).toBe('good-fast');
  });
});
