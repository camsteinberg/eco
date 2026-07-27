// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { test, expect } from "@playwright/test";

/**
 * E2E tests verifying Content-Security-Policy headers on key pages.
 *
 * These tests verify STATIC behavior (CSP headers present in responses).
 * They do NOT require a running API/orchestrator -- they test the Next.js
 * middleware in isolation.
 *
 * Prerequisites:
 *   - Web app running at http://localhost:3000 (or PLAYWRIGHT_BASE_URL)
 */

const KEY_PAGES = [
  "/",
  "/sign-in",
  "/impact",
  "/transparency",
  "/privacy",
];

test.describe("Content-Security-Policy headers", () => {
  for (const page of KEY_PAGES) {
    test(`${page} includes CSP header for the active environment`, async ({
      request,
    }) => {
      const response = await request.get(page);
      const csp = response.headers()["content-security-policy"] ?? "";

      // CSP header must exist and be non-empty
      expect(csp.length).toBeGreaterThan(0);

      const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
      expect(scriptSrcMatch).not.toBeNull();
      const scriptSrc = scriptSrcMatch?.[1] ?? "";
      const isDevelopmentCsp = scriptSrc.includes("'unsafe-eval'");

      if (isDevelopmentCsp) {
        expect(scriptSrc).toContain("'unsafe-inline'");
        expect(scriptSrc).not.toContain("'nonce-");
      } else {
        // Production script-src must contain a nonce and strict-dynamic.
        expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
        expect(scriptSrc).toContain("'strict-dynamic'");
        expect(scriptSrc).not.toContain("'unsafe-inline'");
      }

      // frame-ancestors must be 'none' (clickjacking protection)
      expect(csp).toContain("frame-ancestors 'none'");

      // connect-src must include self
      expect(csp).toContain("connect-src 'self'");

      // wasm-unsafe-eval must be present for WebAssembly compilation
      expect(csp).toContain("'wasm-unsafe-eval'");

      // worker-src must allow self and blob: for inference Web Worker
      expect(csp).toContain("worker-src 'self' blob:");

      // connect-src must include model CDN domains
      expect(csp).toContain("https://huggingface.co");
      expect(csp).toContain("https://*.huggingface.co");
      expect(csp).toContain("https://cdn-lfs.hf.co");
      expect(csp).toContain("https://*.hf.co");
      expect(csp).toContain("https://*.xethub.hf.co");
      // Direct model-file CDN (R2 behind a Cloudflare custom domain) — the
      // download resolver fetches weights here when NEXT_PUBLIC_ECO_MODEL_CDN_BASE
      // is set. The *.r2.cloudflarestorage.com wildcard does not cover it, so it
      // is allow-listed explicitly; without it CDN downloads are CSP-blocked.
      expect(csp).toContain("https://models.econetwork.ai");
      // The GitHub raw-content origin was ONLY needed by the retired WebLLM/MLC
      // runtime (registry C1/C2, 2026-07-10) to fetch its model_lib WASM. It
      // must NOT be in connect-src anymore — a negative assertion pins that the
      // origin was dropped and never silently returns.
      expect(csp).not.toContain("https://raw.githubusercontent.com");

      // Phase 5 grounding fetches facts directly from Wikimedia (browser-direct,
      // no proxy). Without these, grounding lookups are CSP-blocked and every
      // factual question silently degrades to "couldn't reach reference sources".
      expect(csp).toContain("https://en.wikipedia.org");
      expect(csp).toContain("https://www.wikidata.org");

      // The weather tool (Open-Meteo) was cut from v1 — assert its hosts are NOT
      // in connect-src so the allowlist stays tight.
      expect(csp).not.toContain("open-meteo.com");

      // style-src allows unsafe-inline for Tailwind CSS
      expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);

      // base-uri and form-action restricted to self
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");

      // object-src 'none' closes the <object>/<embed> plugin vector
      // (defense-in-depth on top of frame-ancestors 'none').
      expect(csp).toContain("object-src 'none'");

      // HSTS pins HTTPS for a year — no `preload` (semi-irreversible,
      // pending subdomain verification). X-Content-Type-Options: nosniff
      // stops content-type sniffing on HTML/JS/JSON responses.
      const headers = response.headers();
      expect(headers["strict-transport-security"]).toBe(
        "max-age=31536000; includeSubDomains",
      );
      expect(headers["strict-transport-security"]).not.toContain("preload");
      expect(headers["x-content-type-options"]).toBe("nosniff");
    });
  }

  test("nonce is unique per request", async ({ request }) => {
    const extractNonce = (csp: string): string => {
      const match = csp.match(/'nonce-([A-Za-z0-9+/=]+)'/);
      expect(match).not.toBeNull();
      const nonce = match?.[1];
      expect(nonce).toBeDefined();
      return nonce!;
    };

    const response1 = await request.get("/");
    const response2 = await request.get("/");

    const csp1 = response1.headers()["content-security-policy"] ?? "";
    const csp2 = response2.headers()["content-security-policy"] ?? "";

    expect(csp1.length).toBeGreaterThan(0);
    expect(csp2.length).toBeGreaterThan(0);

    const scriptSrc = csp1.match(/script-src\s+([^;]+)/)?.[1] ?? "";
    if (scriptSrc.includes("'unsafe-eval'")) {
      expect(scriptSrc).toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'nonce-");
      return;
    }

    const nonce1 = extractNonce(csp1);
    const nonce2 = extractNonce(csp2);

    // Nonces must differ between requests
    expect(nonce1).not.toEqual(nonce2);
  });

  test("default-src is self", async ({ request }) => {
    const response = await request.get("/");
    const csp = response.headers()["content-security-policy"];
    expect(csp).toContain("default-src 'self'");
  });
});
