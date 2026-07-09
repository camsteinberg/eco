// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const safeEvent = {
  schemaVersion: 1,
  operationId: "op-1",
  kind: "generate",
  phase: "completed",
  state: "ready",
  modelId: "local/qwen3-0.6b",
  slot: "eco-fast",
  backend: "webgpu",
  browserClass: "chromium",
  browserVersionBucket: "124.x",
  platformClass: "desktop",
  deviceMemoryBucket: "<=8GB",
  cacheBackend: "opfs",
  lockWaitMs: 3,
  durationMs: 40,
  errorCode: null,
  cooldownReason: null,
  workerTerminationReason: null,
  createdAt: 1_779_552_000_000,
};

describe("POST /api/local-runtime-diagnostics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is unavailable unless runtime diagnostics are beta-enabled", async () => {
    const response = await POST(new Request("http://localhost/api/local-runtime-diagnostics", {
      method: "POST",
      body: JSON.stringify(safeEvent),
    }));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("logs only the privacy-safe diagnostic schema", async () => {
    vi.stubEnv("NEXT_PUBLIC_ECO_LOCAL_RUNTIME_DIAGNOSTICS", "true");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await POST(new Request("http://localhost/api/local-runtime-diagnostics", {
      method: "POST",
      body: JSON.stringify({
        ...safeEvent,
        prompt: "private prompt",
        generatedTokens: "private generated text",
        fileContent: "private file",
        rawUrl: "https://example.test/private?token=secret",
        errorCode: "token=secret",
        cooldownReason: "private generated text",
        workerTerminationReason: "https://example.test/private?token=secret",
      }),
    }));
    const body = await response.json();
    const loggedPayload = JSON.stringify(info.mock.calls[0]?.[1]);

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, count: 1 });
    expect(loggedPayload).not.toContain("private prompt");
    expect(loggedPayload).not.toContain("private generated text");
    expect(loggedPayload).not.toContain("private file");
    expect(loggedPayload).not.toContain("token=secret");
    expect(loggedPayload).not.toContain("https://example.test/private");
    expect(loggedPayload).toContain("token=[redacted-secret]");
    expect(loggedPayload).toContain("[redacted-private-content]");
    expect(loggedPayload).toContain("[redacted-url]");
  });

  it("rejects malformed diagnostic events", async () => {
    vi.stubEnv("NEXT_PUBLIC_ECO_LOCAL_RUNTIME_DIAGNOSTICS", "true");

    const response = await POST(new Request("http://localhost/api/local-runtime-diagnostics", {
      method: "POST",
      body: JSON.stringify({ operationId: "missing-schema-version" }),
    }));

    expect(response.status).toBe(400);
  });
});
