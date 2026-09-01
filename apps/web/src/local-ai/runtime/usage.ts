// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Token usage for one on-device generation — the shape, and the two pure
 * functions that read it.
 *
 * Until R4b this module was a `lastUsage` SINGLETON: the legacy stream shim
 * wrapped tokens in a `ReadableStream<string>`, which had nowhere to put usage,
 * so it wrote the terminating `done` event's counts here and `useChat` read
 * them back after the stream closed. That was correct only because exactly one
 * local generation can run at a time, and it was documented as needing to
 * become "usage threaded through the `done` event" the moment that changed.
 *
 * R4b made `useChat` consume `AsyncIterable<TokenEvent>` directly, so the
 * `done` event reaches the caller. The singleton is gone; what remains is the
 * type, the mapping off the event, and the ran-to-cap predicate.
 */

import type { CjkSuppressionTelemetry } from './cjk-suppression';
import type { ConfidenceSummary } from './confidence';
import type { KvReuseTelemetry } from './kv-cache';
import type { DoneEvent } from './stream';

export type LocalAiUsage = {
  /** Why the generation stopped: EOS, hit token cap, or externally aborted. */
  finishReason?: 'eos' | 'length' | 'abort';
  promptTokens?: number;
  completionTokens?: number;
  /** Echoes the maxTokens that was requested for this generation. */
  maxTokens?: number;
  /**
   * Where the history window the runtime sent starts, as an index into the
   * message array handed to `stream()`. The chat's context divider is drawn
   * from this — see `runtime/window.ts`.
   */
  windowStartIndex?: number;
  /**
   * KV-cache reuse telemetry from the transformers worker (absent on the
   * WebLLM path, which manages its own cache internally). Threaded into the
   * generation receipt so "did this turn reprefill, and why?" is answerable
   * from diagnostics.
   */
  kvReuse?: KvReuseTelemetry;
  /**
   * CJK-token suppression telemetry from the transformers worker (absent on
   * the WebLLM path). Threaded into the generation receipt so "was the CJK
   * guard active on this turn, and why not?" is answerable from diagnostics.
   */
  cjkSuppression?: CjkSuppressionTelemetry;
  /**
   * Largest gap between two consecutive streamed tokens, in ms (transformers
   * path; `null` when fewer than two tokens streamed). The #28 stall signature:
   * a large value with `completionTokens` at the cap is a decode stall filling
   * the budget, not a slow-but-steady generation. Threaded into the receipt.
   */
  maxInterTokenGapMs?: number | null;
  /**
   * Per-generation confidence summary (Transformers provides full entropy;
   * WebLLM provides chosen-token logprobs, entropy fields null). Measurement
   * only — does not gate or alter generation.
   */
  confidence?: ConfidenceSummary;
};

/**
 * Build the usage record for a finished generation.
 *
 * `maxTokens` is the budget the caller REQUESTED — the adapter reports what it
 * produced, not what it was allowed, so the echo has to come from the request
 * side. Everything else is the terminating `done` event verbatim. A generation
 * that ended without a `done` event (adapter stopped early) still records the
 * requested budget, so the downstream "possibly truncated" and ran-to-cap logic
 * has something to work with.
 */
export function usageFromDone(
  done: DoneEvent | null | undefined,
  maxTokens: number | undefined,
): LocalAiUsage {
  return {
    ...(done?.finishReason != null ? { finishReason: done.finishReason } : {}),
    ...(done?.promptTokens != null ? { promptTokens: done.promptTokens } : {}),
    ...(done?.completionTokens != null ? { completionTokens: done.completionTokens } : {}),
    ...(done?.windowStartIndex != null ? { windowStartIndex: done.windowStartIndex } : {}),
    ...(maxTokens != null ? { maxTokens } : {}),
    ...(done?.kvReuse != null ? { kvReuse: done.kvReuse } : {}),
    ...(done?.cjkSuppression != null ? { cjkSuppression: done.cjkSuppression } : {}),
    ...(done?.maxInterTokenGapMs !== undefined
      ? { maxInterTokenGapMs: done.maxInterTokenGapMs }
      : {}),
    ...(done?.confidence != null ? { confidence: done.confidence } : {}),
  };
}

/**
 * Did a generation stop by exhausting its token budget rather than emitting a
 * stop token? Exact `completionTokens >= maxTokens`, deliberately matching the
 * eval harness's `hitTokenCap` so a live receipt and a harness result read the
 * #28 "ran to cap" signal identically. Stricter than the truncation-UI heuristic
 * (`possiblyTruncated`, 0.95 * maxTokens). Returns false when either count is
 * unknown or the cap is non-positive.
 */
export function ranToCapFromUsage(usage: LocalAiUsage | null | undefined): boolean {
  return (
    usage?.completionTokens != null
    && usage.maxTokens != null
    && usage.maxTokens > 0
    && usage.completionTokens >= usage.maxTokens
  );
}
