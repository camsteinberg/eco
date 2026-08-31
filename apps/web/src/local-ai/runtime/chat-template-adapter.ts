// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Chat template adapter — system-role normalization per model.
 *
 * The per-model strategy is stored in `catalog-data.json` as
 * `systemRoleSupport` and looked up by the adapter / worker at
 * generation time.
 *
 * All shipping catalog entries use "native" (template supports
 * `<|system|>` / ChatML system). The former "prepend-user" and
 * "merge-first-user" strategies were removed — no catalog entry used them.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type SystemRoleSupport = 'native';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Normalize a chat message array for a model whose template may not
 * support `role: "system"`.
 *
 * All shipping models use "native" (pass through unchanged).
 */
export function normalizeMessagesForTemplate(
  messages: ChatMessage[],
  _strategy: SystemRoleSupport,
): ChatMessage[] {
  return messages;
}

// ─── Rendered-template tokenization ────────────────────────────────────────

/** Minimal callable shape of a Transformers.js tokenizer: `tokenizer(text, opts)`. */
export type RenderedTemplateTokenizer = (
  text: string,
  options: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Tokenize the STRING returned by `apply_chat_template({ tokenize: false })`
 * the way the worker feeds it to `model.generate(...)`.
 *
 * `add_special_tokens` is forced to `false`, and that is load-bearing: the chat
 * template already emits every special token the model expects (BOS, role
 * markers, EOS). Re-tokenizing the rendered string with the tokenizer's default
 * `add_special_tokens: true` makes any tokenizer whose post-processor prepends a
 * BOS add it a SECOND time — a doubled leading token the model never saw in
 * training, which degrades every single generation.
 *
 * Verified on-device against the real pinned tokenizers, 2026-08-11: with the
 * default `true`, LFM2.5-1.2B and LFM2.5-350M render
 * `[<|startoftext|>, <|startoftext|>, <|im_start|>, …]` (BOS doubled); with
 * `false` the token ids equal the canonical `apply_chat_template({ tokenize:
 * true })` sequence exactly, for EVERY shipping transformers-runtime model
 * (the two LFM2.5 builds drop the duplicate; Qwen2.5/Qwen3/Qwen3.5 and
 * SmolLM2 are byte-identical — their BOS, when present, comes from the template
 * literal, not a re-added special token). WebLLM (MLC) and LiteRT runtimes do
 * their own prompt formatting and never reach this path.
 *
 * `extraOptions` carries the caller's non-special-token concerns (e.g.
 * `return_tensor: 'pt'`); `add_special_tokens: false` always wins.
 */
export function tokenizeRenderedTemplate(
  tokenizer: RenderedTemplateTokenizer,
  renderedText: string,
  extraOptions: Record<string, unknown> = {},
): Promise<unknown> {
  return tokenizer(renderedText, { ...extraOptions, add_special_tokens: false });
}
