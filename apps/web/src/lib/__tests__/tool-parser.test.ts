// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { parseToolEvent, parseToolCalls } from "../tool-parser";

describe("parseToolEvent", () => {
  it("parses valid tool_start event", () => {
    const raw = '\x00tool:{"type":"tool_start","name":"calculator","args":{"expression":"2+2"}}';
    const result = parseToolEvent(raw);
    expect(result).toEqual({
      type: "tool_start",
      name: "calculator",
      args: { expression: "2+2" },
    });
  });

  it("parses valid tool_complete event", () => {
    const raw = '\x00tool:{"type":"tool_complete","name":"calculator","result":"4"}';
    const result = parseToolEvent(raw);
    expect(result).toEqual({
      type: "tool_complete",
      name: "calculator",
      result: "4",
    });
  });

  it("returns null for non-tool event", () => {
    const raw = "Just a regular token";
    expect(parseToolEvent(raw)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const raw = "\x00tool:{bad json}";
    expect(parseToolEvent(raw)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseToolEvent("")).toBeNull();
  });
});

describe("parseToolCalls", () => {
  it("extracts valid tool call from text", () => {
    const text = 'Let me calculate.\n<tool_call>\n{"name": "calculator", "args": {"expression": "2+3"}}\n</tool_call>';
    const { text: cleaned, toolCalls } = parseToolCalls(text);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe("calculator");
    expect(toolCalls[0]!.args).toEqual({ expression: "2+3" });
    expect(cleaned).not.toContain("<tool_call>");
  });

  it("returns empty array when no tool calls", () => {
    const text = "No tools here.";
    const { toolCalls } = parseToolCalls(text);
    expect(toolCalls).toEqual([]);
  });

  it("handles malformed JSON gracefully", () => {
    const text = "<tool_call>\n{not valid json}\n</tool_call>";
    const { toolCalls } = parseToolCalls(text);
    expect(toolCalls).toEqual([]);
  });

  it("extracts multiple tool calls", () => {
    const text =
      '<tool_call>\n{"name": "calculator", "args": {"expression": "1+1"}}\n</tool_call>\n<tool_call>\n{"name": "web_search", "args": {"query": "test"}}\n</tool_call>';
    const { toolCalls } = parseToolCalls(text);
    expect(toolCalls).toHaveLength(2);
  });

  it("handles empty text", () => {
    const { text, toolCalls } = parseToolCalls("");
    expect(text).toBe("");
    expect(toolCalls).toEqual([]);
  });
});
