// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Chat-side acquisition of the 'generation' runtime lease
 * (instant-start slice 2a).
 *
 * Holding this lease while a reply streams is what lets a model switch
 * (Settings today, the consent-driven upgrade swap in slice 2b) refuse to
 * unload the runtime mid-generation instead of corrupting it.
 *
 * Acquisition policy — chosen to preserve today's UX exactly:
 *
 *   - free → acquire immediately.
 *   - held by readiness/warmup → WAIT (bounded, abortable). Mount-time
 *     warmup holds 'readiness' for up to ~90s and users type immediately;
 *     before the lease those sends queued behind the lifecycle lock and
 *     succeeded, so failing fast here would be a regression. The chat UI
 *     already shows the honest "loading" phase during this window.
 *   - held by THIS tab's own 'generation' lease → WAIT. This is the
 *     abandoned-generation window: an interrupt (stop, conversation
 *     switch) flips the UI to idle synchronously, but the lease releases
 *     only when the aborted stream unwinds — and when a reply is left to
 *     finish in the background (navigating off /chat), the lease is held
 *     until it completes. Either way the holder is ours and releases on
 *     its own, so the send queues instead of bouncing with an error card.
 *   - held by anything else (switch-model, ANOTHER tab's generation,
 *     benchmark, unload) → fail fast with the honest busy copy — another
 *     tab's generation is unbounded from here and genuinely not ours to
 *     wait out.
 *   - user stop while waiting → `aborted: true`; the caller stays silent
 *     (the stop path already finalized the message).
 */

import {
  acquireLocalHeavyWork,
  describeLocalHeavyWorkBusy,
  isLocalHeavyWorkLeaseOwnedByThisContext,
  type LocalHeavyWorkKind,
} from '../../lib/local-heavy-work-owner';

/**
 * Wait budget: outlasts the longest waitable holder (the 90s mount-warmup
 * smoke) with a little slack, so a send during warmup waits it out rather
 * than erroring seconds before the runtime frees up.
 */
export const GENERATION_LEASE_WAIT_MS = 100_000;
const POLL_INTERVAL_MS = 250;

/** Holder kinds worth waiting for: transient prep that releases on its own. */
const WAITABLE_KINDS: ReadonlySet<LocalHeavyWorkKind> = new Set([
  'readiness',
  'warmup',
]);

export type GenerationLeaseAcquisition =
  | { ok: true; release: () => void }
  | { ok: false; aborted: boolean; message: string };

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

export async function acquireGenerationLease(options?: {
  signal?: AbortSignal;
  waitMs?: number;
}): Promise<GenerationLeaseAcquisition> {
  const waitMs = options?.waitMs ?? GENERATION_LEASE_WAIT_MS;
  const startedAt = Date.now();

  for (;;) {
    if (options?.signal?.aborted) {
      return { ok: false, aborted: true, message: '' };
    }

    const attempt = acquireLocalHeavyWork('generation');
    if (attempt.ok) {
      return { ok: true, release: attempt.release };
    }

    const holderKind = attempt.active?.kind;
    // A 'generation' holder is waitable only when it is OUR OWN lease —
    // the still-unwinding (or finishing-in-background) generation this tab
    // already abandoned. A foreign generation keeps the honest fail-fast.
    const waitable =
      holderKind != null &&
      (WAITABLE_KINDS.has(holderKind) ||
        (holderKind === 'generation' &&
          isLocalHeavyWorkLeaseOwnedByThisContext(attempt.active)));
    if (!waitable) {
      return {
        ok: false,
        aborted: false,
        message: describeLocalHeavyWorkBusy(attempt.active),
      };
    }
    if (Date.now() - startedAt >= waitMs) {
      return {
        ok: false,
        aborted: false,
        message: describeLocalHeavyWorkBusy(attempt.active),
      };
    }

    const slept = await abortableSleep(POLL_INTERVAL_MS, options?.signal);
    if (slept === 'aborted') {
      return { ok: false, aborted: true, message: '' };
    }
  }
}
