// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * History-window selection, on the runtime side, with REAL token counts.
 *
 * Until R5a the window was picked in `useChat` by a synchronous `chars/4` walk
 * (`lib/context-window.ts`), because the real tokenizer lives behind the worker
 * boundary and `useMemo` cannot await. Every reference system — llama.cpp,
 * Ollama, LM Studio, Jan, WebLLM, Chrome's Prompt API — counts with the model's
 * own tokenizer and evicts WHOLE messages oldest-first with the system prompt
 * pinned. Nobody estimates. This module is that shape: the adapter is loaded, so
 * `countTokens` is reachable, so the estimate is gone.
 *
 * The selection ALGORITHM is deliberately unchanged from the one it replaces —
 * pin system, walk backward over whole turns, quantize the eviction point, never
 * drop the final user turn. Only the counter changed. That keeps this slice's
 * observable movement attributable to "estimate → real count" and nothing else.
 */

import type { ChatMessage } from './types';

/**
 * Counts the tokens in `text` with the model's real tokenizer, or `null` when
 * this adapter has no tokenizer to ask (`RuntimeAdapter.countTokens`).
 */
export type TokenCounter = (text: string) => Promise<number | null>;

export type WindowInput = {
  /** The model's context window, in tokens. */
  contextTokens: number;
  /** Tokens reserved for the reply. Deducted from the context before history. */
  maxNewTokens: number;
  /** Absent (or returning null) means no tokenizer — see `upperBoundTokens`. */
  countTokens?: TokenCounter;
};

export type WindowSelection<T extends ChatMessage> = {
  /** The messages to generate from: the pinned system turn plus the window. */
  messages: T[];
  /**
   * Index, IN THE INPUT ARRAY, of the first conversation message that survived
   * eviction. The system turn is pinned and never counted, so a window that
   * evicted nothing reports 1 on a list that starts with a system turn (0 on
   * one that does not). Reported on the stream's `done` event so the context
   * divider is drawn from what the runtime actually sent.
   */
  windowStartIndex: number;
  /**
   * False when even the final user turn on its own does not fit the history
   * budget. The caller refuses rather than sending a prompt that cannot work —
   * the same terminal condition as WebLLM's `ContextWindowSizeExceededError`
   * and Chrome's `QuotaExceededError`.
   *
   * Always true when `countedWithTokenizer` is false: a refusal is a hard
   * terminal answer to the user, and the upper bound over-counts by design, so
   * refusing on it would refuse ordinary conversations. Eviction may run on the
   * bound (over-evicting is safe); refusal may not.
   */
  fits: boolean;
  /** Context minus the reply reserve minus the system turn. Diagnostics. */
  historyBudgetTokens: number;
  /** False when the fallback upper bound was used instead of a tokenizer. */
  countedWithTokenizer: boolean;
};

/**
 * The count used when the adapter has no tokenizer (LiteRT today: its
 * `countTokens` returns null unconditionally).
 *
 * This is NOT the estimate R5a deleted. `chars/4` is a heuristic that can
 * UNDER-count and overflow the window; one-token-per-character is a sound upper
 * bound — no tokenizer emits a token spanning zero characters — so a window
 * built on it can never overflow. It is conservative (it retains materially
 * less history than a real count would), which is the honest trade for an
 * adapter that cannot answer the question.
 */
function upperBoundTokens(text: string): number {
  return text.length;
}

/** Index of the last user turn, or -1. */
function lastUserIndex(messages: ReadonlyArray<ChatMessage>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return i;
  }
  return -1;
}

/**
 * Count every message. All-or-nothing: a counter that returns `null` (or
 * throws) for ANY message drops the whole selection to the upper bound, so a
 * window is never built from a mix of real counts and bounds — that mix would
 * be neither sound nor accurate.
 */
async function countAll(
  messages: ReadonlyArray<ChatMessage>,
  countTokens: TokenCounter | undefined,
): Promise<{ tokens: number[]; countedWithTokenizer: boolean }> {
  if (countTokens) {
    try {
      const counted = await Promise.all(messages.map((m) => countTokens(m.content)));
      if (counted.every((n): n is number => typeof n === 'number' && Number.isFinite(n))) {
        return { tokens: counted, countedWithTokenizer: true };
      }
    } catch {
      // Fall through to the bound: a tokenizer that failed is a tokenizer we
      // do not have for this turn, not a reason to refuse the turn.
    }
  }
  return { tokens: messages.map((m) => upperBoundTokens(m.content)), countedWithTokenizer: false };
}

/**
 * Pick the history window for one generation.
 *
 * Pins a leading system turn, keeps the newest whole turns that fit
 * `contextTokens − maxNewTokens − system`, evicts oldest-first in quantum
 * steps, drops an orphaned leading assistant turn so the window opens on a user
 * turn, and never evicts the final user turn (nor a trailing partial assistant
 * turn being continued).
 */
export async function selectWindow<T extends ChatMessage>(
  messages: ReadonlyArray<T>,
  input: WindowInput,
): Promise<WindowSelection<T>> {
  if (messages.length === 0) {
    return {
      messages: [],
      windowStartIndex: 0,
      fits: true,
      historyBudgetTokens: 0,
      countedWithTokenizer: false,
    };
  }

  const head = messages[0]!.role === 'system' ? 1 : 0;
  const system = head === 1 ? messages[0]! : null;
  const conversation = messages.slice(head);

  const { tokens, countedWithTokenizer } = await countAll(messages, input.countTokens);
  const systemTokens = head === 1 ? tokens[0]! : 0;
  const turnTokens = tokens.slice(head);

  const historyBudget = Math.max(0, input.contextTokens - input.maxNewTokens - systemTokens);

  if (conversation.length === 0) {
    return {
      messages: system ? [system] : [],
      windowStartIndex: head,
      fits: true,
      historyBudgetTokens: historyBudget,
      countedWithTokenizer,
    };
  }

  // Walk backward from the newest turn, accumulating whole messages until the
  // next one would not fit. At least one message is always kept.
  let tokensUsed = 0;
  let startIndex = conversation.length;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const messageTokens = turnTokens[i]!;
    if (tokensUsed + messageTokens > historyBudget && startIndex < conversation.length) break;
    tokensUsed += messageTokens;
    startIndex = i;
  }

  const lastUser = lastUserIndex(conversation);

  // Eviction is minimal and whole-message: the start is the oldest message
  // that still fits, nothing more is evicted. An earlier version rounded the
  // eviction point up to a "quantum" (an eighth of the budget) on the theory
  // that a minimally sliding start would break the strict-prefix KV-reuse gate
  // on nearly every turn once a chat saturates. Measured on the production
  // path (2026-09-01, Apple Silicon, LFM2.5-1.2B, a sixty-turn chat at a
  // 4,096 window, ten further turns per arm): the minimal arm missed the cache
  // once in nine post-warm turns, the quantized arm twice, first-token latency
  // on hits identical (~0.46–0.49 s). A message is far larger than a short
  // turn's growth, so whole-message eviction already holds the start still
  // for many turns; the quantum bought nothing and cost up to an eighth of
  // the history budget in unused window.

  let windowStart = startIndex;
  // Open the window on a user turn: a leading assistant reply with no question
  // above it reads as a fragment to the model and to the chat template.
  if (conversation[windowStart]!.role === 'assistant') windowStart++;
  if (windowStart >= conversation.length) {
    windowStart = lastUser >= 0 ? lastUser : conversation.length - 1;
  }

  // The turn that MUST fit: the final user turn plus anything after it (the
  // trailing partial assistant reply on the continue path).
  const requiredFrom = lastUser >= 0 ? lastUser : conversation.length - 1;
  let requiredTokens = 0;
  for (let i = requiredFrom; i < conversation.length; i++) requiredTokens += turnTokens[i]!;

  return {
    messages: [...(system ? [system] : []), ...conversation.slice(windowStart)],
    windowStartIndex: head + windowStart,
    fits: countedWithTokenizer ? requiredTokens <= historyBudget : true,
    historyBudgetTokens: historyBudget,
    countedWithTokenizer,
  };
}
