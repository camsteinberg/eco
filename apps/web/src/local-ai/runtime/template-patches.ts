// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Targeted chat-template patches, applied by the transformers worker after
 * tokenizer load (before the boot-time template smoke).
 *
 * Why this exists: KV-cache reuse is valid only when the previous turn's
 * cached token sequence is a STRICT prefix of the next render (kv-cache.ts).
 * The Qwen3.5 vendor template breaks that BY CONSTRUCTION in non-thinking
 * mode: the generation prompt injects an empty think block
 * (`<|im_start|>assistant\n<think>\n\n</think>\n\n`) whose tokens enter the
 * cached sequence, but the SAME assistant turn re-renders WITHOUT the block
 * once it becomes history (the template's think branch only applies to
 * messages after the last user query). Guaranteed `not-strict-prefix` miss
 * at the previous assistant header → full reprefill every turn. Measured
 * live 2026-06-11/12: divergence at exactly renderLen−4 (the four
 * think-block tokens); turn TTFT 5.9–7.0s vs LFM2.5's 1.5s reuse control.
 *
 * The patch renders HISTORY assistant turns with the same empty think block
 * — byte-identical to what the model actually consumed when it generated
 * that turn, so it is MORE faithful to the live token stream than the
 * vendor render, not less.
 *
 * Drift safety: exact-statement matching, gated on the template also
 * carrying the non-thinking generation-prompt injection, and refused when
 * the statement is not unique. On any future template that doesn't match,
 * the template ships unmodified and behavior degrades to pre-patch full
 * prefill — visible as `not-strict-prefix` misses in kvReuse receipts
 * (the instrument that found this bug).
 */

/**
 * The vendor statement rendering a HISTORY assistant turn (at or before the
 * last user query) without a think block. `\n` here is the two-character
 * Jinja escape exactly as it appears in the template source.
 */
const HISTORY_ASSISTANT_STMT = "{{- '<|im_start|>' + message.role + '\\n' + content }}";

/** The same statement, rendering the non-thinking empty think block first. */
const PATCHED_HISTORY_ASSISTANT_STMT =
  "{{- '<|im_start|>' + message.role + '\\n<think>\\n\\n</think>\\n\\n' + content }}";

/**
 * Marker proving the template injects the empty think block into the
 * generation prompt when thinking is disabled — the other half of the
 * asymmetry. Without it there is nothing to fix.
 */
const NON_THINKING_GENERATION_MARKER = "'<think>\\n\\n</think>\\n\\n'";

export type TemplatePatchResult = {
  template: string;
  patched: boolean;
};

/**
 * Rewrite a chat template so history assistant turns re-render exactly as
 * they were generated (empty think block included), restoring the KV
 * strict-prefix property across turns. Pure; returns the input unchanged
 * (`patched: false`) whenever the template doesn't match precisely.
 */
export function patchChatTemplateForKvReuse(template: string): TemplatePatchResult {
  if (!template.includes(NON_THINKING_GENERATION_MARKER)) {
    return { template, patched: false };
  }

  const first = template.indexOf(HISTORY_ASSISTANT_STMT);
  if (first === -1) {
    return { template, patched: false };
  }
  const second = template.indexOf(HISTORY_ASSISTANT_STMT, first + 1);
  if (second !== -1) {
    // Not the template shape we verified — refuse rather than guess.
    return { template, patched: false };
  }

  return {
    template:
      template.slice(0, first) +
      PATCHED_HISTORY_ASSISTANT_STMT +
      template.slice(first + HISTORY_ASSISTANT_STMT.length),
    patched: true,
  };
}
