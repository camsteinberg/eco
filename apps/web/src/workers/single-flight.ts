// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { WorkerOutbound } from '../local-ai/runtime/transformers-adapter';

/**
 * RT-2 single-flight decision for the Transformers.js worker.
 *
 * The worker owns a singleton pipeline and a single set of KV-cache globals, so
 * only one generation may run at a time. Its message dispatcher is async: a 2nd
 * `generate` message can arrive while the first is parked on
 * `await model.generate(...)`. Letting it run would overwrite the shared abort
 * flag (leaving the first generation un-abortable) and race the KV-cache globals
 * — silent context corruption. This helper is the guard, split out into its own
 * module so it can be unit-tested without importing the worker (which pulls in
 * `@huggingface/transformers` and has no jsdom/WebGPU test context).
 *
 * Returns the error to post back for the incoming generate when one is already
 * in flight — tagged with the INCOMING generationId so the adapter routes the
 * rejection to the right request — or null when the worker is free to proceed.
 */
export function singleFlightRejection(
  inFlight: { generationId: string } | null,
  incomingGenerationId: string,
): Extract<WorkerOutbound, { type: 'error' }> | null {
  if (inFlight === null) return null;
  return {
    type: 'error',
    generationId: incomingGenerationId,
    code: 'generation-failed',
    message: 'A generation is already in progress on this worker.',
  };
}

/** The in-flight generation, as the worker's streaming callback reads it. */
export type InFlightGeneration = { generationId: string; aborted: boolean };

export type SlotAcquisition =
  | { ok: true; flag: InFlightGeneration }
  /** `rejection` is null when the incoming generation was itself stopped while waiting: nobody is reading it, so there is nothing to post. */
  | { ok: false; rejection: Extract<WorkerOutbound, { type: 'error' }> | null };

/**
 * The worker's one generation slot.
 *
 * A stopped generation does not end the moment its abort arrives: it ends at
 * its next decoded token (a prefill cannot be interrupted) and then drops its
 * KV cache, and the worker says nothing when it has finished. A person who
 * presses Stop and sends again at once — or a reply whose reader left part-way
 * — can therefore deliver the next `generate` while the slot is still held,
 * and a plain single-flight check rejects it. That is not a second generation
 * competing with the first, so it waits for the stopped one to let go, for at
 * most `settleMs`; a generation that is still running is rejected at once, as
 * before.
 *
 * Messages from the adapter arrive in the order they were posted and the
 * worker's dispatcher handles an `abort` without awaiting anything, so an abort
 * posted before the next `generate` has always been applied by the time that
 * `generate` asks for the slot.
 */
export class GenerationSlot {
  private inFlight: InFlightGeneration | null = null;
  private settled: Promise<void> | null = null;
  private settle: (() => void) | null = null;
  private readonly waiting = new Map<string, { aborted: boolean }>();

  get current(): InFlightGeneration | null {
    return this.inFlight;
  }

  /** Stop the running generation, or a waiting one, by id. Anything else is a no-op. */
  abort(generationId: string): void {
    if (this.inFlight?.generationId === generationId) {
      this.inFlight.aborted = true;
      return;
    }
    const waiter = this.waiting.get(generationId);
    if (waiter) waiter.aborted = true;
  }

  async acquire(generationId: string, settleMs: number): Promise<SlotAcquisition> {
    if (this.inFlight?.aborted && this.settled) {
      const waiter = { aborted: false };
      this.waiting.set(generationId, waiter);
      try {
        await settledWithin(this.settled, settleMs);
      } finally {
        this.waiting.delete(generationId);
      }
      if (waiter.aborted) return { ok: false, rejection: null };
    }
    const rejection = singleFlightRejection(this.inFlight, generationId);
    if (rejection) return { ok: false, rejection };
    const flag: InFlightGeneration = { generationId, aborted: false };
    this.inFlight = flag;
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    return { ok: true, flag };
  }

  /** The running generation has finished, however it ended. */
  release(): void {
    const settle = this.settle;
    this.inFlight = null;
    this.settled = null;
    this.settle = null;
    settle?.();
  }
}

/**
 * How long a stopped generation may take to let go before the next one is
 * rejected after all. It ends at its next token, so this only bites on a long
 * prefill or a wedged worker; it sits well inside the chat's 90-second wait for
 * a first token, so a rejection still reaches the person — and lets the
 * runtime replace the worker — before the chat gives up.
 */
export const ABORTED_GENERATION_SETTLE_MS = 30_000;

/** Resolve true when `settled` resolves, false if `ms` passes first. */
function settledWithin(settled: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  return Promise.race([settled.then(() => true), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
