// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { HEAD } from "./route";

function routeContext(file: string) {
  return {
    params: Promise.resolve({ file }),
  };
}

describe("/api/litert-wasm/[file]", () => {
  it("serves the LiteRT WASM glue JS from same-origin", async () => {
    const response = await HEAD(
      new Request("http://localhost/api/litert-wasm/litertlm_wasm_internal.js"),
      routeContext("litertlm_wasm_internal.js"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
  });

  it("serves the LiteRT WASM binary", async () => {
    const response = await HEAD(
      new Request("http://localhost/api/litert-wasm/litertlm_wasm_internal.wasm"),
      routeContext("litertlm_wasm_internal.wasm"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
  });

  it("serves the compat WASM variant the feature-detector may select", async () => {
    const response = await HEAD(
      new Request("http://localhost/api/litert-wasm/litertlm_wasm_compat_internal.wasm"),
      routeContext("litertlm_wasm_compat_internal.wasm"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/wasm");
  });

  it("rejects unknown / path-traversal assets", async () => {
    for (const file of ["other.wasm", "../package.json", "litertlm_wasm_internal.map"]) {
      const response = await HEAD(
        new Request(`http://localhost/api/litert-wasm/${file}`),
        routeContext(file),
      );
      expect(response.status).toBe(404);
    }
  });
});
