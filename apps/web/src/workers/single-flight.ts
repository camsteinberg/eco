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
