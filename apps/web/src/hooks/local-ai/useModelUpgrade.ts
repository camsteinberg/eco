// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

/**
 * useModelUpgrade — the React driver for the in-place model pull.
 *
 * The composer's model selector is the whole surface: tapping a model whose
 * bytes aren't here confirms in the tile, and this driver runs everything after
 * that yes, out of the way of the conversation:
 *
 *   - request → background download (chat keeps working; the 2a lease split
 *     makes the download coexist with generation), progress on the tile
 *   - staged → a quiet "ready, switch now" on the tile. NOTHING swaps on its
 *     own, at boot or otherwise: the person picked the moment to download, so
 *     they pick the moment their model changes under them too
 *   - switch now → the audited swap, with its progress on the same tile
 *   - failure → honest, settled, and re-tappable; no terminal screens
 *
 * All UI state lives in a module store consumed via useSyncExternalStore,
 * so every mounted instance renders the same state, the boot flow runs
 * exactly once per page (immune to strict-mode double-effects and
 * remounts), and a background download outlives the panel that started it.
 * Cross-tab: the persisted record's storage events update passive UI; the
 * 'download' lease already guarantees only one tab transfers.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { ModelConfig, Slot } from '../../local-ai/types';
import { getModel } from '../../local-ai/catalog/catalog';
import type { SwitchProgressEvent } from '../../local-ai/lifecycle/switch-model';
import {
  UPGRADE_STORAGE_KEY,
  applyUpgradeEvent,
  performUpgradeSwap,
  readUpgradeRecord,
  reconcileUpgradeOnBoot,
  runUpgradeDownload,
  type UpgradeDeferral,
  type UpgradeRecord,
} from '../../local-ai/lifecycle/upgrade';
import { useChatStore } from '../../stores/chatStore';

// ─── UI state ───────────────────────────────────────────────────────────────

/**
 * What the tile for `target` should be showing. One cycle at a time, so at most
 * one tile is ever in a pull state; every other tile reads its own slot.
 */
export type ModelUpgradeUi =
  | { kind: 'hidden' }
  | { kind: 'downloading'; target: ModelConfig; slot: Slot; percent: number }
  | { kind: 'ready'; target: ModelConfig; slot: Slot; notice?: string }
  | { kind: 'swapping'; target: ModelConfig; slot: Slot; percent: number }
  | { kind: 'deferred'; target: ModelConfig; slot: Slot; deferral: UpgradeDeferral };

export type UseModelUpgradeOptions = {
  /** Gate — the machine only runs once the chat is ready on a local model. */
  enabled: boolean;
};

const HIDDEN: ModelUpgradeUi = { kind: 'hidden' };

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
// and boot-once flags. The durable pull state lives in localStorage
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

/** The record's target as a catalog model, when the catalog still carries it. */
function targetOf(record: UpgradeRecord): ModelConfig | null {
  return getModel(record.targetModelId);
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
    const target = targetOf(record);
    if (!target) return setUi(HIDDEN);
    if (record.phase === 'staged') {
      return setUi({ kind: 'ready', target, slot: record.targetSlot });
    }
    if (record.phase === 'deferred' && record.deferral) {
      return setUi({
        kind: 'deferred',
        target,
        slot: record.targetSlot,
        deferral: record.deferral,
      });
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
  if (!record) return;
  if (record.phase === 'staged') {
    // Staged bytes from a previous session: the affordance returns, the swap
    // does not happen behind the user's back.
    const target = targetOf(record);
    if (target) setUi({ kind: 'ready', target, slot: record.targetSlot });
    return;
  }
  if (record.phase === 'accepted' || record.phase === 'downloading') {
    // The user already asked for this in a prior session — resume the transfer.
    await startDownload(record);
  }
}

async function startDownload(record: UpgradeRecord): Promise<void> {
  const target = targetOf(record);
  if (!target) return;
  const slot = record.targetSlot;
  setUi({ kind: 'downloading', target, slot, percent: 0 });
  operationActive = true;
  try {
    const outcome = await runUpgradeDownload({
      onProgressEvent: (event) => {
        if (event.kind === 'progress' && event.phase === 'downloading') {
          setUi({ kind: 'downloading', target, slot, percent: event.percent });
        }
      },
    });
    switch (outcome.kind) {
      case 'staged':
        // Mid-session completion: ask before swapping — never yank the
        // model out from under a conversation.
        setUi({ kind: 'ready', target, slot });
        return;
      case 'deferred':
        setUi({ kind: 'deferred', target, slot, deferral: outcome.deferral });
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

async function userSwapNow(): Promise<void> {
  if (useChatStore.getState().isStreaming) return;
  const record = readUpgradeRecord();
  if (record?.phase !== 'staged') return;
  const target = targetOf(record);
  if (!target) return;
  const slot = record.targetSlot;
  // 'phase' events name the step (load, smoke); only the fractional ones move
  // the bar, on the same 0..1 scale the download reports.
  const onProgress = (event: SwitchProgressEvent): void => {
    if (event.kind === 'phase') return;
    setUi({ kind: 'swapping', target, slot, percent: event.fraction });
  };
  setUi({ kind: 'swapping', target, slot, percent: 0 });
  operationActive = true;
  try {
    let outcome = await performUpgradeSwap({ onProgress });
    if (outcome.kind === 'busy') {
      // One silent retry: a transient readiness/warmup collision usually
      // clears within a beat. Keep the calm swapping surface, wait, retry
      // once. A second busy is not transient — fall through to the manual
      // prompt below.
      await sleep(USER_SWAP_BUSY_RETRY_MS);
      outcome = await performUpgradeSwap({ onProgress });
    }
    switch (outcome.kind) {
      case 'swapped':
        // The tile now reads "Downloaded · Active" off the slot itself, so the
        // transient surface has nothing left to say.
        adoptSlot(slot);
        setUi(HIDDEN);
        return;
      case 'busy':
        setUi({ kind: 'ready', target, slot, notice: outcome.message });
        return;
      case 'failed':
        setUi({
          kind: 'ready',
          target,
          slot,
          notice: "That didn't go smoothly. Your current model is untouched.",
        });
        return;
      case 'deferred':
        setUi({ kind: 'deferred', target, slot, deferral: outcome.deferral });
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
 * Route chat to the slot that just took the new model. Explicit: the person
 * tapped this model in the selector and then tapped switch — the same deliberate
 * pick the selector records for a model that was already downloaded. The SLOT
 * name is what's stored, never the model id, so the selection can't outlive the
 * binding.
 */
function adoptSlot(slot: Slot): void {
  useChatStore.getState().setSelectedModel(slot, { persist: true, explicit: true });
}

// ─── Actions (module-level: the selector calls these without a driver) ───────

/**
 * Start a pull for `modelId` into `slot`, from the tile's inline confirm.
 *
 * Exported as a plain function on purpose: the tile that triggers it must not
 * mount a second driver (which would run a second boot flow), and the download
 * has to outlive the panel, which closes the moment it starts.
 */
export function requestModelPull(slot: Slot, modelId: string): void {
  const next = applyUpgradeEvent({ type: 'request', targetModelId: modelId, targetSlot: slot });
  // Refused: a different cycle is already mid-flight (single-record machine).
  if (next?.phase !== 'accepted' || next.targetModelId !== modelId) return;
  void startDownload(next);
}

/** Swap the staged model in now. Refused while a reply is streaming. */
export function swapPulledModelNow(): void {
  void userSwapNow();
}

// ─── The hook ───────────────────────────────────────────────────────────────

/**
 * Read-only subscription to the shared pull state. Unlike `useModelUpgrade`,
 * this NEVER drives the machine (no boot flow, no downloads) — it only reads the
 * module store. Surfaces that merely REFLECT progress (the model tiles, the
 * composer's evolving glyph) use this so they never mount a second driver; the
 * single driver stays `useChatPageEffects`.
 */
export function useModelUpgradeUi(): ModelUpgradeUi {
  return useSyncExternalStore(subscribeUi, getUiSnapshot, getServerSnapshot);
}

/**
 * Mount the single driver: reconcile the persisted record on boot and resume
 * anything the last session left running. Returns nothing — the surfaces read
 * `useModelUpgradeUi()` and call the module-level actions.
 */
export function useModelUpgrade(options: UseModelUpgradeOptions): void {
  useEffect(() => {
    if (!options.enabled) return;
    void ensureBootFlow();
  }, [options.enabled]);
}
