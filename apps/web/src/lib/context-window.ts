// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { ChatMessage } from "../stores/chatStore";

/**
 * The refusal shown when a turn's prompt won't fit the local model's context
 * even after the new-token budget is clamped to the floor. Exported as a stable
 * constant so the error surface (`ErrorMessage`) can match it exactly and give
 * it an honest title instead of the generic "needs one quick setup" copy.
 *
 * Copy note: this message posts INTO the transcript as an assistant error — it
 * does not preserve anything in the composer, so it must not claim to have
 * "kept your draft." It states what happened and what the user can do next.
 */
export const CONTEXT_WINDOW_REFUSAL_MESSAGE =
  "This conversation has grown past what the local model can hold in context. Start a new chat to keep going, or try a shorter question.";

/**
 * Temporary per-message token counter (chars/4). R5 moves window selection
 * into the worker where the real tokenizer lives; until then this heuristic
 * drives the selection walk. Not exported — callers use the adapter's
 * `countTokens` for any result that leaves this module.
 */
function countMessageTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

export type ContextSelectionOptions = {
  /**
   * Maximum tokens the model will generate. Subtracted from the context
   * length to derive the history budget. Required for accurate windowing;
   * defaults to 512 (the adapter default) when omitted.
   */
  maxNewTokens?: number;
};

/**
 * The outcome of windowing a branch for the model.
 *
 * `windowStartId` is the identity of the first branch message that survived
 * BUDGET EVICTION — not simply the first entry of `messages`. The two differ,
 * and that difference is why the context divider needs this field instead of a
 * comparison between the branch and the selected array:
 *
 * - Empty assistant turns (errored / interrupted before the first token) are
 *   filtered out before selection, so `messages` is shorter than the branch
 *   even when nothing was evicted. A length comparison therefore reports
 *   phantom truncation on any conversation containing an error card.
 * - `coalesceConsecutiveUsers` merges adjacent user turns and keeps the LATER
 *   message's identity, so neither the length nor `messages[0].id` identifies
 *   the true window start once a merge lands at the head of the window.
 *
 * `null` means nothing was evicted — the whole branch is in context.
 */
export type ContextWindowSelection = {
  messages: ChatMessage[];
  windowStartId: string | null;
};

/**
 * Coalesce consecutive user turns created by empty-assistant removal.
 * Joins adjacent user contents with a blank line; keeps the later message's
 * metadata (id, parentId, timestamps) so branch navigation works correctly.
 *
 * NOTE: because the merged turn adopts the LATER message's id, this function's
 * output cannot be used to locate the window start in the original branch —
 * use `ContextWindowSelection.windowStartId` for that.
 *
 * @internal Exported for unit testing.
 */
export function coalesceConsecutiveUsers(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 1) return messages;
  const result: ChatMessage[] = [];
  for (const m of messages) {
    const prev = result.length > 0 ? result[result.length - 1]! : undefined;
    if (prev && prev.role === "user" && m.role === "user") {
      result[result.length - 1] = { ...m, content: `${prev.content}\n\n${m.content}` };
    } else {
      result.push(m);
    }
  }
  return result;
}

/**
 * Select the most recent messages that fit within the context headroom
 * (contextLength − maxNewTokens). System prompt tokens are deducted first
 * (always included, outside the history budget). Only complete user+assistant
 * pairs are kept, and when history must be evicted the cut advances in
 * quantum steps (see `EVICTION_QUANTUM_FRACTION`) so the window start — and
 * with it KV-cache reuse — stays stable between evictions.
 *
 * Empty assistant turns (errored / stopped before first token) are filtered
 * out before selection so they never replay to the model. If removal creates
 * adjacent user turns, they are coalesced to maintain strict user/assistant
 * alternation (the chat template layer does NOT merge consecutive user roles).
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
  options?: ContextSelectionOptions,
): ChatMessage[] {
  return selectContextWindow(activeBranch, modelContextLength, systemPrompt, options).messages;
}

/**
 * `selectMessagesForContext` plus the identity of the first message that
 * survived budget eviction (see `ContextWindowSelection`). Callers that only
 * need the prompt should use `selectMessagesForContext`; the context divider
 * needs the window start.
 */
export function selectContextWindow(
  activeBranch: ChatMessage[],
  modelContextLength: number,
  systemPrompt?: string,
  options?: ContextSelectionOptions,
): ContextWindowSelection {
  const empty: ContextWindowSelection = { messages: [], windowStartId: null };
  if (activeBranch.length === 0) return empty;

  // CS-3: filter out assistant messages with empty content. Errored turns write
  // {status:'error', content:''} and stop-before-first-token writes
  // {status:'complete', content:''}; replaying them as empty assistant turns
  // confuses the model and wastes context.
  const cleaned = activeBranch.filter(
    (m) => m.role !== "assistant" || m.content.trim().length > 0,
  );
  if (cleaned.length === 0) return empty;

  // Compute available token budget: full context minus the generation reserve.
  const totalBudget = modelContextLength - (options?.maxNewTokens ?? 512);
  const systemTokens = systemPrompt ? countMessageTokens(systemPrompt) : 0;
  const historyBudget = Math.max(0, totalBudget - systemTokens);

  // Walk backward from the end, accumulating tokens.
  // Track indices of messages to include.
  let tokensUsed = 0;
  let startIndex = cleaned.length; // exclusive start (will move backward)

  for (let i = cleaned.length - 1; i >= 0; i--) {
    const msg = cleaned[i]!;
    const msgTokens = countMessageTokens(msg.content);

    if (tokensUsed + msgTokens > historyBudget && startIndex < cleaned.length) {
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
  if (startIndex > 0 && startIndex < cleaned.length) {
    const quantum = Math.max(1, Math.floor(historyBudget * EVICTION_QUANTUM_FRACTION));
    let evictedTokens = 0;
    for (let i = 0; i < startIndex; i++) {
      evictedTokens += countMessageTokens(cleaned[i]!.content);
    }
    const targetEvicted = Math.ceil(evictedTokens / quantum) * quantum;

    let lastUserIndex = cleaned.length - 1;
    while (lastUserIndex > 0 && cleaned[lastUserIndex]!.role !== "user") {
      lastUserIndex--;
    }

    while (startIndex < lastUserIndex && evictedTokens < targetEvicted) {
      evictedTokens += countMessageTokens(cleaned[startIndex]!.content);
      startIndex++;
    }
  }

  // Track the window start as an index into `cleaned` (never as a slice) so the
  // true first in-context message can be reported back for the divider.
  let windowStart = startIndex;

  // Drop orphaned assistant at the start (ensures complete pairs)
  if (cleaned[windowStart]!.role === "assistant") {
    windowStart++;
  }

  // Guarantee at least the last user+assistant pair (or trailing user)
  if (windowStart >= cleaned.length) {
    let lastUserIndex = -1;
    for (let i = cleaned.length - 1; i >= 0; i--) {
      if (cleaned[i]!.role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    // If no user message found, just return the last message
    windowStart = lastUserIndex >= 0 ? lastUserIndex : cleaned.length - 1;
  }

  // CS-3: coalesce consecutive user turns that may result from filtering out
  // empty assistant turns. The chat template layer (normalizeMessagesForTemplate)
  // does NOT merge consecutive user roles — it only handles system-role
  // normalization — so apply_chat_template would receive malformed alternation.
  return {
    messages: coalesceConsecutiveUsers(cleaned.slice(windowStart)),
    // Everything before `windowStart` was dropped by the token budget (or by
    // the complete-pair rule) — genuine truncation the user should be told
    // about. A window starting at the first surviving message evicted nothing,
    // however many empty assistant turns the filter removed along the way.
    windowStartId: windowStart > 0 ? cleaned[windowStart]!.id : null,
  };
}

/**
 * Token-pressure diagnostics for a selection.
 *
 * `truncatedCount` / `wasTruncated` are a raw array-length difference, so they
 * count every message the selection dropped for ANY reason — budget eviction,
 * empty-assistant filtering (CS-3) and user coalescing alike. They are a
 * pressure signal, NOT an answer to "did history fall out of context?"; a
 * conversation with a single error card reports `wasTruncated: true` while
 * holding its entire history. Use `ContextWindowSelection.windowStartId` (via
 * `findContextDividerIndex`) for anything user-facing.
 */
export function getContextSelectionDiagnostics(
  activeBranch: ChatMessage[],
  selectedMessages: ChatMessage[],
  modelContextLength: number,
  systemPrompt?: string,
  options?: { maxNewTokens?: number },
): ContextSelectionDiagnostics {
  const systemPromptTokens = systemPrompt ? countMessageTokens(systemPrompt) : 0;
  const selectedMessageTokens = selectedMessages.reduce(
    (sum, message) => sum + countMessageTokens(message.content),
    0,
  );
  const truncatedCount = Math.max(0, activeBranch.length - selectedMessages.length);

  return {
    selectedCount: selectedMessages.length,
    totalCount: activeBranch.length,
    truncatedCount,
    wasTruncated: truncatedCount > 0,
    modelContextLength,
    totalBudgetTokens: modelContextLength - (options?.maxNewTokens ?? 512),
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
  options?: { floor?: number },
): number {
  const floor = options?.floor ?? MIN_LOCAL_NEW_TOKENS;
  const systemPromptTokens = systemPrompt ? countMessageTokens(systemPrompt) : 0;
  const promptTokens = messages.reduce(
    (sum, message) => sum + countMessageTokens(message.content),
    systemPromptTokens,
  );
  const headroom = modelContextLength - promptTokens;
  return Math.max(Math.min(requestedNewTokens, headroom), Math.min(floor, requestedNewTokens));
}

export function assessLocalContextSafety(
  messages: Array<{ content: string }>,
  systemPrompt: string,
  modelContextLength: number,
  requestedNewTokens: number,
): LocalContextSafetyDecision {
  const systemPromptTokens = systemPrompt ? countMessageTokens(systemPrompt) : 0;
  const promptTokens = messages.reduce(
    (sum, message) => sum + countMessageTokens(message.content),
    systemPromptTokens,
  );
  const totalTokens = promptTokens + Math.max(0, requestedNewTokens);
  const safeBudgetTokens = modelContextLength;

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
    reason: CONTEXT_WINDOW_REFUSAL_MESSAGE,
  };
}

/**
 * Find the index in activeBranch where the context divider should appear.
 * The divider goes BEFORE the first in-context message (between evicted and
 * retained messages).
 *
 * Takes the selection rather than the selected array because only the
 * selection knows which messages the BUDGET evicted: empty-assistant filtering
 * and user coalescing both shrink the array and rewrite head identity without
 * anything having left the context. See `ContextWindowSelection`.
 *
 * @returns Index of the first in-context message, or -1 if all are in context
 */
export function findContextDividerIndex(
  activeBranch: ChatMessage[],
  selection: ContextWindowSelection,
): number {
  if (activeBranch.length === 0 || selection.windowStartId === null) return -1;
  const index = activeBranch.findIndex((m) => m.id === selection.windowStartId);
  return index > 0 ? index : -1;
}
