// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../middleware";
import { createSiteGateAccessToken, SITE_ACCESS_COOKIE } from "../lib/site-gate-cookie";

const originalSitePassword = process.env.SITE_PASSWORD;

function requestFor(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, "https://econetwork.ai"), {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("middleware site gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalSitePassword === undefined) {
      delete process.env.SITE_PASSWORD;
    } else {
      process.env.SITE_PASSWORD = originalSitePassword;
    }
  });

  it("keeps chat behind the private launch gate when SITE_PASSWORD is set", async () => {
    process.env.SITE_PASSWORD = "launch-password";

    const response = await middleware(requestFor("/chat"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/gate?returnTo=%2Fchat");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("canonicalizes gated launch return targets before showing the gate", async () => {
    process.env.SITE_PASSWORD = "launch-password";

    const rootResponse = await middleware(requestFor("/?prompt=Keep+this+local&preview=1"));
    const tryResponse = await middleware(requestFor("/try?prompt=Keep+this+local&source=legacy"));
    const previewResponse = await middleware(
      requestFor("/chat?preview=1&prompt=Keep+this+local"),
    );

    expect(rootResponse.status).toBe(307);
    expect(rootResponse.headers.get("location")).toContain(
      "/gate?returnTo=%2Fchat%3Fprompt%3DKeep%2Bthis%2Blocal",
    );
    expect(tryResponse.status).toBe(307);
    expect(tryResponse.headers.get("location")).toContain(
      "/gate?returnTo=%2Fchat%3Fprompt%3DKeep%2Bthis%2Blocal%26source%3Dlegacy",
    );
    expect(previewResponse.status).toBe(307);
    expect(previewResponse.headers.get("location")).toContain(
      "/gate?returnTo=%2Fchat%3Fprompt%3DKeep%2Bthis%2Blocal",
    );
  });

  it("collapses gate return targets for admin and internal route classes to chat", async () => {
    process.env.SITE_PASSWORD = "launch-password";

    const adminResponse = await middleware(requestFor("/admin/growth"));
    const unknownResponse = await middleware(requestFor("/mission-validation"));

    expect(adminResponse.status).toBe(307);
    expect(adminResponse.headers.get("location")).toContain("/gate?returnTo=%2Fchat");
    expect(unknownResponse.status).toBe(307);
    expect(unknownResponse.headers.get("location")).toContain("/gate?returnTo=%2Fchat");
  });

  it("allows local model proxy requests so gated users can download models", async () => {
    process.env.SITE_PASSWORD = "launch-password";

    const response = await middleware(
      requestFor("/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/main/config.json"),
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps legal and trust routes reachable before gate unlock", async () => {
    process.env.SITE_PASSWORD = "launch-password";

    for (const path of ["/privacy", "/terms", "/transparency", "/impact"]) {
      const response = await middleware(requestFor(path));

      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("redirects root and retired try entries directly to canonical chat", async () => {
    const rootResponse = await middleware(requestFor("/?prompt=Keep+this+local&preview=1"));
    const tryResponse = await middleware(requestFor("/try?prompt=Keep+this+local&source=legacy"));

    expect(rootResponse.status).toBe(307);
    expect(rootResponse.headers.get("location")).toBe(
      "https://econetwork.ai/chat?prompt=Keep+this+local",
    );
    expect(tryResponse.status).toBe(307);
    expect(tryResponse.headers.get("location")).toBe(
      "https://econetwork.ai/chat?prompt=Keep+this+local&source=legacy",
    );
  });

  it("strips retired chat preview mode before the app renders", async () => {
    const response = await middleware(requestFor("/chat?preview=1&prompt=Keep+this+local"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://econetwork.ai/chat?prompt=Keep+this+local",
    );
  });

  it("accepts only signed, unexpired site gate cookies for gated app routes", async () => {
    process.env.SITE_PASSWORD = "launch-password";
    const token = await createSiteGateAccessToken("launch-password");

    const response = await middleware(
      requestFor("/chat", `${SITE_ACCESS_COOKIE}=${encodeURIComponent(token)}`),
    );

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    { label: "empty", value: "" },
    { label: "legacy static grant", value: "granted" },
    { label: "random", value: "random" },
    { label: "malformed", value: "v1.not-a-date.signature" },
    { label: "tampered", value: "v1.4102444800000.invalid-signature" },
  ])("fails closed for a forged or stale site gate cookie: $label", async ({ value }) => {
    process.env.SITE_PASSWORD = "launch-password";

    const response = await middleware(
      requestFor("/chat", `${SITE_ACCESS_COOKIE}=${encodeURIComponent(value)}`),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/gate?returnTo=%2Fchat");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("fails closed for an expired signed site gate cookie", async () => {
    process.env.SITE_PASSWORD = "launch-password";
    const expiredToken = await createSiteGateAccessToken(
      "launch-password",
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    );

    const response = await middleware(
      requestFor("/settings?tab=models", `${SITE_ACCESS_COOKIE}=${encodeURIComponent(expiredToken)}`),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "/gate?returnTo=%2Fsettings%3Ftab%3Dmodels",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("serves sign-up directly with no invite gate, even with a legacy invite param", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const withInviteParam = await middleware(
      requestFor("/sign-up?invite=testcode&callbackUrl=%2Fsettings%3Ftab%3Dmodels&prompt=Keep+this+local"),
    );
    const plain = await middleware(requestFor("/sign-up?callbackUrl=%2Fchat"));

    // Signup is open: no redirect to a (removed) /invite gate.
    expect(withInviteParam.headers.get("location")).toBeNull();
    expect(plain.headers.get("location")).toBeNull();
  });

  it("allows direct Hugging Face model download redirect hosts in CSP", async () => {
    const response = await middleware(requestFor("/chat"));
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("https://huggingface.co");
    expect(csp).toContain("https://*.huggingface.co");
    expect(csp).toContain("https://cdn-lfs.hf.co");
    expect(csp).toContain("https://*.hf.co");
    expect(csp).toContain("https://*.xethub.hf.co");
    expect(csp).toContain("https://*.r2.cloudflarestorage.com");
  });

  it("uses production CSP with nonce, strict scripts, and no unsafe inline scripts", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await middleware(requestFor("/chat"));
    const csp = response.headers.get("content-security-policy") ?? "";
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? "";

    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("emits HSTS, nosniff, and object-src 'none' on gated redirect responses", async () => {
    process.env.SITE_PASSWORD = "launch-password";

    const response = await middleware(requestFor("/chat"));

    expect(response.status).toBe(307);
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy") ?? "").toContain(
      "object-src 'none'",
    );
  });

  it("emits HSTS, nosniff, and object-src 'none' on pass-through app responses", async () => {
    const token = await createSiteGateAccessToken("launch-password");
    process.env.SITE_PASSWORD = "launch-password";

    const response = await middleware(
      requestFor("/chat", `${SITE_ACCESS_COOKIE}=${encodeURIComponent(token)}`),
    );

    // Not a redirect — the app renders.
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy") ?? "").toContain(
      "object-src 'none'",
    );
  });

  it("omits HSTS preload and X-Frame-Options (frame-ancestors covers clickjacking)", async () => {
    const response = await middleware(requestFor("/chat"));

    expect(response.headers.get("strict-transport-security")).not.toContain("preload");
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("uses development CSP without a nonce and labels unsafe script allowances as dev-only", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const response = await middleware(requestFor("/chat"));
    const csp = response.headers.get("content-security-policy") ?? "";
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? "";

    expect(scriptSrc).not.toContain("'nonce-");
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });
});
