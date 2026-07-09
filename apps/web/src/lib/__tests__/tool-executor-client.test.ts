// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, afterEach } from "vitest";
import { executeToolLocally } from "../tool-executor-client";

describe("executeToolLocally", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("executes calculator tool locally via the registry", async () => {
    // Delegates to the host-driven DEFAULT_TOOL_REGISTRY (#4 Phase 4a), which
    // returns the authoritative `display` string ("<expr> = <result>").
    const result = await executeToolLocally("calculator", { expression: "2+2" });
    expect(result).toBe("2+2 = 4");
  });

  it("rejects invalid calculator arguments", async () => {
    const result = await executeToolLocally("calculator", { expression: 42 });
    expect(result).toContain("Invalid arguments");
  });

  it("blocks web_search locally without network egress", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [{ title: "Test", url: "https://test.com", content: "Test content" }] }),
    }) as unknown as typeof fetch;

    const result = await executeToolLocally("web_search", { query: "test" });
    expect(result).toContain("Web search is disabled");
    expect(result).toContain("would leave this browser");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("disables local code_execution until it can run in a network-isolated sandbox", async () => {
    const result = await executeToolLocally("code_execution", { code: "console.log(1)" });
    expect(result).toContain("Local code execution is disabled");
  });

  it("returns error for unknown tool", async () => {
    const result = await executeToolLocally("unknown_tool", {});
    expect(result).toContain("Unknown tool");
  });
});
