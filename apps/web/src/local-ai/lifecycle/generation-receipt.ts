// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Generation receipt — in-memory forensic capture for local-AI diagnostics.
 *
 * After every local generation, callers record a receipt capturing what
 * template was used, which sampling profile applied, and token/timing
 * stats.  The diagnostics page (`/diagnostics/local-ai`) reads these to
 * give a one-click forensic answer when a generation produces unexpected
 * output.
 *
 * Privacy constraint: receipts live ONLY in module-scoped memory.  They
 * are never persisted to disk, never written to localStorage, and never
 * sent over the network.  A page reload clears them.
 */

import { logger } from '../../lib/logger';
import type { CjkSuppressionTelemetry } from '../runtime/cjk-suppression';
import type { KvReuseTelemetry } from '../runtime/kv-cache';
import type { LifecyclePhase } from '../runtime/types';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Which inference run inside a turn this receipt describes.
 *
 * Historically a turn could run two generations (primary + hard-constraint
 * repair). That repair path was removed in R1; each turn now runs exactly
 * one generation. The `'repair'` variant is retained for backward
 * compatibility with persisted receipts.
 */
export type GenerationRole = 'primary' | 'repair';

export interface GenerationReceipt {
  generationId: string;
  /**
   * Primary vs repair. Receipts for one turn share a `generationId` and are
   * recorded in execution order, so a turn's rows read primary-then-repair.
   */
  generationRole: GenerationRole;
  modelId: string;
  timestamp: number;
  templateName: string | null;
  systemPromptHash: string;
  samplingProfile: {
    temperature?: number;
    topP?: number;
    topK?: number;
    repetitionPenalty?: number;
    noRepeatNgramSize?: number;
    maxTokens?: number;
    intent?: string;
    /** Answer shape of the latest turn (Wave 2.6 — ⊥ task class). */
    answerShape?: string;
  };
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  status: 'complete' | 'aborted' | 'error';
  errorCode?: string;
  /**
   * KV-cache reuse telemetry for this generation (transformers worker only).
   * Answers "did this turn reprefill, and why?" — a multi-turn TTFT
   * regression with `decision: 'miss'` here is template/render-shaped; with
   * `cacheCommitted: false` it is the runtime not returning a cache.
   */
  kvReuse?: KvReuseTelemetry;
  /**
   * CJK-token suppression telemetry (transformers worker only). Answers
   * "was the deterministic CJK guard active on this turn?" — a CJK leak with
   * `applied: false` here points at the gate/scan, with `applied: true` at
   * a token the scan missed (e.g. byte-composed).
   */
  cjkSuppression?: CjkSuppressionTelemetry;
  /**
   * Ms from generation-stream start to the FIRST streamed token, or null when
   * no token arrived (error/aborted turns). This is where the first-message
   * latency defect is attributable: a large value alongside a nearby
   * `load-finish` breadcrumb points at cold-load; a large gap AFTER
   * `load-finish` points at the runtime's first decode.
   */
  firstTokenMs?: number | null;
  /**
   * Largest gap between two consecutive streamed tokens, in ms (transformers
   * path; `null` when fewer than two tokens streamed, absent on runtimes that
   * don't report it). The #28 stall signature: read alongside `ranToCap` — a
   * large gap with `ranToCap: true` is a decode stall filling the token budget,
   * distinct from a uniformly slow generation.
   */
  maxInterTokenGapMs?: number | null;
  /**
   * Whether generation stopped by exhausting its token budget
   * (`completionTokens >= samplingProfile.maxTokens`) rather than emitting a
   * stop token. Derived from usage — no new wire. A stall (#28) runs to the cap;
   * a natural completion does not. Absent when the budget or count is unknown.
   */
  ranToCap?: boolean;
  /**
   * Compact lifecycle breadcrumb trail for this turn — load + generation phases,
   * each `at` measured in ms from stream start. Timings and phase names only;
   * never message content.
   */
  events?: { at: number; phase: LifecyclePhase }[];
}

// ─── Constants ────────────────────────────────────────────────────────────

export const MAX_RECEIPTS = 50;

// ─── Module-private state ─────────────────────────────────────────────────

let receipts: GenerationReceipt[] = [];
let warnedMissingSubtle = false;
let pendingReceipts = 0;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Append a receipt to the in-memory ring buffer.
 *
 * When the buffer is full the oldest entry is silently evicted.
 * This function is synchronous — callers must pre-compute any async
 * fields (e.g. `systemPromptHash` via `hashSystemPrompt`).
 */
export function recordGenerationReceipt(receipt: GenerationReceipt): void {
  receipts.push(receipt);
  if (receipts.length > MAX_RECEIPTS) {
    receipts.shift();
  }
}

/**
 * Hash `systemPrompt`, then build and record the receipt.
 *
 * Recording is fire-and-forget: the caller must not be blocked on a hash, and
 * a diagnostics failure must never break a chat turn. `build` runs when the
 * hash resolves, so callers whose state changes in the meantime (a repair
 * reopens the generation scope mid-turn) must close over a snapshot rather
 * than live state.
 */
export function recordGenerationReceiptAsync(
  systemPrompt: string,
  build: (systemPromptHash: string) => GenerationReceipt,
): void {
  pendingReceipts++;
  hashSystemPrompt(systemPrompt)
    .then((systemPromptHash) => {
      recordGenerationReceipt(build(systemPromptHash));
    })
    .catch((err: unknown) => {
      if (process.env.NODE_ENV !== 'production') {
        logger.warn('[eco/receipt] failed to record', err);
      }
    })
    .finally(() => {
      pendingReceipts--;
    });
}

/**
 * How many receipts are mid-flight (hashed but not yet recorded).
 *
 * Exists so a measurement harness can wait for a turn's receipts to LAND
 * instead of racing them: reading the ring the instant a turn finalizes can
 * otherwise return the previous turn's row and silently measure the wrong
 * generation.
 */
export function pendingReceiptCount(): number {
  return pendingReceipts;
}

/**
 * Return recent receipts, newest first.
 *
 * @param limit  Maximum number of entries to return.  Defaults to all
 *               entries currently in the buffer.
 */
export function getRecentReceipts(limit?: number): GenerationReceipt[] {
  // Reverse a copy so callers always get newest-first without mutating state.
  const reversed = [...receipts].reverse();
  if (limit !== undefined && limit >= 0) {
    return reversed.slice(0, limit);
  }
  return reversed;
}

/** Remove all receipts from the buffer. */
export function clearGenerationReceipts(): void {
  receipts = [];
}

/**
 * Look up a single receipt by its generation ID, or `null` if not found.
 *
 * A repair turn records two receipts under the same `generationId`; this
 * returns the LAST one recorded, which is the generation whose output the user
 * actually saw. Callers needing the pair should filter `getRecentReceipts()`.
 */
export function getReceiptByGenerationId(
  generationId: string,
): GenerationReceipt | null {
  // Iterate backwards — callers are more likely to look up recent entries.
  for (let i = receipts.length - 1; i >= 0; i--) {
    const entry = receipts[i];
    if (entry !== undefined && entry.generationId === generationId) {
      return entry;
    }
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Hash a system prompt to a short stable hex string (first 8 chars of
 * SHA-256).  Uses Web Crypto (`crypto.subtle`) which is available in
 * browsers and web workers.
 *
 * Callers should invoke this before `recordGenerationReceipt` and pass
 * the result as `systemPromptHash`.
 */
export async function hashSystemPrompt(prompt: string): Promise<string> {
  const data = new TextEncoder().encode(prompt);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // Fallback for environments without Web Crypto (e.g. older Node
    // without --experimental-global-webcrypto).  Return a fixed marker
    // so callers never get an empty string.
    if (!warnedMissingSubtle) {
      logger.warn(
        "[eco/generation-receipt] crypto.subtle unavailable — systemPromptHash will be a fixed sentinel '00000000'",
      );
      warnedMissingSubtle = true;
    }
    return '00000000';
  }
  const hashBuffer = await subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < 4; i++) {
    const byte = hashArray[i];
    if (byte !== undefined) {
      hex += byte.toString(16).padStart(2, '0');
    }
  }
  return hex;
}

// ─── Test-only helpers ───────────────────────────────────────────────────

/** @internal Reset the warn-once flag. Exported only for test isolation. */
export function _resetWarnedMissingSubtle(): void {
  warnedMissingSubtle = false;
}
