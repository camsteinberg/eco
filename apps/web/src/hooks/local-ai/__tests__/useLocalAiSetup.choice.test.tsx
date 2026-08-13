// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the runner: it captures the `requestChoice` bridge the hook passes in,
// invokes it (which drives the hook into 'awaiting-choice'), and parks the
// returned promise so the test can prove `choose()` resolves it.
const { executeSetupMock } = vi.hoisted(() => ({ executeSetupMock: vi.fn() }));
vi.mock('../../../local-ai/lifecycle/setup-runner', () => ({ executeSetup: executeSetupMock }));

import { useLocalAiSetup } from '../useLocalAiSetup';
import type { FirstRunChoiceOffer } from '../../../local-ai/selection/first-run-choices';
import type { ModelConfig } from '../../../local-ai/types';

const OFFER: FirstRunChoiceOffer = {
  models: [{ id: 'fast' } as ModelConfig, { id: 'deeper' } as ModelConfig],
  recommendedId: 'deeper',
};

let choicePromise: Promise<ModelConfig> | null = null;

beforeEach(() => {
  choicePromise = null;
  executeSetupMock.mockReset();
  executeSetupMock.mockImplementation(
    async (_actions: unknown, options: { requestChoice?: (o: FirstRunChoiceOffer) => Promise<ModelConfig> }) => {
      // Presenting the offer flips the hook to 'awaiting-choice' synchronously;
      // the returned promise stays pending until the user picks.
      if (options.requestChoice) choicePromise = options.requestChoice(OFFER);
    },
  );
});

describe('useLocalAiSetup — first-run choice bridge', () => {
  it('presents the offer, then resolves the runner on choose() and starts setup', async () => {
    const { result } = renderHook(() => useLocalAiSetup());

    await act(async () => {
      await result.current.start();
    });

    // The runner asked for a choice → card state is live.
    expect(result.current.status).toBe('awaiting-choice');
    expect(result.current.choiceOffer).toEqual(OFFER);
    expect(choicePromise).not.toBeNull();

    let resolved: ModelConfig | undefined;
    void choicePromise!.then((m) => {
      resolved = m;
    });

    act(() => {
      result.current.choose('deeper');
    });
    await Promise.resolve();

    // Committing the choice resolves the runner with the chosen model and
    // replaces the card with the setup surface (no card flash).
    expect(resolved?.id).toBe('deeper');
    expect(result.current.status).toBe('setting-up');
    expect(result.current.choiceOffer).toBeNull();
  });

  it('ignores choose() for an id not in the offer', async () => {
    const { result } = renderHook(() => useLocalAiSetup());

    await act(async () => {
      await result.current.start();
    });

    let resolved = false;
    void choicePromise!.then(() => {
      resolved = true;
    });

    act(() => {
      result.current.choose('nonexistent');
    });
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(result.current.status).toBe('awaiting-choice');
  });
});
