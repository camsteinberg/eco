// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { isValidSiteGateAccessToken } from "../../../src/lib/site-gate-cookie";

describe("POST /api/gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects malformed JSON without throwing", async () => {
    vi.stubEnv("SITE_PASSWORD", "sprout");

    const response = await POST(
      new Request("http://localhost/api/gate", {
        method: "POST",
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 when the launch gate is not configured", async () => {
    vi.stubEnv("SITE_PASSWORD", "");

    const response = await POST(
      new Request("http://localhost/api/gate", {
        method: "POST",
        body: JSON.stringify({ password: "sprout" }),
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    { label: "missing password", body: {} },
    { label: "non-string password", body: { password: 123 } },
    { label: "wrong password", body: { password: "wrong" } },
  ])("rejects $label without setting a cookie", async ({ body }) => {
    vi.stubEnv("SITE_PASSWORD", "sprout");

    const response = await POST(
      new Request("http://localhost/api/gate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  // The comparison is constant-time, so a wrong password must be rejected the
  // same way whether it matches the configured length or not — a length
  // mismatch is not allowed to become its own, faster answer.
  it.each([
    { label: "same-length wrong password", password: "sprouz" },
    { label: "shorter wrong password", password: "spr" },
    { label: "longer wrong password", password: "sproutsprout" },
    { label: "empty password", password: "" },
    { label: "correct password with a suffix", password: "sprout-extra" },
  ])("rejects a $label without setting a cookie", async ({ password }) => {
    vi.stubEnv("SITE_PASSWORD", "sprout");

    const response = await POST(
      new Request("http://localhost/api/gate", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("issues a token the middleware accepts for the correct password", async () => {
    vi.stubEnv("SITE_PASSWORD", "sprout");

    const response = await POST(
      new Request("http://localhost/api/gate", {
        method: "POST",
        body: JSON.stringify({ password: "sprout" }),
      }),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    const token = decodeURIComponent(setCookie.split(";")[0]!.split("=").slice(1).join("="));

    expect(response.status).toBe(200);
    await expect(isValidSiteGateAccessToken(token, "sprout")).resolves.toBe(true);
    await expect(isValidSiteGateAccessToken(token, "not-sprout")).resolves.toBe(false);
  });

  it("sets the access cookie as secure in production", async () => {
    vi.stubEnv("SITE_PASSWORD", "sprout");
    vi.stubEnv("NODE_ENV", "production");

    const response = await POST(
      new Request("http://localhost/api/gate", {
        method: "POST",
        body: JSON.stringify({ password: "sprout" }),
      }),
    );

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/eco-site-access=v1\.\d+\.[A-Za-z0-9_-]+/);
    expect(setCookie).not.toContain("eco-site-access=granted");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).toContain("Secure");
  });
});

describe("GET /api/gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports whether the launch gate is configured without setting cookies", async () => {
    vi.stubEnv("SITE_PASSWORD", "sprout");

    const configured = await GET();
    await expect(configured.json()).resolves.toEqual({ configured: true });
    expect(configured.headers.get("set-cookie")).toBeNull();

    vi.stubEnv("SITE_PASSWORD", "");
    const inactive = await GET();
    await expect(inactive.json()).resolves.toEqual({ configured: false });
    expect(inactive.headers.get("set-cookie")).toBeNull();
  });
});
