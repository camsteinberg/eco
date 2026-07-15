// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

/**
 * useModelUpgrade — the React driver for the consent-driven upgrade
 * (instant-start slice 2b, Stage B).
 *
 * Mounted beside useLocalModelReadiness and enabled only once the chat is
 * ready on the starter. Owns the session orchestration of
 * `lifecycle/upgrade.ts`:
 *
 *   - fresh session → offer popup ("a stronger model is available") — the
 *     only path that ever STARTS a heavy download is the user accepting it
 *   - accept → background download (chat keeps working; the 2a lease split
 *     makes the download coexist with generation) → inline "ready — switch
 *     now?" prompt. The swap itself asks first, never mid-generation
 *   - boot with a staged+verified upgrade → swap silently and greet with a
 *     boost note (the user already consented; asking twice is nagging)
 *   - decline / failure → quiet, honest, settled — no terminal screens
 *
 * All UI state lives in a module store consumed via useSyncExternalStore,
 * so every mounted instance renders the same state, the boot flow runs
 * exactly once per page (immune to strict-mode double-effects and
 * remounts), and a background download outlives the surface that
 * started it. Cross-tab: the persisted record's storage events update
 * passive UI; the 'download' lease already guarantees only one tab
 * transfers.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { ModelConfig } from '../../local-ai/types';
import { getModel } from '../../local-ai/catalog/catalog';
import { getDeviceProfile } from '../../local-ai/device/profile';
import { getSlot } from '../../local-ai/lifecycle/slots';
import {
  UPGRADE_STORAGE_KEY,
  applyUpgradeEvent,
  performUpgradeSwap,
  planUpgradeOffer,
  readUpgradeRecord,
  reconcileUpgradeOnBoot,
  runUpgradeDownload,
  type UpgradeDeferral,
  type UpgradeRecord,
} from '../../local-ai/lifecycle/upgrade';
import { useChatStore } from '../../stores/chatStore';

// ─── UI state ───────────────────────────────────────────────────────────────

export type ModelUpgradeUi =
  | { kind: 'hidden' }
  | { kind: 'offer'; target: ModelConfig }
  | { kind: 'downloading'; target: ModelConfig; percent: number }
  | { kind: 'ready'; target: ModelConfig; notice?: string }
  | { kind: 'swapping'; target: ModelConfig; atBoot: boolean }
  | { kind: 'boosted'; target: ModelConfig; atBoot: boolean }
  | { kind: 'deferred'; deferral: UpgradeDeferral };

export type UseModelUpgradeOptions = {
  /** Gate — the machine only runs once the chat is ready on a local model. */
  enabled: boolean;
};

export type UseModelUpgradeReturn = {
  ui: ModelUpgradeUi;
  /** Consent to the background download (from the offer popup). */
  accept(): void;
  /** Settle the cycle — remembered, never re-asked for this target. */
  decline(): void;
  /** Dismiss the ready prompt; the staged model boots next session. */
  notNow(): void;
  /** Swap the staged model in now (disabled while a reply is streaming). */
  swapNow(): void;
  /** Dismiss a transient note (boosted / deferred). */
  dismiss(): void;
};

const HIDDEN: ModelUpgradeUi = { kind: 'hidden' };

/** Delay between boot-swap retries while the runtime lease is held. */
const BOOT_SWAP_RETRY_MS = 3_000;
/** Boot-swap retry budget (~1 min — outlasts a mount warmup, not a hang). */
const BOOT_SWAP_MAX_TRIES = 20;
/**
 * A manual "switch now" that lands on a transient busy (a readiness check or
 * warmup holding the runtime for a beat) gets exactly ONE silent retry after
 * this delay before falling back to the manual "Try again" prompt — the same
 * "don't surface a busy that would have cleared on its own" affordance the
 * Settings switch dialog has. Busy self-refunds its swap attempt, so the
 * retry never burns one of MAX_SWAP_ATTEMPTS.
 */
const USER_SWAP_BUSY_RETRY_MS = 3_000;

// ─── Module store ───────────────────────────────────────────────────────────

// Lifetime is intentionally per-page-load: this store only holds transient UI
// and boot-once flags. The durable upgrade state lives in localStorage
// (`eco-local-ai-upgrade-v1`), so a fresh load reconciles from there — no
// production reset (e.g. on sign-out) is needed; only tests reset it.
let currentUi: ModelUpgradeUi = HIDDEN;
const uiSubscribers = new Set<() => void>();
let bootStarted = false;
let storageListenerAttached = false;
/** True while THIS tab is actively driving a download/swap. */
let operationActive = false;

function setUi(ui: ModelUpgradeUi): void {
  currentUi = ui;
  for (const notifyChange of uiSubscribers) notifyChange();
}

function subscribeUi(onChange: () => void): () => void {
  uiSubscribers.add(onChange);
  return () => uiSubscribers.delete(onChange);
}

function getUiSnapshot(): ModelUpgradeUi {
  return currentUi;
}

function getServerSnapshot(): ModelUpgradeUi {
  return HIDDEN;
}

/** Test-only: reset the module store between tests. */
export function _resetModelUpgradeForTesting(): void {
  currentUi = HIDDEN;
  uiSubscribers.clear();
  bootStarted = false;
  storageListenerAttached = false;
  operationActive = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Cross-tab passive sync ─────────────────────────────────────────────────

function attachStorageListener(): void {
  if (storageListenerAttached || typeof window === 'undefined') return;
  storageListenerAttached = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== UPGRADE_STORAGE_KEY) return;
    // Another tab moved the machine. If this tab is mid-operation its own
    // outcome handling wins; otherwise reflect the new phase passively.
    if (operationActive) return;
    const record = readUpgradeRecord();
    if (!record) return setUi(HIDDEN);
    if (record.phase === 'staged') {
      const target = getModel(record.targetModelId);
      if (target) setUi({ kind: 'ready', target });
      return;
    }
    if (record.phase === 'deferred' && record.deferral) {
      return setUi({ kind: 'deferred', deferral: record.deferral });
    }
    setUi(HIDDEN);
  });
}

// ─── Drivers ────────────────────────────────────────────────────────────────

async function ensureBootFlow(): Promise<void> {
  if (bootStarted) return;
  bootStarted = true;
  attachStorageListener();

  const record = reconcileUpgradeOnBoot();
  if (record?.phase === 'staged') {
    await bootSwap(record);
    return;
  }
  if (record?.phase === 'accepted' || record?.phase === 'downloading') {
    // The user already consented in a prior session — resume the transfer.
    await startDownload(record);
    return;
  }
  // Everything else (idle, an undecided offered record, or a settled cycle
  // whose target may since have moved) funnels through offer eligibility.
  await maybeOffer();
}

async function maybeOffer(): Promise<void> {
  const fast = getSlot('eco-fast');
  const smart = getSlot('eco-smart');
  const target = await planUpgradeOffer({
    profile: getDeviceProfile(),
    currentModelId: fast.modelId,
    ecoSmartReadyModelId: smart.status === 'ready' ? smart.modelId : null,
    record: readUpgradeRecord(),
  });
  if (!target) return;
  applyUpgradeEvent({ type: 'offer', targetModelId: target.id, baseModelId: fast.modelId });
  setUi({ kind: 'offer', target });
}

async function startDownload(record: UpgradeRecord): Promise<void> {
  const target = getModel(record.targetModelId);
  if (!target) return;
  setUi({ kind: 'downloading', target, percent: 0 });
  operationActive = true;
  try {
    const outcome = await runUpgradeDownload({
      onProgressEvent: (event) => {
        if (event.kind === 'progress' && event.phase === 'downloading') {
          setUi({ kind: 'downloading', target, percent: event.percent });
        }
      },
    });
    switch (outcome.kind) {
      case 'staged':
        // Mid-session completion: ask before swapping — never yank the
        // model out from under a conversation.
        setUi({ kind: 'ready', target });
        return;
      case 'deferred':
        setUi({ kind: 'deferred', deferral: outcome.deferral });
        return;
      default:
        // busy (another tab transfers — its storage event will surface
        // 'ready' here), aborted, or a phase race: nothing to show.
        setUi(HIDDEN);
    }
  } finally {
    operationActive = false;
  }
}

async function bootSwap(record: UpgradeRecord): Promise<void> {
  const target = getModel(record.targetModelId);
  if (!target) return;
  setUi({ kind: 'swapping', target, atBoot: true });
  operationActive = true;
  try {
    for (let attempt = 0; attempt < BOOT_SWAP_MAX_TRIES; attempt++) {
      const outcome = await performUpgradeSwap();
      if (outcome.kind === 'busy') {
        // Typically the tail of a mount warmup — wait it out briefly.
        await sleep(BOOT_SWAP_RETRY_MS);
        continue;
      }
      if (outcome.kind === 'swapped') {
        adoptEcoSmart();
        setUi({ kind: 'boosted', target, atBoot: true });
      } else if (outcome.kind === 'reverted-to-download') {
        const current = readUpgradeRecord();
        if (current) {
          operationActive = false;
          await startDownload(current);
        }
      } else if (outcome.kind === 'deferred') {
        setUi({ kind: 'deferred', deferral: outcome.deferral });
      } else {
        // 'failed' (one attempt left) or a phase race: stay silent — the
        // starter keeps working and the next boot retries within the cap.
        setUi(HIDDEN);
      }
      return;
    }
    // Retry budget spent with the runtime still busy — leave the record
    // staged; the next boot (or a manual swap) picks it up.
    setUi(HIDDEN);
  } finally {
    operationActive = false;
  }
}

async function userSwapNow(): Promise<void> {
  if (useChatStore.getState().isStreaming) return;
  const record = readUpgradeRecord();
  if (record?.phase !== 'staged') return;
  const target = getModel(record.targetModelId);
  if (!target) return;
  setUi({ kind: 'swapping', target, atBoot: false });
  operationActive = true;
  try {
    let outcome = await performUpgradeSwap();
    if (outcome.kind === 'busy') {
      // One silent retry: a transient readiness/warmup collision usually
      // clears within a beat. Keep the calm swapping surface, wait, retry
      // once. A second busy is not transient — fall through to the manual
      // prompt below.
      await sleep(USER_SWAP_BUSY_RETRY_MS);
      outcome = await performUpgradeSwap();
    }
    switch (outcome.kind) {
      case 'swapped':
        adoptEcoSmart();
        setUi({ kind: 'boosted', target, atBoot: false });
        return;
      case 'busy':
        setUi({ kind: 'ready', target, notice: outcome.message });
        return;
      case 'failed':
        setUi({
          kind: 'ready',
          target,
          notice: "That didn't go smoothly — your current model is untouched. Try again?",
        });
        return;
      case 'deferred':
        setUi({ kind: 'deferred', deferral: outcome.deferral });
        return;
      case 'reverted-to-download': {
        const current = readUpgradeRecord();
        if (current) {
          operationActive = false;
          await startDownload(current);
        }
        return;
      }
      default:
        setUi(HIDDEN);
    }
  } finally {
    operationActive = false;
  }
}

/**
 * Route chat to the upgraded slot. Non-explicit so future device-appropriate
 * default graduations can still move this selection; slot names survive
 * reload via the persisted-selection loader's slot branch.
 */
function adoptEcoSmart(): void {
  useChatStore.getState().setSelectedModel('eco-smart', { persist: true, explicit: false });
}

function userAccept(): void {
  const next = applyUpgradeEvent({ type: 'accept' });
  if (next?.phase === 'accepted') void startDownload(next);
}

function userDecline(): void {
  applyUpgradeEvent({ type: 'decline' });
  setUi(HIDDEN);
}

function userNotNow(): void {
  // The staged record stays — the next session boots on the better model.
  setUi(HIDDEN);
}

function userDismiss(): void {
  setUi(HIDDEN);
}

// ─── The hook ───────────────────────────────────────────────────────────────

/**
 * Read-only subscription to the shared upgrade UI state. Unlike
 * `useModelUpgrade`, this NEVER drives the upgrade machine (no boot flow, no
 * downloads) — it only reads the module store. Surfaces that merely REFLECT
 * upgrade progress (e.g. the composer's evolving glyph) use this so they never
 * mount a second driver; the single driver stays `useChatPageEffects`.
 */
export function useModelUpgradeUi(): ModelUpgradeUi {
  return useSyncExternalStore(subscribeUi, getUiSnapshot, getServerSnapshot);
}

export function useModelUpgrade(options: UseModelUpgradeOptions): UseModelUpgradeReturn {
  const ui = useSyncExternalStore(subscribeUi, getUiSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!options.enabled) return;
    void ensureBootFlow();
  }, [options.enabled]);

  return {
    ui,
    accept: userAccept,
    decline: userDecline,
    notNow: userNotNow,
    swapNow: () => {
      void userSwapNow();
    },
    dismiss: userDismiss,
  };
}
