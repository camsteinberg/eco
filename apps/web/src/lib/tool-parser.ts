// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// ── Types ────────────────────────────────────────────────────────────────────

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type ToolEvent = {
  type: "tool_start" | "tool_complete" | "tool_error";
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  /**
   * Optional friendly one-line summary of the call, derived from the tool's
   * extracted args (e.g. "5 miles → kilometers"). Rendered as the
   * `ToolCallBlock` headline; the raw `args` stay in the expanded detail.
   */
  summary?: string;
  /**
   * How the tool's result should be surfaced (mirrors {@link EcoTool.presentation}).
   * The host stamps this from the matched tool when it renders a block, so the
   * renderer can tell a CANONICAL exact-answer tool (`"tool-block"` — calculator /
   * datetime / unit-conversion) apart from anything else. When explicitly
   * `"tool-block"`, the tool's `result` is the authoritative answer and the model's
   * prose is suppressed in favour of it (a sub-1B model's wrong number must never
   * override a host-computed exact value). Absent ⇒ not a canonical answer; the
   * model's prose is rendered normally.
   */
  presentation?: "tool-block" | "citation";
};

export type ToolCallDisplay = ToolEvent & {
  id: string;
  status: "running" | "complete" | "error";
};

// ── Tool Event Parser ────────────────────────────────────────────────────────

/**
 * Parse a tool event from a `\0tool:` prefixed string in the SSE stream.
 * Returns null if the string is not a tool event or if JSON is malformed.
 */
export function parseToolEvent(raw: string): ToolEvent | null {
  if (!raw.startsWith("\x00tool:")) {
    return null;
  }

  try {
    const data = JSON.parse(raw.slice(6)) as ToolEvent;
    return data;
  } catch {
    return null;
  }
}

// ── Tool Call Parser (shared logic with API-side) ────────────────────────────

/**
 * Parse `<tool_call>...</tool_call>` blocks from model output text.
 * Returns cleaned text and extracted tool calls.
 * Same logic as API-side parser (copied to avoid circular deps).
 */
export function parseToolCalls(text: string): {
  text: string;
  toolCalls: ToolCall[];
} {
  const toolCalls: ToolCall[] = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let cleanText = text;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
      if (parsed.name && parsed.args) {
        toolCalls.push({
          name: parsed.name as string,
          args: parsed.args as Record<string, unknown>,
        });
      }
    } catch {
      // Malformed JSON -- skip
    }
    cleanText = cleanText.replace(match[0], "");
  }

  // Also strip <tool_result> tags (API injects these for multi-turn orchestration)
  cleanText = cleanText.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, "");

  return { text: cleanText.trim(), toolCalls };
}
