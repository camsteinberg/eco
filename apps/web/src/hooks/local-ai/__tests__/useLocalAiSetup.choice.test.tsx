// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the runner: it captures the `requestChoice` bridge the hook passes in,
// invokes it (which drives the hook into 'awaiting-choice'), and parks the
// returned promise so the test can prove `choose()` resolves it.
const { executeSetupMock } = vi.hoisted(() => ({ executeSetupMock: vi.fn() }));
vi.mock('../../../local-ai/lifecycle/setup-runner', () => ({ executeSetup: executeSetupMock }));

// Only the slot lookup is faked: 'deeper' is bound to eco-smart, the way a
// first-run pick of the deeper tile leaves it. Everything else in the module
// (used by the chat store too) stays real.
vi.mock('../../../local-ai/lifecycle/slots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../local-ai/lifecycle/slots')>()),
  getSlotForModel: (modelId: string) => (modelId === 'deeper' ? 'eco-smart' : null),
}));

import { useLocalAiSetup } from '../useLocalAiSetup';
import {
  useChatStore,
  SELECTED_MODEL_STORAGE_KEY,
  SELECTED_MODEL_EXPLICIT_STORAGE_KEY,
} from '../../../stores/chatStore';
import type { SetupRunnerActions, SetupRunnerOptions } from '../../../local-ai/lifecycle/setup-runner';
import type {
  FirstRunChoiceEntry,
  FirstRunChoiceOffer,
} from '../../../local-ai/selection/first-run-choices';
import type { ModelConfig } from '../../../local-ai/types';

const OFFER: FirstRunChoiceOffer = {
  choices: [
    { model: { id: 'fast' } as ModelConfig, slot: 'eco-fast' },
    { model: { id: 'deeper' } as ModelConfig, slot: 'eco-smart' },
  ],
  recommendedId: 'deeper',
};

let choicePromise: Promise<FirstRunChoiceEntry> | null = null;

beforeEach(() => {
  choicePromise = null;
  executeSetupMock.mockReset();
  executeSetupMock.mockImplementation(
    async (_actions: unknown, options: { requestChoice?: (o: FirstRunChoiceOffer) => Promise<FirstRunChoiceEntry> }) => {
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

    let resolved: FirstRunChoiceEntry | undefined;
    void choicePromise!.then((entry) => {
      resolved = entry;
    });

    act(() => {
      result.current.choose('deeper');
    });
    await Promise.resolve();

    // Committing the choice resolves the runner with the chosen ENTRY — model
    // AND the slot it binds, so the deeper pick lands on eco-smart — and
    // replaces the card with the setup surface (no card flash).
    expect(resolved?.model.id).toBe('deeper');
    expect(resolved?.slot).toBe('eco-smart');
    expect(result.current.status).toBe('setting-up');
    expect(result.current.choiceOffer).toBeNull();
  });

  it('resolves the everyday pick with its own slot', async () => {
    const { result } = renderHook(() => useLocalAiSetup());

    await act(async () => {
      await result.current.start();
    });

    let resolved: FirstRunChoiceEntry | undefined;
    void choicePromise!.then((entry) => {
      resolved = entry;
    });

    act(() => {
      result.current.choose('fast');
    });
    await Promise.resolve();

    expect(resolved?.model.id).toBe('fast');
    expect(resolved?.slot).toBe('eco-fast');
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

// Pointing chat at the slot the setup bound is a first-run correction, not a
// per-visit one: a later visit finishes setup with nobody having chosen
// anything, so rewriting the selection there would record the person's
// deliberate pick as a default the app happened to land on.
describe('useLocalAiSetup — the selection the setup writes', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useChatStore.setState({ selectedModel: 'eco-fast' });
  });

  /** Runner fake that goes straight to ready, as it does for a set-up device. */
  function readyWithoutChoice(modelId: string) {
    return async (actions: SetupRunnerActions) => {
      actions.setReady({ id: modelId } as ModelConfig);
    };
  }

  it('leaves an explicit choice explicit when chat already points at the bound slot', async () => {
    window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, 'eco-smart');
    window.localStorage.setItem(SELECTED_MODEL_EXPLICIT_STORAGE_KEY, 'true');
    useChatStore.setState({ selectedModel: 'eco-smart' });
    executeSetupMock.mockImplementation(readyWithoutChoice('deeper'));

    const { result } = renderHook(() => useLocalAiSetup());
    await act(async () => {
      await result.current.start();
    });

    expect(useChatStore.getState().selectedModel).toBe('eco-smart');
    expect(window.localStorage.getItem(SELECTED_MODEL_STORAGE_KEY)).toBe('eco-smart');
    // The flag is load-bearing: an explicit pick survives reload verbatim,
    // a non-explicit one is routed back through 'auto'.
    expect(window.localStorage.getItem(SELECTED_MODEL_EXPLICIT_STORAGE_KEY)).toBe('true');
  });

  it('still points chat at the bound slot on a fresh device, as the choice', async () => {
    executeSetupMock.mockImplementation(
      async (
        actions: SetupRunnerActions,
        options: SetupRunnerOptions,
      ) => {
        const entry = await options.requestChoice!(OFFER);
        actions.setReady(entry.model);
      },
    );

    const { result } = renderHook(() => useLocalAiSetup());
    let started: Promise<void> | null = null;
    await act(async () => {
      started = result.current.start();
      await Promise.resolve();
    });
    act(() => {
      result.current.choose('deeper');
    });
    await act(async () => {
      await started;
    });

    // The store's fresh-device default is the eco-fast slot, which is empty
    // here — so the deeper pick must still be written, and as an explicit one.
    expect(useChatStore.getState().selectedModel).toBe('eco-smart');
    expect(window.localStorage.getItem(SELECTED_MODEL_STORAGE_KEY)).toBe('eco-smart');
    expect(window.localStorage.getItem(SELECTED_MODEL_EXPLICIT_STORAGE_KEY)).toBe('true');
  });
});
