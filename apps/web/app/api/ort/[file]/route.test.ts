// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { HEAD } from "./route";

function routeContext(file: string) {
  return {
    params: Promise.resolve({ file }),
  };
}

describe("/api/ort/[file]", () => {
  it("serves the ONNX Runtime asyncify module from same-origin", async () => {
    const response = await HEAD(
      new Request("http://localhost/api/ort/ort-wasm-simd-threaded.asyncify.mjs"),
      routeContext("ort-wasm-simd-threaded.asyncify.mjs"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
  });

  it("serves the ONNX Runtime asyncify wasm binary", async () => {
    const response = await HEAD(
      new Request("http://localhost/api/ort/ort-wasm-simd-threaded.asyncify.wasm"),
      routeContext("ort-wasm-simd-threaded.asyncify.wasm"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
  });

  it.each([
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.jspi.mjs",
    "ort-wasm-simd-threaded.jspi.wasm",
  ])("serves the %s measurement-matrix variant", async (file) => {
    const response = await HEAD(
      new Request(`http://localhost/api/ort/${file}`),
      routeContext(file),
    );

    expect(response.status).toBe(200);
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
  });

  it("rejects unknown runtime assets", async () => {
    const response = await HEAD(
      new Request("http://localhost/api/ort/other.wasm"),
      routeContext("other.wasm"),
    );

    expect(response.status).toBe(404);
  });
});
