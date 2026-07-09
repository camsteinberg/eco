// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/deploy-health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a no-store, non-mutating deployment identity payload without cookies", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "091057c1234567890abcdef");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_123");
    vi.stubEnv("VERCEL_URL", "eco-web-abc.vercel.app");

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      service: "eco-web",
      status: "ok",
      commitSha: "091057c1234567890abcdef",
      deploymentId: "dpl_123",
      deploymentUrl: "eco-web-abc.vercel.app",
    });
  });

  it("does not expose arbitrary environment variables when Vercel metadata is absent", async () => {
    vi.stubEnv("SITE_PASSWORD", "secret");
    vi.stubEnv("VERCEL_TOKEN", "secret-token");

    const response = GET();

    await expect(response.json()).resolves.toEqual({
      service: "eco-web",
      status: "ok",
      commitSha: null,
      deploymentId: null,
      deploymentUrl: null,
    });
  });
});
