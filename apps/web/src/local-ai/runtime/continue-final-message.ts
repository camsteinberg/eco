// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Continue-final-message rendering.
 *
 * When a reply is resumed (reload/crash mid-answer, then "Try again"), chat
 * sends the partial reply as a trailing `assistant` message and sets
 * `continueFinalMessage`. Rendering that array the normal way closes the
 * partial as a FINISHED turn (`…partial<|im_end|>`) and then opens a brand-new
 * assistant turn — so every model starts the answer over instead of finishing
 * it (real-browser 2026-08-27: "…the soft hum of the Let's imagine the scene:").
 *
 * Transformers.js 4.2.0 has no `continue_final_message`, so this module does
 * the equivalent template-agnostically: render the history WITHOUT the partial
 * (`add_generation_prompt: true`), then append the partial verbatim. The
 * result is byte-identical to the original turn's prompt plus the text the
 * model already produced, which also keeps the KV-cache prefix valid.
 *
 * Templates that prefill an open `<think>` (LFM2.5) get it closed first: the
 * saved partial is post-filter visible text, so it belongs AFTER the reasoning
 * block, and the output filter must not be seeded to swallow it.
 */

export type TemplateMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ContinuationSplit = {
  /** Messages to render with `add_generation_prompt: true`. */
  history: TemplateMessage[];
  /** The partial reply to append after the rendered history, or null when
   *  this is an ordinary generation. */
  partial: string | null;
};

/**
 * Split off the trailing assistant partial when a continuation was requested.
 * Falls back to an ordinary generation when the flag is unset, the array is
 * empty, the last message is not an assistant turn, or the partial is blank.
 */
export function splitContinuation(
  messages: TemplateMessage[],
  continueFinalMessage: boolean | undefined,
): ContinuationSplit {
  const last = messages[messages.length - 1];
  if (!continueFinalMessage || !last || last.role !== 'assistant' || last.content.trim().length === 0) {
    return { history: messages, partial: null };
  }
  return { history: messages.slice(0, -1), partial: last.content };
}

/**
 * Append the partial to the rendered history. If the template left an
 * unmatched `<think>` open, close it so the partial reads as the answer.
 */
export function appendContinuation(renderedHistory: string, partial: string): string {
  const opens = renderedHistory.match(/<think>/gi)?.length ?? 0;
  const closes = renderedHistory.match(/<\/think>/gi)?.length ?? 0;
  const closer = opens > closes ? '</think>\n' : '';
  return renderedHistory + closer + partial;
}
