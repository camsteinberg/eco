// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Usage store — last-generation token counts for the v1.0 local-AI path.
 *
 * `runtime/lifecycle.generate()` emits a `done` event carrying
 * `promptTokens` and `completionTokens`. The legacy-shim adapter
 * captures the values here so `useChat` can read them after the stream
 * closes.
 *
 * Confidence is intentionally absent — the v1.0 catalog models don't
 * surface a confidence score. Consumers must handle null confidence (the
 * message field is already nullable in the chat store).
 *
 * SINGLETON CONSTRAINT: This module holds a single module-level
 * `lastUsage` value. It is correct for v1.0 because only one local
 * generation can run at a time (lifecycle singleton + lock + cooldown
 * enforce serial generation). If a future milestone adds parallel
 * browser-local chats, this becomes incorrect — the second generation
 * would overwrite the first's usage before useChat reads it. The
 * migration path is to thread usage through the `done` event as an
 * awaited value rather than a side-channel store.
 */

import type { CjkSuppressionTelemetry } from './cjk-suppression';
import type { KvReuseTelemetry } from './kv-cache';

export type LocalAiUsage = {
  promptTokens?: number;
  completionTokens?: number;
  /** Echoes the maxTokens that was requested for this generation. */
  maxTokens?: number;
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
};

let lastUsage: LocalAiUsage | null = null;

/**
 * The tokenizer/chat-template name reported by the adapter on the `done`
 * event. Stored alongside usage so `useChat` can thread it into the
 * generation receipt's `templateName` field for diagnostics.
 */
let lastTemplateName: string | null = null;

export function setLastUsage(usage: LocalAiUsage | null): void {
  lastUsage = usage;
}

export function getLastUsage(): LocalAiUsage | null {
  return lastUsage;
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

export function setLastTemplateName(name: string | null): void {
  lastTemplateName = name;
}

export function getLastTemplateName(): string | null {
  return lastTemplateName;
}

/** Test-only: reset between tests. */
export function _resetUsageStoreForTesting(): void {
  lastUsage = null;
  lastTemplateName = null;
}
