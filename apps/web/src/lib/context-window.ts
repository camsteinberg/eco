// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { ChatMessage } from "../stores/chatStore";

/**
 * Estimate token count for a string using the chars/4 heuristic.
 * No tokenizer dependency -- good enough for context budget management.
 */
export type TokenEstimator = (text: string) => number;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function countTokens(text: string, estimator?: TokenEstimator): number {
  return estimator ? Math.max(0, Math.ceil(estimator(text))) : estimateTokens(text);
}

export type ContextSelectionDiagnostics = {
  selectedCount: number;
  totalCount: number;
  truncatedCount: number;
  wasTruncated: boolean;
  modelContextLength: number;
  totalBudgetTokens: number;
  systemPromptTokens: number;
  selectedMessageTokens: number;
};

export type LocalContextSafetyDecision =
  | {
      ok: true;
      promptTokens: number;
      requestedNewTokens: number;
      totalTokens: number;
      safeBudgetTokens: number;
    }
  | {
      ok: false;
      reason: string;
      promptTokens: number;
      requestedNewTokens: number;
      totalTokens: number;
      safeBudgetTokens: number;
    };

/**
 * Eviction quantum, as a fraction of the history budget. When the window must
 * shrink, the start advances to the next quantum boundary rather than
 * minimally. A minimal slide moves the start on nearly every turn once a
 * conversation saturates its budget — and any start movement breaks the
 * strict-prefix KV-reuse gate (`runtime/kv-cache.ts`), forcing a full-context
 * reprefill (the worst TTFT) on every remaining turn. Quantized eviction keeps
 * the start fixed until the conversation outgrows the current quantum, so KV
 * reuse survives every turn between evictions, at the cost of up to ~one
 * quantum of unused history budget. The boundary is a pure function of stable
 * prefix sums, so consecutive turns recompute the same start with no state.
 */
const EVICTION_QUANTUM_FRACTION = 1 / 8;

/**
 * Select the most recent messages that fit within 75% of the model's context
 * window. System prompt tokens are deducted first (always included, outside
 * the history budget). Only complete user+assistant pairs are kept, and when
 * history must be evicted the cut advances in quantum steps (see
 * `EVICTION_QUANTUM_FRACTION`) so the window start — and with it KV-cache
 * reuse — stays stable between evictions.
 *
 * @param activeBranch - All messages in the current conversation branch
 * @param modelContextLength - Model's total context length in tokens
 * @param systemPrompt - Optional system prompt (always sent, deducted from budget)
 * @returns Subset of messages to send to the API, in original order (root-first)
 */
export function selectMessagesForContext(
  activeBranch: ChatMessage[],
  modelContextLength: number,
  systemPrompt?: string,
  options?: { estimateTokens?: TokenEstimator }
): ChatMessage[] {
  if (activeBranch.length === 0) return [];

  // Compute available token budget
  const totalBudget = Math.floor(modelContextLength * 0.75);
  const systemTokens = systemPrompt ? countTokens(systemPrompt, options?.estimateTokens) : 0;
  const historyBudget = Math.max(0, totalBudget - systemTokens);

  // Walk backward from the end, accumulating tokens.
  // Track indices of messages to include.
  let tokensUsed = 0;
  let startIndex = activeBranch.length; // exclusive start (will move backward)

  for (let i = activeBranch.length - 1; i >= 0; i--) {
    const msg = activeBranch[i]!;
    const msgTokens = countTokens(msg.content, options?.estimateTokens);

    if (tokensUsed + msgTokens > historyBudget && startIndex < activeBranch.length) {
      // This message would exceed budget and we already have at least one message
      break;
    }

    tokensUsed += msgTokens;
    startIndex = i;
  }

  // Quantize the eviction point: round the evicted-token count up to the next
  // quantum boundary and advance the start there. Evicting slightly more than
  // the minimum buys turns of start stability (KV reuse) before the next
  // eviction. Never advances past the final user turn — the last pair (or
  // trailing user message) survives, matching the minimal walk's guarantee.
  if (startIndex > 0 && startIndex < activeBranch.length) {
    const quantum = Math.max(1, Math.floor(historyBudget * EVICTION_QUANTUM_FRACTION));
    let evictedTokens = 0;
    for (let i = 0; i < startIndex; i++) {
      evictedTokens += countTokens(activeBranch[i]!.content, options?.estimateTokens);
    }
    const targetEvicted = Math.ceil(evictedTokens / quantum) * quantum;

    let lastUserIndex = activeBranch.length - 1;
    while (lastUserIndex > 0 && activeBranch[lastUserIndex]!.role !== "user") {
      lastUserIndex--;
    }

    while (startIndex < lastUserIndex && evictedTokens < targetEvicted) {
      evictedTokens += countTokens(activeBranch[startIndex]!.content, options?.estimateTokens);
      startIndex++;
    }
  }

  // Extract the selected slice
  let selected = activeBranch.slice(startIndex);

  // Drop orphaned assistant at the start (ensures complete pairs)
  if (selected.length > 0 && selected[0]!.role === "assistant") {
    selected = selected.slice(1);
  }

  // Guarantee at least the last user+assistant pair (or trailing user)
  if (selected.length === 0 && activeBranch.length > 0) {
    // Find the last user message and include everything from it to the end
    for (let i = activeBranch.length - 1; i >= 0; i--) {
      if (activeBranch[i]!.role === "user") {
        selected = activeBranch.slice(i);
        break;
      }
    }
    // If no user message found, just return the last message
    if (selected.length === 0) {
      selected = [activeBranch[activeBranch.length - 1]!];
    }
  }

  return selected;
}

export function getContextSelectionDiagnostics(
  activeBranch: ChatMessage[],
  selectedMessages: ChatMessage[],
  modelContextLength: number,
  systemPrompt?: string,
  options?: { estimateTokens?: TokenEstimator }
): ContextSelectionDiagnostics {
  const systemPromptTokens = systemPrompt ? countTokens(systemPrompt, options?.estimateTokens) : 0;
  const selectedMessageTokens = selectedMessages.reduce(
    (sum, message) => sum + countTokens(message.content, options?.estimateTokens),
    0,
  );
  const truncatedCount = Math.max(0, activeBranch.length - selectedMessages.length);

  return {
    selectedCount: selectedMessages.length,
    totalCount: activeBranch.length,
    truncatedCount,
    wasTruncated: truncatedCount > 0,
    modelContextLength,
    totalBudgetTokens: Math.floor(modelContextLength * 0.75),
    systemPromptTokens,
    selectedMessageTokens,
  };
}

/**
 * Floor for a degraded new-token grant. Below this a reply would be cut off
 * mid-thought, so the safety check is allowed to refuse instead.
 */
export const MIN_LOCAL_NEW_TOKENS = 256;

/**
 * Clamp a requested new-token budget to the context headroom left after the
 * prompt, so long conversations degrade to shorter replies instead of tripping
 * the context-safety refusal. Never raises the request; never grants below
 * `floor` (when the floor itself doesn't fit, `assessLocalContextSafety`
 * refuses — same terminal behavior as before, now strictly rarer).
 */
export function clampRequestedNewTokensForContext(
  messages: Array<{ content: string }>,
  systemPrompt: string,
  modelContextLength: number,
  requestedNewTokens: number,
  options?: { estimateTokens?: TokenEstimator; floor?: number },
): number {
  const floor = options?.floor ?? MIN_LOCAL_NEW_TOKENS;
  const systemPromptTokens = systemPrompt ? countTokens(systemPrompt, options?.estimateTokens) : 0;
  const promptTokens = messages.reduce(
    (sum, message) => sum + countTokens(message.content, options?.estimateTokens),
    systemPromptTokens,
  );
  const safeBudgetTokens = Math.floor(modelContextLength * 0.9);
  const headroom = safeBudgetTokens - promptTokens;
  return Math.max(Math.min(requestedNewTokens, headroom), Math.min(floor, requestedNewTokens));
}

export function assessLocalContextSafety(
  messages: Array<{ content: string }>,
  systemPrompt: string,
  modelContextLength: number,
  requestedNewTokens: number,
  options?: { estimateTokens?: TokenEstimator },
): LocalContextSafetyDecision {
  const systemPromptTokens = systemPrompt ? countTokens(systemPrompt, options?.estimateTokens) : 0;
  const promptTokens = messages.reduce(
    (sum, message) => sum + countTokens(message.content, options?.estimateTokens),
    systemPromptTokens,
  );
  const totalTokens = promptTokens + Math.max(0, requestedNewTokens);
  const safeBudgetTokens = Math.floor(modelContextLength * 0.9);

  if (totalTokens <= safeBudgetTokens) {
    return {
      ok: true,
      promptTokens,
      requestedNewTokens,
      totalTokens,
      safeBudgetTokens,
    };
  }

  return {
    ok: false,
    promptTokens,
    requestedNewTokens,
    totalTokens,
    safeBudgetTokens,
    reason:
      'This local model needs a shorter context before it can answer safely. Eco kept your draft here; trim the long chat or file, or ask for a shorter answer.',
  };
}

/**
 * Find the index in activeBranch where the context divider should appear.
 * The divider goes BEFORE the first selected message (between excluded and
 * included messages).
 *
 * @returns Index of the first in-context message, or -1 if all are in context
 */
export function findContextDividerIndex(
  activeBranch: ChatMessage[],
  selectedMessages: ChatMessage[]
): number {
  if (activeBranch.length === 0 || selectedMessages.length === 0) return -1;
  if (selectedMessages.length === activeBranch.length) return -1;

  // Find the first selected message's position in the full branch
  const firstSelectedId = selectedMessages[0]!.id;
  const index = activeBranch.findIndex((m) => m.id === firstSelectedId);
  return index >= 0 ? index : -1;
}
