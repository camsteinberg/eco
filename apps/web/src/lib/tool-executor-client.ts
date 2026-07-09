// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { DEFAULT_TOOL_REGISTRY } from "./tools";

/**
 * Execute a tool locally in the browser.
 *
 * v1.0 is on-device only, so tools run entirely client-side. Tools that would
 * leave this browser (web search, code execution) stay disabled to keep the
 * on-device privacy promise intact.
 *
 * Deterministic tools (calculator, datetime, unit-conversion) are delegated to
 * the host-driven {@link DEFAULT_TOOL_REGISTRY} (#4 Phase 4a) — the single source
 * of truth for tool execution. This helper preserves the legacy string-return
 * contract (callers expect the rendered answer) by returning the tool's `display`
 * string. The richer {@link EcoToolResult} is available via the registry directly.
 */
export async function executeToolLocally(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = DEFAULT_TOOL_REGISTRY[name];
  if (tool) {
    if (!tool.validate(args)) {
      return `Error: Invalid arguments for ${name}`;
    }
    const result = await tool.execute(args);
    return result.display;
  }

  switch (name) {
    case "web_search": {
      void args;
      return "Web search is disabled in Eco web v1.0 because it would leave this browser, and Eco keeps your conversation on this device.";
    }
    case "code_execution": {
      return "Execution error: Local code execution is disabled until Eco can run it safely on this device.";
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
