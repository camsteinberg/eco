// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * GPU recovery — get the model back after the browser takes its WebGPU device
 * away while the page is in the background (a phone locked for a few minutes),
 * without the person meeting an error first.
 *
 * The runtime notices the loss (`RuntimeAdapter.deviceLost`, reported through
 * `subscribeDeviceLost`) and the lifecycle replaces a lost adapter on its next
 * load. This module decides WHEN to do that, and what to do when the page
 * cannot get a device at all:
 *
 *   - Never while hidden. A load started in the background that the OS then
 *     kills would read as a crash against the model (`load-breaker.ts`), for a
 *     load the person never asked for. Recovery waits for the page to be
 *     visible again.
 *   - The page can still get a WebGPU adapter → reload the model invisibly,
 *     the same way the mount-time warm-up does. A message sent meanwhile waits
 *     behind it (`acquireGenerationLease`) and is answered.
 *   - It cannot, or the runtime cannot use a new device in this page
 *     (`deviceLossNeedsPageReload`: LiteRT keeps one device per page) →
 *     reload the page, once. A fresh page gets a fresh adapter;
 *     the chat and the composer draft are already saved, and a turn the send
 *     path could not run is answered after the reload (`GPU_RECONNECT` in
 *     useChat).
 *
 * Reload-loop guard: an automatic reload records its time in sessionStorage
 * (per tab, survives the reload). Another one is refused for ten minutes,
 * unless a model has since loaded and answered (`clearGpuReloadGuard`). A page
 * that never had a device to lose never gets here: recovery needs a lost
 * adapter, and the send path needs `wasGpuLostThisPage()`.
 *
 * Nothing here leaves the device; both keys live in this tab's sessionStorage.
 */

import { getActiveAdapter, subscribeDeviceLost } from '../runtime/lifecycle';

const RELOAD_GUARD_KEY = 'eco-gpu-recovery-reload-v1';
const RETRY_MARKER_KEY = 'eco-gpu-recovery-retry-v1';
const RELOAD_GUARD_MS = 10 * 60 * 1000;

export type GpuRetryMarker = { conversationId: string; assistantId: string };

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type GpuRecoveryOptions = {
  /** Reload the selected model invisibly; resolves whether it answered. */
  warm: () => Promise<boolean>;
  /** A reply is in progress — the send path owns recovery then. */
  isBusy: () => boolean;
  /** Test seams. */
  probeAdapter?: () => Promise<boolean>;
  reload?: () => void;
};

function session(): SessionStorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Whether this page can get a WebGPU adapter right now. */
async function probeAdapter(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return false;
    // The preference WebLLM's own device request uses.
    return (await gpu.requestAdapter({ powerPreference: 'high-performance' })) !== null;
  } catch {
    return false;
  }
}

/**
 * Reload the page to get a fresh WebGPU adapter. Returns false (and does
 * nothing) when an automatic reload already ran recently in this tab. `retry`
 * names a turn to answer once the reloaded page is ready; the caller must have
 * saved the conversation first.
 */
export function reloadPageForGpu(
  options: { retry?: GpuRetryMarker; reload?: () => void; now?: number } = {},
): boolean {
  const storage = session();
  const now = options.now ?? Date.now();
  const last = Number(storage?.getItem(RELOAD_GUARD_KEY) ?? NaN);
  if (Number.isFinite(last) && now - last < RELOAD_GUARD_MS) return false;
  try {
    storage?.setItem(RELOAD_GUARD_KEY, String(now));
    if (options.retry) storage?.setItem(RETRY_MARKER_KEY, JSON.stringify(options.retry));
  } catch {
    // Without the guard a reload could repeat; refuse rather than risk a loop.
    return false;
  }
  (options.reload ?? (() => window.location.reload()))();
  return true;
}

/** A model loaded and answered: the next loss may reload the page again. */
export function clearGpuReloadGuard(): void {
  try {
    session()?.removeItem(RELOAD_GUARD_KEY);
  } catch {
    // Best-effort.
  }
}

/** The turn an automatic reload left to answer, if any. */
export function readGpuRetryMarker(): GpuRetryMarker | null {
  try {
    const raw = session()?.getItem(RETRY_MARKER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null
      && typeof (parsed as GpuRetryMarker).conversationId === 'string'
      && typeof (parsed as GpuRetryMarker).assistantId === 'string'
    ) {
      return parsed as GpuRetryMarker;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearGpuRetryMarker(): void {
  try {
    session()?.removeItem(RETRY_MARKER_KEY);
  } catch {
    // Best-effort.
  }
}

/**
 * Watch for a lost device and recover when the page is visible. Returns an
 * uninstall function.
 */
export function installGpuRecovery(options: GpuRecoveryOptions): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined;
  const probe = options.probeAdapter ?? probeAdapter;
  let running = false;

  const maybeRecover = async (): Promise<void> => {
    if (running || document.visibilityState !== 'visible') return;
    const adapter = getActiveAdapter();
    if (adapter?.deviceLost !== true || options.isBusy()) return;
    running = true;
    try {
      if (!adapter.deviceLossNeedsPageReload && (await probe())) {
        await options.warm();
      } else if (!options.isBusy()) {
        reloadPageForGpu({ ...(options.reload ? { reload: options.reload } : {}) });
      }
    } finally {
      running = false;
    }
  };
  const onChange = (): void => {
    void maybeRecover();
  };

  document.addEventListener('visibilitychange', onChange);
  window.addEventListener('pageshow', onChange);
  const unsubscribe = subscribeDeviceLost(onChange);
  return () => {
    document.removeEventListener('visibilitychange', onChange);
    window.removeEventListener('pageshow', onChange);
    unsubscribe();
  };
}
