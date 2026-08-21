// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useRef } from 'react';
import { executeSetup } from '../../local-ai/lifecycle/setup-runner';
import { getSlotForModel } from '../../local-ai/lifecycle/slots';
import type { ModelConfig, Slot } from '../../local-ai/types';
import type {
  FirstRunChoiceEntry,
  FirstRunChoiceOffer,
} from '../../local-ai/selection/first-run-choices';
import { useChatStore } from '../../stores/chatStore';
import { useEcoSetup, type UseEcoSetupReturn } from './useEcoSetup';

/**
 * Thin React wrapper around the pure `executeSetup` runner. The outer
 * first-run flow (bootstrap → profile → below-floor → resume → fallback
 * ladder → ready/exhausted) lives in `local-ai/lifecycle/setup-runner.ts`;
 * this hook only owns the `useEcoSetup` state container, single-use
 * idempotency, and the `reset()`-clears-started effect so the
 * WelcomeSetup / SetupErrorState / BelowFloorScreen components render
 * against authoritative state.
 *
 * The hook is single-use per mount. Calling `start()` on a fresh mount
 * triggers the pipeline; subsequent calls during the same mount are
 * no-ops unless `reset()` is called.
 */

export type UseLocalAiSetupOptions = {
  /** Slot to set up. Defaults to 'eco-fast'. */
  slot?: Slot;
  /** Skip the bootstrap call (already initialized). */
  skipBootstrap?: boolean;
};

export type UseLocalAiSetupReturn = UseEcoSetupReturn & {
  start(): Promise<void>;
  /** Commit the user's first-run model choice (by catalog id). Resolves the
   * runner's pending choice request so the download begins with that model. */
  choose(modelId: string): void;
};

export function useLocalAiSetup(options: UseLocalAiSetupOptions = {}): UseLocalAiSetupReturn {
  const slot: Slot = options.slot ?? 'eco-fast';
  const setup = useEcoSetup();
  const startedRef = useRef(false);
  // Resolver for the in-flight first-run choice promise. Set when the runner
  // asks for a choice; called by `choose()` when the user commits.
  const choiceResolverRef = useRef<((choice: FirstRunChoiceEntry) => void) | null>(null);
  // True once the user has picked from the welcome card. Their pick is a
  // deliberate choice, so the slot it lands in becomes chat's explicit
  // selection — see `setReady` below.
  const userChoseRef = useRef(false);

  const presentChoice = setup.actions.presentChoice;
  const requestChoice = useCallback(
    (offer: FirstRunChoiceOffer): Promise<FirstRunChoiceEntry> => {
      presentChoice(offer);
      return new Promise<FirstRunChoiceEntry>((resolve) => {
        choiceResolverRef.current = resolve;
      });
    },
    [presentChoice],
  );

  const setReadyState = setup.actions.setReady;
  // Point chat at the slot the setup actually bound. A first-run pick can land
  // on eco-smart (the deeper tile), and the store's fresh-device default is the
  // eco-fast slot name — which would resolve to an EMPTY slot and refuse the
  // very first message. Only written when the run bound something other than
  // the setup slot, so the ordinary eco-fast path keeps its existing behavior.
  const setReady = useCallback(
    (model: ModelConfig): void => {
      const boundSlot = getSlotForModel(model.id);
      if (boundSlot && boundSlot !== slot) {
        useChatStore.getState().setSelectedModel(boundSlot, { explicit: userChoseRef.current });
      }
      setReadyState(model);
    },
    [slot, setReadyState],
  );

  const start = useCallback(async (): Promise<void> => {
    if (startedRef.current) return;
    startedRef.current = true;
    await executeSetup(
      {
        onProgressEvent: setup.actions.onProgressEvent,
        setBelowFloor: setup.actions.setBelowFloor,
        setReady,
        setError: setup.actions.setError,
        markPriorAttemptFailed: setup.actions.markPriorAttemptFailed,
        markFindingFit: setup.actions.markFindingFit,
        markResuming: setup.actions.markResuming,
      },
      { slot, skipBootstrap: options.skipBootstrap, requestChoice },
    );
  }, [slot, setup.actions, setReady, options.skipBootstrap, requestChoice]);

  const choiceOffer = setup.choiceOffer;
  const markSetupStarting = setup.actions.markSetupStarting;
  const choose = useCallback(
    (modelId: string): void => {
      const resolve = choiceResolverRef.current;
      // Resolve to the whole ENTRY: the slot travels with the pick, so the
      // runner binds where the model was offered rather than re-guessing.
      const choice = choiceOffer?.choices.find((c) => c.model.id === modelId);
      if (!resolve || !choice) return;
      choiceResolverRef.current = null;
      userChoseRef.current = true;
      markSetupStarting();
      resolve(choice);
    },
    [choiceOffer, markSetupStarting],
  );

  // Allow `reset()` from useEcoSetup to clear our latched startedRef.
  const reset = setup.actions.reset;
  useEffect(() => {
    if (setup.status === 'initializing') {
      startedRef.current = false;
    }
  }, [setup.status, reset]);

  return { ...setup, start, choose };
}
