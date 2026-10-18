// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Split a stored assistant reply into its leading `<think>…</think>` block and
 * the answer after it.
 *
 * The stored body is the model's raw text, kept byte for byte so the next
 * turn's prompt matches the runtime's cache. A reasoning model's template
 * (Qwen3) writes a think block ahead of every reply — empty, `<think> </think>`,
 * when thinking is off. The person never sees it: the bubble shows the answer
 * and, when there was real reasoning, a collapsible thinking panel. Every other
 * place that shows a reply to a person (copy, export, a shared page) reads the
 * answer through here, so none of them prints the tags.
 */
export function splitThinkBlock(content: string): { thinkContent: string | null; displayContent: string } {
  const match = /^<think>([\s\S]*?)<\/think>\s*/.exec(content);
  if (!match) return { thinkContent: null, displayContent: content };
  return {
    thinkContent: match[1]?.trim() ?? null,
    displayContent: content.slice(match[0].length),
  };
}
