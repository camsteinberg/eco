// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Setup runner — the outer first-run flow, pure of React.
 *
 * bootstrap → adapter-probed profile → below-floor → resume → cascade ladder
 * → ready / honest-exhausted error. All side effects go through injected seams
 * (default to the real implementations) so the flow is unit-testable with
 * plain fakes. `useLocalAiSetup` is a thin wrapper that calls this.
 */

import type { DeviceProfile, ModelConfig, Slot } from '../types';
import type { ProgressEvent } from '../download/progress';
import { ProgressTracker } from '../download/progress';
import { bootstrapLocalAi } from '../bootstrap';
import {
  DownloadAbortedError,
  DownloadFailedError,
  DownloadIntegrityError,
  downloadModel,
  InsufficientStorageError,
  isModelDownloaded,
} from '../download/download';
import { bridgeDownloadWebLLMModel } from '../runtime/webllm-cache-bridge';
import {
  acquireLocalHeavyWork,
  type LocalHeavyWorkAcquireResult,
  type LocalHeavyWorkKind,
} from '../../lib/local-heavy-work-owner';
import { runSmoke } from './smoke';
import { setSlot, setSlotStatus, getSlot, type SlotState, type SlotStatus } from './slots';
import { isBelowFloor } from '../device/below-floor';
import { recommend } from '../index';
import { nextInCascade } from '../selection/cascade';
import { NoAssignableModelError, starterModelForSlot } from '../selection/recommend';
import {
  deriveFirstRunChoices,
  type FirstRunChoiceEntry,
  type FirstRunChoiceOffer,
} from '../selection/first-run-choices';
import { recordEvidence } from '../evidence/ledger';
import { resolveSetupProfile } from '../device/profile';
import {
  runSetupCascade,
  type AttemptFailureReasonCode,
  type AttemptResult,
} from './setup-cascade';
import { logSetupAttemptFailure } from './setup-diagnostics';

/** Subset of EcoSetupActions the runner drives (structural — no React import). */
export type SetupRunnerActions = {
  onProgressEvent(event: ProgressEvent): void;
  setBelowFloor(reason: string): void;
  setReady(model: ModelConfig): void;
  setError(
    reason: string,
    opts?: {
      exhausted?: boolean;
      triedModelCount?: number;
      reasonCode?: AttemptFailureReasonCode;
    },
  ): void;
  markPriorAttemptFailed(): void;
  markFindingFit(): void;
  /** The run picked up a bound-but-unfinished pick (interrupted download /
   *  reconcile flip) rather than recommending fresh — the gate can soften its
   *  copy to "finishing your download" instead of first-run copy. */
  markResuming(): void;
};

export type SetupSeams = {
  bootstrap: () => Promise<void>;
  resolveProfile: () => Promise<DeviceProfile>;
  isBelowFloor: (profile: DeviceProfile) => boolean;
  getSlot: (slot: Slot) => SlotState;
  /** `null` releases the slot — used when a demotion abandons a bound pick. */
  setSlot: (slot: Slot, model: ModelConfig | null) => void;
  setSlotStatus: (slot: Slot, status: SlotStatus) => void;
  recommend: (slot: Slot, profile: DeviceProfile) => ModelConfig;
  nextInCascade: typeof nextInCascade;
  recordEvidence: typeof recordEvidence;
  runAttempt: (slot: Slot, model: ModelConfig, onProgressEvent: (e: ProgressEvent) => void) => Promise<AttemptResult>;
  /** Stage A starter pick — smallest offerable model for the slot (null = none). */
  starterModelForSlot: (slot: Slot, profile: DeviceProfile) => ModelConfig | null;
  /** First-run offer: the device-appropriate models to present on the welcome
   *  card (1–2), plus which one is recommended. Domain-only; the UI maps them
   *  to card copy. */
  deriveFirstRunChoices: (slot: Slot, profile: DeviceProfile) => FirstRunChoiceOffer;
  /** True when the model is downloaded in whatever store its runtime serves
   *  from — Eco's own cache, or (for a `webllm` model) WebLLM's cache, into
   *  which the bridge stages and empties the Eco copy. */
  isModelCached: (model: ModelConfig) => Promise<boolean>;
};

export type SetupRunnerOptions = {
  slot?: Slot;
  skipBootstrap?: boolean;
  /**
   * Stage A starter-first pipeline (instant-start slice 2b). Default on;
   * `false` restores the class-best-first pipeline — the rollback lever.
   * Overridable per-session via `?eco-starter-first=off|on` for field
   * triage and real-browser journeys.
   */
  starterFirst?: boolean;
  /**
   * First-run choice bridge. When provided AND the slot is genuinely fresh
   * (no bound model, not resuming, not below-floor), the runner offers the
   * user a choice of model and awaits their pick, using it as the first pick
   * (which bypasses starter-first — an explicit choice is never downgraded).
   * Omitted (tests, non-first-run) → the runner auto-recommends as before.
   *
   * Resolves with the chosen ENTRY, not a bare model: the entry carries the
   * slot the pick binds, which is the whole reason a deeper pick now lands on
   * eco-smart instead of being written over the everyday slot.
   */
  requestChoice?: (offer: FirstRunChoiceOffer) => Promise<FirstRunChoiceEntry>;
  seams?: Partial<SetupSeams>;
};

/** Flip to false to roll back Stage A globally (instant-start slice 2b). */
export const STARTER_FIRST_SETUP_DEFAULT = true;

const URL_PARAM_STARTER_FIRST = 'eco-starter-first';

function readStarterFirstOverride(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = new URLSearchParams(window.location.search).get(URL_PARAM_STARTER_FIRST);
    if (value === 'off' || value === '0') return false;
    // '' = bare `?eco-starter-first` (URLSearchParams returns '' for a
    // valueless param) — treat presence as "on", mirroring ?eco-force-wasm.
    if (value === 'on' || value === '1' || value === '') return true;
    return null;
  } catch {
    return null;
  }
}

function resolveStarterFirst(options: SetupRunnerOptions): boolean {
  return options.starterFirst ?? readStarterFirstOverride() ?? STARTER_FIRST_SETUP_DEFAULT;
}

/**
 * Stage A first pick. The class-best recommendation stays the anchor (and
 * still throws NoAssignableModelError for the below-floor routing above);
 * starter-first only changes which rung the ladder STARTS on:
 *
 *   - class-best fully cached → class-best (returning-user fast path — a
 *     user who already holds the good model is never downgraded)
 *   - otherwise → the starter (smallest offerable), converging to the
 *     class-best trivially when they are the same model
 *
 * The cascade ladder after the first pick is unchanged: a starter failure
 * demotes into the natural ranking via nextInCascade.
 */
async function chooseFirstPick(
  slot: Slot,
  profile: DeviceProfile,
  seams: SetupSeams,
  starterFirst: boolean,
): Promise<ModelConfig> {
  const classBest = seams.recommend(slot, profile);
  if (!starterFirst) return classBest;
  // A probe error reads as "not cached" — failing toward the starter keeps
  // first-run fast, and the download's own verify-skip pass makes a false
  // negative cost only the probe.
  const cached = await seams.isModelCached(classBest).catch(() => false);
  if (cached) return classBest;
  return seams.starterModelForSlot(slot, profile) ?? classBest;
}

/**
 * Offer the first-run model choice and await the user's pick. Returns the chosen
 * model, or null when there is nothing to choose (no offerable models) so the
 * caller falls through to the normal auto-recommendation. `deriveFirstRunChoices`
 * throwing `NoAssignableModelError` propagates — the executeSetup catch routes it
 * to the honest below-floor surface, matching the auto-recommend path.
 */
async function requestFirstRunChoice(
  slot: Slot,
  profile: DeviceProfile,
  seams: SetupSeams,
  requestChoice: (offer: FirstRunChoiceOffer) => Promise<FirstRunChoiceEntry>,
): Promise<FirstRunChoiceEntry | null> {
  const offer = seams.deriveFirstRunChoices(slot, profile);
  if (offer.choices.length === 0) return null;
  return requestChoice(offer);
}

/**
 * How long first-run will WAIT for another tab's 'download' lease before giving
 * up and proceeding anyway. Sized to cover a typical concurrent first-run
 * download so the second tab cache-hits; past it we fail open (see below).
 */
export const SETUP_DOWNLOAD_LEASE_WAIT_MS = 60_000;
const DOWNLOAD_LEASE_POLL_MS = 500;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<'slept' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('slept');
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve('aborted');
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Acquire the cross-tab 'download' lease for first-run — but FAIL OPEN.
 *
 * First-run historically took no lease, so two tabs onboarding at once each
 * downloaded the same ~2GB weights (the 'download' domain enforces one heavy
 * download at a time everywhere else — switch/upgrade both hold it). Acquiring
 * it here serializes them: when the busy tab finishes, ours becomes a
 * verify-skip cache hit.
 *
 * The hard rule: onboarding must NEVER dead-end on a lease. So if another tab
 * holds it we WAIT (bounded, abortable) for it to clear, and if the wait times
 * out — or the signal aborts — we PROCEED WITHOUT the lease. Worst case is
 * today's behavior (a rare double download); best case is a clean hand-off. The
 * returned `release` is a no-op when we proceeded unleased.
 */
export async function acquireDownloadLeaseFailOpen(
  acquireLease: (kind: LocalHeavyWorkKind) => LocalHeavyWorkAcquireResult,
  options: { signal?: AbortSignal; waitMs?: number; pollMs?: number } = {},
): Promise<{ release: () => void }> {
  const waitMs = options.waitMs ?? SETUP_DOWNLOAD_LEASE_WAIT_MS;
  const pollMs = options.pollMs ?? DOWNLOAD_LEASE_POLL_MS;
  const proceedUnleased: { release: () => void } = { release: () => {} };
  const startedAt = Date.now();

  for (;;) {
    if (options.signal?.aborted) return proceedUnleased;
    const attempt = acquireLease('download');
    if (attempt.ok) return { release: attempt.release };
    // Busy: another tab is downloading. Wait for it to clear so we cache-hit —
    // but fail open past the budget so first-run never blocks on the lease.
    if (Date.now() - startedAt >= waitMs) return proceedUnleased;
    const slept = await abortableSleep(pollMs, options.signal);
    if (slept === 'aborted') return proceedUnleased;
  }
}

/**
 * Which download failures the error surface is allowed to NAME.
 *
 * Only classes we can identify get a code; everything else returns undefined and
 * the surface falls back to copy that claims nothing about the cause. In
 * particular:
 *
 *   - `DownloadIntegrityError` is a `DownloadFailedError` subclass, but it means
 *     the bytes did not match the reviewed manifest — not that the host was
 *     unreachable. Checked first so it does not inherit the connectivity copy.
 *   - a cache / OPFS write failure surfaces as a plain `Error` from `storage.put`
 *     with no distinguishing type, so it stays uncoded rather than guessed at.
 */
function downloadFailureReasonCode(err: unknown): AttemptFailureReasonCode | undefined {
  if (err instanceof InsufficientStorageError) return 'insufficient-storage';
  if (err instanceof DownloadIntegrityError) return undefined;
  // A non-OK response, a dropped stream, or a stall that aborted the in-flight
  // fetch (RT-4): the host or the connection, never this device.
  if (err instanceof DownloadFailedError || err instanceof DownloadAbortedError) {
    return 'network-or-host';
  }
  return undefined;
}

/** Default real attempt: download → smoke, wired to the progress tracker. */
export async function defaultRunAttempt(
  slot: Slot,
  model: ModelConfig,
  onProgressEvent: (e: ProgressEvent) => void,
  acquireLease: (kind: LocalHeavyWorkKind) => LocalHeavyWorkAcquireResult = acquireLocalHeavyWork,
): Promise<AttemptResult> {
  const tracker = new ProgressTracker();
  // RT-4: a download stall (a TTFB hang before the first byte, or a mid-stream
  // wedge) aborts the in-flight fetch so the cascade can retry/demote instead of
  // hanging setup forever. We gate on the download phase — `startSmoke()` cancels
  // the download timer, but gating keeps a later smoke stall from tripping this.
  // The abort surfaces as a DownloadAbortedError, which the catch below
  // classifies as phase 'download' (a transient blip → retry-once, then demote).
  const controller = new AbortController();
  const unsubscribeStall = tracker.subscribe((event) => {
    if (event.kind === 'stall' && event.phase === 'downloading') controller.abort();
  });
  const unsubscribe = tracker.subscribe(onProgressEvent);
  try {
    // Coordinate concurrent first-run downloads across tabs (fail-open). Do this
    // BEFORE arming the download stall timer, so waiting on another tab is never
    // misread as a stall.
    const downloadLease = await acquireDownloadLeaseFailOpen(acquireLease, {
      signal: controller.signal,
    });
    try {
      // Arm the stall timer before the first byte so a TTFB hang is caught even
      // when no progress is ever reported (RT-4).
      tracker.startDownload();
      // A `webllm` model routes through the cache bridge instead of the plain
      // downloader: it still runs Eco's zero-retention download, then pre-stages
      // the bytes in WebLLM's own cache so serving is a pure cache hit. Every
      // other runtime is unchanged. The bridge re-throws download errors as-is
      // (incl. InsufficientStorageError), so the classification below is uniform.
      if (model.runtime === 'webllm') {
        await bridgeDownloadWebLLMModel(model, { tracker, signal: controller.signal });
      } else {
        await downloadModel(model, { tracker, signal: controller.signal });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Download failed.';
      logSetupAttemptFailure({ modelId: model.id, runtime: model.runtime, phase: 'download', reason, error: err });
      tracker.error(reason);
      const reasonCode = downloadFailureReasonCode(err);
      return reasonCode
        ? { ok: false, phase: 'download', reason, reasonCode }
        : { ok: false, phase: 'download', reason };
    } finally {
      // The 'download' lease covers only the transfer; smoke is runtime work in
      // a different lease domain. Release before smoke, on success and failure.
      downloadLease.release();
    }
    tracker.startSmoke();
    let result;
    try {
      result = await runSmoke(slot, model);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Smoke check failed.';
      logSetupAttemptFailure({ modelId: model.id, runtime: model.runtime, phase: 'load-or-smoke', reason, error: err });
      tracker.error(reason);
      return { ok: false, phase: 'load-or-smoke', reason };
    }
    if (result.passed) {
      tracker.complete();
      return { ok: true };
    }
    logSetupAttemptFailure({ modelId: model.id, runtime: model.runtime, phase: 'load-or-smoke', reason: result.reason });
    tracker.error(result.reason);
    return { ok: false, phase: 'load-or-smoke', reason: result.reason };
  } finally {
    // Cancel any still-pending stall timer's effect and drop the listeners.
    controller.abort();
    unsubscribeStall();
    unsubscribe();
  }
}

export const DEFAULT_SEAMS: SetupSeams = {
  bootstrap: bootstrapLocalAi,
  resolveProfile: resolveSetupProfile,
  isBelowFloor,
  getSlot,
  setSlot,
  setSlotStatus,
  recommend,
  nextInCascade,
  recordEvidence,
  runAttempt: defaultRunAttempt,
  starterModelForSlot: (slot, profile) => starterModelForSlot(slot, profile),
  deriveFirstRunChoices,
  isModelCached: (model) => isModelDownloaded(model),
};

export async function executeSetup(
  actions: SetupRunnerActions,
  options: SetupRunnerOptions = {},
): Promise<void> {
  // The slot being SET UP. Distinct from the slot a pick BINDS: the first-run
  // offer is built from two slot recommendations, so a deliberate "deeper" pick
  // belongs to eco-smart even though eco-fast is the slot this run started for.
  // Collapsing the two is what wrote a deeper pick into eco-fast and left
  // eco-smart empty.
  const slot: Slot = options.slot ?? 'eco-fast';
  const seams: SetupSeams = { ...DEFAULT_SEAMS, ...options.seams };

  if (!options.skipBootstrap) {
    try {
      await seams.bootstrap();
    } catch (err) {
      actions.setError(err instanceof Error ? err.message : String(err));
      return;
    }
  }

  let profile: DeviceProfile;
  try {
    profile = await seams.resolveProfile();
  } catch (err) {
    actions.setError(err instanceof Error ? err.message : 'Could not read this device.');
    return;
  }

  if (seams.isBelowFloor(profile)) {
    actions.setBelowFloor('genuine-below-floor');
    return;
  }

  const current = seams.getSlot(slot);
  if (current.modelId && current.status === 'ready' && current.model) {
    actions.setReady(current.model);
    return;
  }
  if (current.modelId && current.status === 'error') {
    actions.markPriorAttemptFailed();
  }

  // A slot left 'preparing' with a bound model is an in-flight pick whose bytes
  // are unverified — an interrupted switch/upgrade download or a reconcile flip.
  // RESUME that exact model rather than re-recommending: setSlot flips the slot
  // to 'preparing' the instant a switch binds a new pick pre-download, so
  // re-recommending here would silently swap the user's chosen model out from
  // under them. The download pipeline's per-file verify-skip means resuming only
  // re-fetches what's missing; a resumed model that fails still demotes through
  // the cascade as normal. A bound id the catalog no longer carries resolves to
  // current.model === null (getSlot nulls unknown ids), so we fall through to a
  // fresh pick — the correct behavior when the pick can't be honored.
  const resumeModel =
    current.status === 'preparing' && current.model ? current.model : null;
  if (resumeModel) actions.markResuming();

  // The slot the run's current pick is bound to — where the terminal status
  // write lands. Starts at the slot being set up and moves only when a pick
  // belongs elsewhere; `hasBound` distinguishes "not bound yet" from "bound to
  // the setup slot", so a first bind never clears a slot it never wrote.
  let boundSlot: Slot = slot;
  let hasBound = false;

  let result;
  try {
    // A fresh, unbound slot on a servable device: offer the user a model choice
    // (the welcome card) and use their pick as the first rung. An explicit
    // choice bypasses starter-first entirely — we never downgrade what the user
    // deliberately selected. Only fires when a choice bridge is wired AND the
    // slot has no prior binding ('empty'); resume/retry/ready paths skip it.
    const chosenFirstPick =
      !resumeModel && options.requestChoice && current.status === 'empty'
        ? await requestFirstRunChoice(slot, profile, seams, options.requestChoice)
        : null;

    // Stage A: resolve the ladder's first rung up front. A resumed bound pick
    // takes precedence, then an explicit user choice; otherwise the starter
    // unless the class-best is already fully cached. The cascade's recommend
    // seam then returns that precomputed pick — cache probing is async and the
    // cascade's recommend contract is sync, so the choice has to happen out here.
    const firstPick =
      resumeModel
      ?? chosenFirstPick?.model
      ?? await chooseFirstPick(slot, profile, seams, resolveStarterFirst(options));
    // Where the FIRST pick binds. A user's choice binds the slot it was offered
    // for; a resumed or auto-recommended pick binds the slot being set up.
    const firstPickSlot: Slot = resumeModel ? slot : chosenFirstPick?.slot ?? slot;
    result = await runSetupCascade({
      slot,
      profile,
      recommend: () => firstPick,
      nextInCascade: seams.nextInCascade,
      runAttempt: (model) => seams.runAttempt(slot, model, actions.onProgressEvent),
      recordFailure: (model) => seams.recordEvidence({ modelId: model.id, profile, outcome: 'smoke-fail' }),
      recordSuccess: (model) => seams.recordEvidence({ modelId: model.id, profile, outcome: 'smoke-pass' }),
      onSelect: (model, info) => {
        // A DEMOTION is the ladder finding something smaller that runs here —
        // never the "strongest model for this device". It binds the slot being
        // set up (eco-fast), so a fallback can't be enshrined as the main model.
        const target: Slot = info.kind === 'demote' ? slot : firstPickSlot;
        // Demoting away from a chosen slot must not leave its pick behind:
        // setSlot flips a slot to 'preparing' the moment it binds, so an
        // abandoned deeper pick would sit there forever claiming to be on its
        // way. Release it instead — nothing downloaded, so nothing is owed.
        if (hasBound && boundSlot !== target) seams.setSlot(boundSlot, null);
        boundSlot = target;
        hasBound = true;
        seams.setSlot(target, model);
        if (info.kind === 'demote') actions.markFindingFit();
      },
    });
  } catch (err) {
    // No model can run on this device at all — recommend() throws
    // NoAssignableModelError (e.g. WebGPU adapter unavailable AND no viable
    // WASM tier). isBelowFloor only catches the low-memory subset, so route
    // the rest to the honest "coming to your device" surface instead of a
    // retry-promising error the user can never get past.
    if (err instanceof NoAssignableModelError) {
      actions.setBelowFloor('no-assignable-model');
      return;
    }
    seams.setSlotStatus(boundSlot, 'error');
    actions.setError(err instanceof Error ? err.message : 'Could not pick a model.');
    return;
  }

  // Status lands on the slot the winning model actually bound — the chosen
  // slot for a first-run pick, the setup slot for everything else.
  if (result.kind === 'ready') {
    seams.setSlotStatus(boundSlot, 'ready');
    actions.setReady(result.model);
  } else {
    seams.setSlotStatus(boundSlot, 'error');
    // How many models the ladder actually tried. On a one-model platform (iOS,
    // or an f16-less low-memory Android) that is exactly one, and the error
    // surface must not claim we "tried a few options".
    actions.setError(result.reason, {
      exhausted: true,
      triedModelCount: result.triedModelIds.length,
      // The exhausted `reason` is written copy, not the failure text, so this
      // code is the only thing left that knows WHY the ladder ran out.
      reasonCode: result.reasonCode,
    });
  }
}
