// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Cross-tab GPU ownership for on-device inference.
 *
 * Only one browser tab may hold a model resident on the WebGPU device at a
 * time. Two tabs each initialising their own device is what triggers the
 * WebGPU device-loss crash cluster: when a second tab loads a model the
 * browser can reclaim the first tab's device, and — with no proactive
 * `device.lost` handler — the first tab only discovers the loss on its next
 * send, then cools the model down for five minutes.
 *
 * This module elects a single GPU-owning tab using the Web Locks API, which is
 * atomic across tabs (unlike the advisory, racy localStorage
 * `local-heavy-work-owner` lease that only serialises the *generation* call).
 * It reuses the existing `InferenceCoordinator` leader election — the class was
 * written for exactly this and was, until now, never wired in.
 *
 * Ownership is demand-driven and scoped to model residency, not to any React
 * component:
 *   - `runtime/lifecycle.loadModel` calls `acquireGpuOwnership()` just before
 *     it spawns a worker/device. `'blocked'` means another tab owns the GPU, so
 *     the load is refused with a recoverable `gpu-busy-other-tab` error instead
 *     of racing the other tab's device into oblivion.
 *   - `runtime/lifecycle.unloadActive` calls `releaseGpuOwnership()` so the GPU
 *     frees up the moment this tab has no model resident.
 *   - When the tab closes, the Web Lock is released automatically by the
 *     browser — no `beforeunload` handler required.
 *
 * A blocked tab stays queued for the lock; when the owner releases (closes or
 * unloads), this tab is promoted and every `subscribeGpuAvailable` listener
 * fires so the readiness layer can retry the load automatically.
 *
 * In environments without the Web Locks API (jsdom under test, older engines)
 * there is no cross-tab coordination to perform, so ownership is granted
 * immediately and synchronously — single-tab behaviour is unchanged.
 */

import { InferenceCoordinator } from '../../lib/inference-coordinator';

type AvailabilityListener = () => void;

let coordinator: InferenceCoordinator | null = null;
let owned = false;
const availabilityListeners = new Set<AvailabilityListener>();

function coordinationAvailable(): boolean {
  return (
    typeof navigator !== 'undefined'
    && !!(navigator as Navigator & { locks?: unknown }).locks
  );
}

function fireAvailable(): void {
  for (const listener of availabilityListeners) {
    listener();
  }
}

/**
 * Acquire GPU ownership for this tab.
 *
 * Resolves to `'owner'` when this tab may load a model, or `'blocked'` when
 * another tab holds the GPU. A blocked tab is promoted automatically once the
 * owner releases; register with `subscribeGpuAvailable` to retry on promotion.
 *
 * Idempotent: an already-owning tab (a model already resident, or a
 * mid-session model switch) resolves `'owner'` immediately without disturbing
 * the held lock.
 */
export async function acquireGpuOwnership(): Promise<'owner' | 'blocked'> {
  if (owned) {
    return 'owner';
  }

  if (!coordinationAvailable()) {
    // No cross-tab lock primitive — nothing to coordinate; grant immediately.
    owned = true;
    return 'owner';
  }

  if (coordinator) {
    // A prior acquire already elected this tab a follower and left it queued
    // for promotion; don't spin a second coordinator.
    return owned ? 'owner' : 'blocked';
  }

  let settle: ((role: 'owner' | 'blocked') => void) | null = null;
  const initialElection = new Promise<'owner' | 'blocked'>((resolve) => {
    settle = resolve;
  });
  let settled = false;

  const nextCoordinator = new InferenceCoordinator({
    onBecomeLeader: () => {
      owned = true;
      if (!settled) {
        settled = true;
        settle?.('owner');
      } else {
        // Promotion: the previous owner released. Wake the readiness layer.
        fireAvailable();
      }
    },
    onBecomeFollower: () => {
      owned = false;
      if (!settled) {
        settled = true;
        settle?.('blocked');
      }
    },
  });
  coordinator = nextCoordinator;

  // Fire-and-forget: `start()` resolves before its lock callback necessarily
  // runs, so we await the election callback (leader/follower) itself, which the
  // Web Locks `ifAvailable` request always invokes exactly once.
  void nextCoordinator.start();

  return initialElection;
}

/**
 * Release GPU ownership so another tab can load. Safe to call when not owned.
 */
export function releaseGpuOwnership(): void {
  if (coordinator) {
    coordinator.cleanup();
    coordinator = null;
  }
  owned = false;
}

/** Whether this tab currently owns the GPU. */
export function isGpuOwner(): boolean {
  return owned;
}

/**
 * Subscribe to be notified when this tab is promoted to GPU owner after having
 * been blocked (the previous owner released). Returns an unsubscribe function.
 */
export function subscribeGpuAvailable(listener: AvailabilityListener): () => void {
  availabilityListeners.add(listener);
  return () => {
    availabilityListeners.delete(listener);
  };
}

/**
 * Test-only reset of module state. Not part of the production surface.
 */
export function __resetGpuOwnershipForTests(): void {
  if (coordinator) {
    coordinator.cleanup();
    coordinator = null;
  }
  owned = false;
  availabilityListeners.clear();
}
