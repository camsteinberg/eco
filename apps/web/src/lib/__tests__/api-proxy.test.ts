// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDownstreamHeaders, buildUpstreamHeaders, proxyToApi } from "../api-proxy";

/** A minimal `ProcessEnv` for the header builder: `NODE_ENV` is required by the type. */
function envWith(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://econetwork.ai/v1/search", { method: "GET", headers });
}

describe("buildUpstreamHeaders", () => {
  it("forwards only the allowlisted request headers", () => {
    const headers = buildUpstreamHeaders(
      requestWith({
        "content-type": "application/json",
        accept: "application/json",
        cookie: "better-auth.session_token=abc",
        origin: "https://econetwork.ai",
        authorization: "Bearer token",
        "accept-language": "en-GB",
        "user-agent": "eco-test",
        "x-custom-thing": "nope",
      }),
      envWith(),
    );

    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("cookie")).toBe("better-auth.session_token=abc");
    expect(headers.get("origin")).toBe("https://econetwork.ai");
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("accept-language")).toBe("en-GB");
    expect(headers.get("user-agent")).toBe("eco-test");
    expect(headers.get("x-custom-thing")).toBeNull();
  });

  it("drops client-supplied IP and proxy-impersonation headers", () => {
    const headers = buildUpstreamHeaders(
      requestWith({
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
        "fly-client-ip": "203.0.113.9",
        "x-eco-client-ip": "198.51.100.1",
        "x-eco-proxy-key": "stolen-secret",
      }),
      envWith(),
    );

    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("fly-client-ip")).toBeNull();
    expect(headers.get("x-eco-client-ip")).toBeNull();
    expect(headers.get("x-eco-proxy-key")).toBeNull();
  });

  it("sets the trusted client-IP pair when a secret and a resolvable IP are present", () => {
    const fromRealIp = buildUpstreamHeaders(
      requestWith({ "x-real-ip": "203.0.113.9" }),
      envWith({ API_PROXY_SECRET: "shared-secret" }),
    );
    const fromForwardedList = buildUpstreamHeaders(
      requestWith({ "x-forwarded-for": "203.0.113.9, 70.0.0.1" }),
      envWith({ API_PROXY_SECRET: "shared-secret" }),
    );

    expect(fromRealIp.get("x-eco-client-ip")).toBe("203.0.113.9");
    expect(fromRealIp.get("x-eco-proxy-key")).toBe("shared-secret");
    expect(fromForwardedList.get("x-eco-client-ip")).toBe("203.0.113.9");
    expect(fromForwardedList.get("x-eco-proxy-key")).toBe("shared-secret");
  });

  it("sets neither header without a secret, and neither without a client IP", () => {
    const noSecret = buildUpstreamHeaders(requestWith({ "x-real-ip": "203.0.113.9" }), envWith());
    const noIp = buildUpstreamHeaders(
      requestWith({}),
      envWith({ API_PROXY_SECRET: "shared-secret" }),
    );

    for (const headers of [noSecret, noIp]) {
      expect(headers.get("x-eco-client-ip")).toBeNull();
      expect(headers.get("x-eco-proxy-key")).toBeNull();
    }
  });
});

describe("buildDownstreamHeaders", () => {
  it("passes every set-cookie value back verbatim", () => {
    const upstream = new Response(null, {
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", "__Secure-better-auth.session_token=abc; Path=/; HttpOnly; Secure"],
        ["set-cookie", "better-auth.state=xyz; Path=/; HttpOnly"],
      ],
    });

    const cookies = buildDownstreamHeaders(upstream).getSetCookie();

    expect(cookies).toEqual([
      "__Secure-better-auth.session_token=abc; Path=/; HttpOnly; Secure",
      "better-auth.state=xyz; Path=/; HttpOnly",
    ]);
  });

  it("copies the allowlisted response headers and every rate-limit header", () => {
    const upstream = new Response(null, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "30",
        location: "https://api.econetwork.ai/callback",
        "x-ratelimit-limit": "20",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "60",
        "x-internal-detail": "nope",
      },
    });

    const headers = buildDownstreamHeaders(upstream);

    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("retry-after")).toBe("30");
    expect(headers.get("location")).toBe("https://api.econetwork.ai/callback");
    expect(headers.get("x-ratelimit-limit")).toBe("20");
    expect(headers.get("x-ratelimit-remaining")).toBe("0");
    expect(headers.get("x-ratelimit-reset")).toBe("60");
    expect(headers.get("x-internal-detail")).toBeNull();
  });
});

describe("proxyToApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("never logs the request body", async () => {
    vi.stubEnv("API_URL", "http://localhost:3001");
    const secret = "hunter2-not-in-any-log";
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await proxyToApi(new Request("https://econetwork.ai/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: secret }),
    }));

    expect(response.status).toBe(200);
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("reports an unreachable upstream as a 502 with no operator detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3001");
    }));

    const response = await proxyToApi(new Request("https://econetwork.ai/v1/search"));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.error.code).toBe("upstream_unreachable");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
