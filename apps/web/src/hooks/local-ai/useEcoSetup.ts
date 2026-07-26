// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProgressEvent } from '../../local-ai/download/progress';
import type { ModelConfig } from '../../local-ai/types';

/**
 * Setup state machine the WelcomeSetup component renders against.
 *
 * Status values map 1:1 to vision §1:
 *   - 'initializing'  : we don't know yet what state the device is in
 *   - 'below-floor'   : isBelowFloor() = true, render BelowFloorScreen
 *   - 'setting-up'    : downloading/smoke in progress, render botanical animation
 *   - 'ready'         : a model is loaded and smoke-passed, transition to chat
 *   - 'error'         : setup failed after retries, render SetupErrorState
 *
 * The hook is a controlled state container — it does NOT call the
 * download/smoke pipeline itself. Consumers compose those calls via the
 * `actions` object from local-ai/index.ts.
 */

export type EcoSetupStatus =
  | 'initializing'
  | 'below-floor'
  | 'setting-up'
  | 'ready'
  | 'error';

export type EcoSetupPhase = 'downloading' | 'smoke' | 'done';

export type EcoSetupState = {
  status: EcoSetupStatus;
  phase: EcoSetupPhase;
  percent: number;
  etaSeconds: number;
  reassuranceIndex: number;
  errorReason: string | null;
  model: ModelConfig | null;
  /** True when start() detects a slot status of 'error' from a prior
   * session. Used by WelcomeSetup to render a one-line "we had trouble
   * setting up last time — trying again" message so the system has
   * visible memory of the prior attempt. */
  priorAttemptFailed: boolean;
  /** True while the ladder has demoted to a different model after a failure. */
  findingFit: boolean;
  /** True when setup failed because the whole fallback ladder was exhausted. */
  errorExhausted: boolean;
  /** How many models that exhausted ladder actually tried. One-model platforms
   *  (iOS, f16-less low-memory Android) report 1, so the error surface can stop
   *  claiming "we tried a few options". 0 = not known. */
  errorTriedModelCount: number;
  /** True when start() resumed a bound-but-unfinished pick (interrupted
   * download / reconcile flip) rather than recommending fresh — WelcomeSetup
   * softens its copy to "finishing your download". */
  resuming: boolean;
};

export type EcoSetupActions = {
  /** Called to feed live progress from the download pipeline. */
  onProgressEvent(event: ProgressEvent): void;
  /** Called when below-floor detection completes. */
  setBelowFloor(reason: string): void;
  /** Called when a model becomes ready. */
  setReady(model: ModelConfig): void;
  /** Called when setup fails terminally. `exhausted` = the whole ladder was
   *  spent; `triedModelCount` = how many models it got through. */
  setError(reason: string, opts?: { exhausted?: boolean; triedModelCount?: number }): void;
  /** Called when the user clicks "Try again" from the error state. */
  reset(): void;
  /** Called when start() detects an error slot status from a prior session. */
  markPriorAttemptFailed(): void;
  /** Called when the ladder demotes to a different model. */
  markFindingFit(): void;
  /** Called when start() resumes a bound-but-unfinished pick. */
  markResuming(): void;
};

export type UseEcoSetupReturn = EcoSetupState & {
  actions: EcoSetupActions;
};

const REASSURANCE_INTERVAL_MS = 8_000;
// Must match REASSURANCE_COPY.length in WelcomeSetup.tsx — the rotation blends
// promise/process/warmth lines so it carries the multi-minute wait without an
// obvious loop (10 lines × 8s = 80s before any repeat).
const REASSURANCE_COUNT = 10;

const INITIAL_STATE: EcoSetupState = {
  status: 'initializing',
  phase: 'downloading',
  percent: 0,
  etaSeconds: 90,
  reassuranceIndex: 0,
  errorReason: null,
  model: null,
  priorAttemptFailed: false,
  findingFit: false,
  errorExhausted: false,
  errorTriedModelCount: 0,
  resuming: false,
};

export function useEcoSetup(): UseEcoSetupReturn {
  const [state, setState] = useState<EcoSetupState>(INITIAL_STATE);

  // Reassurance rotation. Pauses when setup is no longer 'setting-up'.
  useEffect(() => {
    if (state.status !== 'setting-up') return;
    const interval = setInterval(() => {
      setState((s) => ({
        ...s,
        reassuranceIndex: (s.reassuranceIndex + 1) % REASSURANCE_COUNT,
      }));
    }, REASSURANCE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [state.status]);

  const onProgressEvent = useCallback((event: ProgressEvent) => {
    setState((s) => {
      const next: EcoSetupState = { ...s, status: 'setting-up' };
      if (event.kind === 'progress' && event.phase === 'downloading') {
        next.phase = 'downloading';
        next.percent = Math.round(event.percent * 100);
        next.etaSeconds = Math.max(0, Math.round(event.etaSeconds));
      } else if (event.kind === 'progress' && event.phase === 'smoke') {
        next.phase = 'smoke';
        next.percent = 95;
        next.etaSeconds = 5;
      } else if (event.kind === 'phase') {
        if (event.phase === 'done') {
          next.phase = 'done';
          next.percent = 100;
          next.etaSeconds = 0;
        } else if (event.phase === 'error') {
          // Informational only — executeSetup owns terminal error status now.
          // defaultRunAttempt fires tracker.error() on EVERY intermediate
          // load/smoke failure, so flipping status to 'error' here would
          // flash the terminal error screen for a frame mid-demotion before
          // the cascade recovers to the next model. The runner calls
          // setError() solely when the whole fallback ladder is exhausted.
        }
      } else if (event.kind === 'stall') {
        // Early-stall and smoke-timeout escalate to error after the
        // download layer's own retry path has been exhausted. The
        // download pipeline itself emits a phase=error event when it
        // gives up; this branch is informational only.
      }
      return next;
    });
  }, []);

  const setBelowFloor = useCallback((_reason: string) => {
    setState((s) => ({ ...s, status: 'below-floor' }));
  }, []);

  const setReady = useCallback((model: ModelConfig) => {
    setState((s) => ({ ...s, status: 'ready', model, phase: 'done', percent: 100 }));
  }, []);

  const setError = useCallback(
    (reason: string, opts?: { exhausted?: boolean; triedModelCount?: number }) => {
      setState((s) => ({
        ...s,
        status: 'error',
        errorReason: reason,
        errorExhausted: opts?.exhausted ?? false,
        errorTriedModelCount: opts?.triedModelCount ?? 0,
      }));
    },
    [],
  );

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const markPriorAttemptFailed = useCallback(() => {
    setState((s) => ({ ...s, priorAttemptFailed: true }));
  }, []);

  const markFindingFit = useCallback(() => {
    setState((s) => ({ ...s, findingFit: true }));
  }, []);

  const markResuming = useCallback(() => {
    setState((s) => ({ ...s, resuming: true }));
  }, []);

  const actions = useMemo<EcoSetupActions>(
    () => ({ onProgressEvent, setBelowFloor, setReady, setError, reset, markPriorAttemptFailed, markFindingFit, markResuming }),
    [onProgressEvent, setBelowFloor, setReady, setError, reset, markPriorAttemptFailed, markFindingFit, markResuming],
  );

  return { ...state, actions };
}
