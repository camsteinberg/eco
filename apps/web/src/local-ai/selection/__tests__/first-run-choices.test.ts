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
const model = (id: string) => ({ id } as ModelConfig);
const mockRecommend = vi.mocked(recommend);

beforeEach(() => {
  mockRecommend.mockReset();
});

describe('deriveFirstRunChoices', () => {
  it('offers the everyday + deeper models but preselects the everyday one for instant-start (capable desktop)', () => {
    mockRecommend.mockImplementation((slot: Slot) =>
      slot === 'eco-smart' ? model('deeper') : model('fast'),
    );

    const offer = deriveFirstRunChoices('eco-fast', PROFILE);

    // Both are offered — the deeper model stays a visible opt-in tile...
    expect(offer.models.map((m) => m.id)).toEqual(['fast', 'deeper']);
    // ...but the PRESELECTED / "Recommended" default is the everyday fast model,
    // so a fresh capable device instant-starts on the small download instead of
    // auto-preselecting the ~1.65GB deeper model (FR-1).
    expect(offer.recommendedId).toBe('fast');
  });

  it('collapses to a single option when the deeper pick is the same model', () => {
    mockRecommend.mockReturnValue(model('fast')); // both slots resolve to the same model

    const offer = deriveFirstRunChoices('eco-fast', PROFILE);

    expect(offer.models.map((m) => m.id)).toEqual(['fast']);
    expect(offer.recommendedId).toBe('fast');
  });

  it('offers a single option when no deeper model is assignable (mobile / WASM-only)', () => {
    mockRecommend.mockImplementation((slot: Slot) => {
      if (slot === 'eco-smart') throw new Error('no assignable model');
      return model('fast');
    });

    const offer = deriveFirstRunChoices('eco-fast', PROFILE);

    expect(offer.models.map((m) => m.id)).toEqual(['fast']);
    expect(offer.recommendedId).toBe('fast');
  });
});
