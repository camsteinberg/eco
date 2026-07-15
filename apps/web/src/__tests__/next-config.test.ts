// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("web Next config", () => {
  it("pins Turbopack to the repo workspace root", () => {
    const expectedRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../.."
    );

    expect(nextConfig.turbopack?.root).toBe(expectedRoot);
  });

  it("serves cross-origin isolation headers on every route", async () => {
    // COOP+COEP make `crossOriginIsolated` true, which is what lets
    // onnxruntime-web run multi-threaded WASM. Global (not /chat-scoped)
    // because isolation belongs to the document that first loaded, and /chat
    // is reached by client-side navigation. COEP must stay `require-corp` —
    // Safari does not implement `credentialless`.
    const headerRules = await nextConfig.headers?.();
    const globalRule = headerRules?.find((rule) => rule.source === "/:path*");

    expect(globalRule?.headers).toContainEqual({
      key: "Cross-Origin-Opener-Policy",
      value: "same-origin",
    });
    expect(globalRule?.headers).toContainEqual({
      key: "Cross-Origin-Embedder-Policy",
      value: "require-corp",
    });
  });
});
