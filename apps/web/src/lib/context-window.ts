// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * What the CLIENT still does about the context window, now that the window
 * itself is picked by the runtime.
 *
 * Before R5a this file held a synchronous `chars/4` selection walk, a
 * pre-flight "clamp the reply budget, then refuse" ladder, and the diagnostics
 * that read the same estimate. All of it is gone: `local-ai/runtime/window.ts`
 * picks the window with the model's real tokenizer once the adapter is loaded,
 * and reports where it starts on the stream's `done` event.
 *
 * What genuinely belongs on the client survives here — branch hygiene that
 * depends on stored-message identity (which the runtime never sees), the
 * user-facing refusal copy, and the divider lookup.
 */

import type { ChatMessage } from "../stores/chatStore";

/**
 * The refusal shown when a turn's prompt won't fit the local model's context.
 * Exported as a stable constant so the error surface (`ErrorMessage`) can match
 * it exactly and give it an honest title instead of the generic "needs one
 * quick setup" copy.
 *
 * Raised by `runtime/stream.ts` when even the final user turn alone does not
 * fit the history budget — the same terminal condition WebLLM
 * (`ContextWindowSizeExceededError`) and Chrome's Prompt API
 * (`QuotaExceededError`) raise. Before R5a a pre-flight estimate refused
 * earlier and more often.
 *
 * Copy note: this message posts INTO the transcript as an assistant error — it
 * does not preserve anything in the composer, so it must not claim to have
 * "kept your draft." It states what happened and what the user can do next.
 */
export const CONTEXT_WINDOW_REFUSAL_MESSAGE =
  "This conversation has grown past what the local model can hold in context. Start a new chat to keep going, or try a shorter question.";

/**
 * Coalesce consecutive user turns created by empty-assistant removal.
 * Joins adjacent user contents with a blank line; keeps the later message's
 * metadata (id, parentId, timestamps) so branch navigation works correctly.
 *
 * NOTE: because the merged turn adopts the LATER message's id, this function's
 * output cannot be used to locate the window start in the original branch —
 * `prepareBranchForPrompt` carries the EARLIEST merged id in its `sourceIds`
 * for exactly that reason.
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
 * A branch cleaned up for the model, plus the map back to the stored branch.
 *
 * `sourceIds[i]` is the id of the EARLIEST stored message that contributed to
 * `messages[i]`. That is what makes a runtime-reported `windowStartIndex`
 * resolvable to a real message in the transcript: both of the transforms below
 * change indices, and coalescing rewrites head identity.
 */
export type PreparedBranch = {
  messages: ChatMessage[];
  sourceIds: string[];
};

/**
 * Clean a branch up before it is assembled into a prompt.
 *
 * Two transforms, both about stored-message identity rather than token budget,
 * which is why they stayed on the client when selection moved into the worker:
 *
 * - CS-3: drop assistant messages with empty content. Errored turns write
 *   `{status:'error', content:''}` and stop-before-first-token writes
 *   `{status:'complete', content:''}`; replaying them as empty assistant turns
 *   confuses the model and wastes context.
 * - Coalesce the adjacent user turns that removal can create. The chat template
 *   layer (`normalizeMessagesForTemplate`) does NOT merge consecutive user
 *   roles — it only normalizes the system role — so `apply_chat_template` would
 *   otherwise receive malformed alternation.
 */
export function prepareBranchForPrompt(activeBranch: ChatMessage[]): PreparedBranch {
  const messages: ChatMessage[] = [];
  const sourceIds: string[] = [];
  for (const message of activeBranch) {
    if (message.role === "assistant" && message.content.trim().length === 0) continue;
    const previous = messages.length > 0 ? messages[messages.length - 1]! : undefined;
    if (previous && previous.role === "user" && message.role === "user") {
      // Keep the LATER message's metadata (branch navigation) but remember the
      // EARLIER id: the merged turn's content starts there.
      messages[messages.length - 1] = {
        ...message,
        content: `${previous.content}\n\n${message.content}`,
      };
      continue;
    }
    messages.push(message);
    sourceIds.push(message.id);
  }
  return { messages, sourceIds };
}

/**
 * Find the index in `activeBranch` where the context divider should appear.
 * The divider goes BEFORE the first in-context message.
 *
 * `windowStartId` comes from the LAST COMPLETED turn's reported window (see
 * `runtime/window.ts`), not from a client-side recomputation — selection is
 * async and inside the worker now, so the divider is after-the-fact by
 * construction. Chrome fires a `contextoverflow` event the page renders and Jan
 * shows a banner after the fact for the same reason.
 *
 * @returns Index of the first in-context message, or -1 if all are in context
 */
export function findContextDividerIndex(
  activeBranch: ChatMessage[],
  windowStartId: string | null,
): number {
  if (activeBranch.length === 0 || windowStartId === null) return -1;
  const index = activeBranch.findIndex((m) => m.id === windowStartId);
  return index > 0 ? index : -1;
}
