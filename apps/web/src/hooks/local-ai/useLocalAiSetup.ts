// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useRef } from 'react';
import { executeSetup } from '../../local-ai/lifecycle/setup-runner';
import type { ModelConfig, Slot } from '../../local-ai/types';
import type { FirstRunChoiceOffer } from '../../local-ai/selection/first-run-choices';
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
  const choiceResolverRef = useRef<((model: ModelConfig) => void) | null>(null);

  const presentChoice = setup.actions.presentChoice;
  const requestChoice = useCallback(
    (offer: FirstRunChoiceOffer): Promise<ModelConfig> => {
      presentChoice(offer);
      return new Promise<ModelConfig>((resolve) => {
        choiceResolverRef.current = resolve;
      });
    },
    [presentChoice],
  );

  const start = useCallback(async (): Promise<void> => {
    if (startedRef.current) return;
    startedRef.current = true;
    await executeSetup(
      {
        onProgressEvent: setup.actions.onProgressEvent,
        setBelowFloor: setup.actions.setBelowFloor,
        setReady: setup.actions.setReady,
        setError: setup.actions.setError,
        markPriorAttemptFailed: setup.actions.markPriorAttemptFailed,
        markFindingFit: setup.actions.markFindingFit,
        markResuming: setup.actions.markResuming,
      },
      { slot, skipBootstrap: options.skipBootstrap, requestChoice },
    );
  }, [slot, setup.actions, options.skipBootstrap, requestChoice]);

  const choiceOffer = setup.choiceOffer;
  const markSetupStarting = setup.actions.markSetupStarting;
  const choose = useCallback(
    (modelId: string): void => {
      const resolve = choiceResolverRef.current;
      const model = choiceOffer?.models.find((m) => m.id === modelId);
      if (!resolve || !model) return;
      choiceResolverRef.current = null;
      markSetupStarting();
      resolve(model);
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
