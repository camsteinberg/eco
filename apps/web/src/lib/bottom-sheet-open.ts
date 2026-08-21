// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * Is a bottom sheet open right now?
 *
 * A sheet is portalled onto `document.body` and covers the bottom of the
 * viewport, which is exactly where the floating chrome lives. The help disc sat
 * over the last tile's state line in the model sheet (the clearance under the
 * list is about 38px plus the safe area, against a 44px disc), and it shares a
 * z-index band with the cookie banner and the toast stack, so "which one wins"
 * was down to paint order rather than intent.
 *
 * Rather than teach each piece of floating chrome about each sheet, the sheet
 * publishes one fact and anything that would collide with it stands down while
 * it is open.
 *
 * A COUNTER, not a boolean: two sheets can be mounted at once (the navigation
 * drawer under a panel), and a boolean would be cleared by whichever closed
 * first while the other still covered the screen.
 *
 * Module store + `useSyncExternalStore`, the same shape the pull lifecycle uses:
 * the state belongs to the page, not to any one component, and it must survive
 * every consumer unmounting.
 *
 * Deliberately narrow: it reports whether a sheet is MOUNTED AND OPEN, not
 * whether CSS is currently showing it (a sheet is hidden from its breakpoint
 * up). The consumers are chrome that only exists to be tapped, so standing
 * down a moment too eagerly costs nothing.
 */

import { useSyncExternalStore } from "react";

let openCount = 0;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const onChange of subscribers) onChange();
}

/**
 * Declare a sheet open. Call the returned function when it closes or unmounts;
 * calling it twice is safe (the second call is a no-op), which matters because
 * React can run an effect's cleanup more than once in development.
 */
export function registerOpenBottomSheet(): () => void {
  openCount++;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount = Math.max(0, openCount - 1);
    notify();
  };
}

export function isAnyBottomSheetOpen(): boolean {
  return openCount > 0;
}

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => subscribers.delete(onChange);
}

/** Server render has no sheets: nothing has been opened yet. */
function getServerSnapshot(): boolean {
  return false;
}

/** Re-renders the caller whenever the last sheet closes or the first opens. */
export function useAnyBottomSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, isAnyBottomSheetOpen, getServerSnapshot);
}

/** Test-only: forget every open sheet and every subscriber. */
export function _resetBottomSheetOpenStateForTesting(): void {
  openCount = 0;
  subscribers.clear();
}
