// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

describe("GET /api/dev-login", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects to the request origin when no explicit web origin is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_WEB_URL", "");

    const response = await GET(new Request("http://localhost:3000/api/dev-login", {
      headers: { host: "127.0.0.1:3000" },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/chat");
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=dev-test-session");
  });

  it("prefers the request origin over NEXT_PUBLIC_WEB_URL during development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_WEB_URL", "http://localhost:3000");

    const response = await GET(new Request("http://localhost:3000/api/dev-login", {
      headers: { host: "127.0.0.1:3000" },
    }));

    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/chat");
  });

  it("prefers a loopback referer origin when the internal request URL drifts to localhost", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const response = await GET(new Request("http://localhost:3000/api/dev-login", {
      headers: {
        host: "localhost:3000",
        referer: "http://127.0.0.1:3000/chat",
      },
    }));

    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/chat");
  });

  it("uses the forwarded loopback host when one is present", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const response = await GET(new Request("http://localhost:3000/api/dev-login", {
      headers: {
        host: "localhost:3000",
        "x-forwarded-host": "127.0.0.1:3000",
        "x-forwarded-proto": "http",
      },
    }));

    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/chat");
  });

  it("preserves sanitized callback and pending prompt for local credentialed proof", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const response = await GET(new Request(
      "http://localhost:3000/api/dev-login?callbackUrl=%2Fchat&prompt=Keep%20this%20local",
      {
        headers: { host: "127.0.0.1:3000" },
      },
    ));

    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3000/chat?prompt=Keep+this+local",
    );
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=dev-test-session");
  });

  it("collapses unsafe callbacks while retaining prompt continuation", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const response = await GET(new Request(
      "http://localhost:3000/api/dev-login?callbackUrl=https%3A%2F%2Fevil.example%2Fsteal&prompt=Keep%20this%20local",
      {
        headers: { host: "127.0.0.1:3000" },
      },
    ));

    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3000/chat?prompt=Keep+this+local",
    );
  });

  it("is unavailable in production and does not set a session cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET(new Request("https://econetwork.ai/api/dev-login"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
