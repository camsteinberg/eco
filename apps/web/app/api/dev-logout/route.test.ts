// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/dev-logout", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clears the dev session cookie and redirects to a signed-out guest recovery surface", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const response = await GET(new Request("http://localhost:3000/api/dev-logout", {
      headers: { host: "127.0.0.1:3000" },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3000/sign-in?signedOut=1&callbackUrl=/chat",
    );
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });

  it("sanitizes local sign-out continuation callbacks", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const response = await GET(new Request(
      "http://localhost:3000/api/dev-logout?callbackUrl=https%3A%2F%2Fevil.example%2Fsteal",
      {
        headers: { host: "127.0.0.1:3000" },
      },
    ));

    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/chat");
  });

  it("is unavailable in production and does not clear or set session cookies", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET(new Request("https://econetwork.ai/api/dev-logout"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
