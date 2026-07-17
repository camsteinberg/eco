// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "./route";

function manifestRequest(modelIdSegments: string[]): Parameters<typeof GET> {
  return [
    new Request("http://127.0.0.1:3000/api/local-models/manifest/" + modelIdSegments.join("/")),
    { params: Promise.resolve({ modelId: modelIdSegments }) },
  ];
}

describe("GET /api/local-models/manifest/[...modelId]", () => {
  it("returns 200 with correct shape for local/phi3-mini-4k-q4f16", async () => {
    const response = await GET(...manifestRequest(["local", "phi3-mini-4k-q4f16"]));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.modelId).toBe("local/phi3-mini-4k-q4f16");
    expect(body.hfId).toBe("microsoft/Phi-3-mini-4k-instruct-onnx-web");
    expect(body.revision).toBe("80a2792f5bf861528ce9b449b3230f1bd3fdc759");
    expect(body.files.length).toBeGreaterThan(0);

    for (const file of body.files) {
      expect(typeof file.path).toBe("string");
      expect(file.path.length).toBeGreaterThan(0);
      expect(typeof file.sizeBytes).toBe("number");
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(typeof file.oid).toBe("string");
      expect(file.oid.length).toBeGreaterThan(0);
    }
  });

  it("returns 404 with model_not_in_catalog for an unknown model id", async () => {
    const response = await GET(...manifestRequest(["local", "nonexistent"]));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "model_not_in_catalog" });
  });

  it("returns 400 with invalid_model_id for empty slug", async () => {
    const response = await GET(...manifestRequest([""]));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_model_id" });
  });

  it("returns 400 with invalid_model_id for slugs containing path traversal", async () => {
    const response = await GET(...manifestRequest(["local", "..", "etc", "passwd"]));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_model_id" });
  });

  it("returns 400 with invalid_model_id for slugs containing spaces", async () => {
    const response = await GET(...manifestRequest(["local", "bad model"]));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_model_id" });
  });

  it("returns 400 with invalid_model_id for excessively long slugs", async () => {
    const response = await GET(...manifestRequest(["local", "a".repeat(200)]));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_model_id" });
  });

  it("includes Cache-Control: public, max-age=3600, immutable on success", async () => {
    const response = await GET(...manifestRequest(["local", "qwen3-0.6b"]));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600, immutable");
  });

  it("files array entries have positive integer sizeBytes and non-empty oid", async () => {
    const response = await GET(...manifestRequest(["local", "qwen3-0.6b"]));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.files.length).toBeGreaterThan(0);
    for (const file of body.files) {
      expect(Number.isInteger(file.sizeBytes)).toBe(true);
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(typeof file.oid).toBe("string");
      expect(file.oid.length).toBeGreaterThan(0);
    }
  });

  it("returns the graduated external-data artifact identity for local/qwen3-0.6b", async () => {
    const response = await GET(...manifestRequest(["local", "qwen3-0.6b"]));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.hfId).toBe("econetworkai/Qwen3-0.6B-ONNX-external-data");
    expect(body.revision).toBe("e059eaaf660ff62dbc8adcd1057488aa3ad0f5f9");
    // External-data pair: the small graph file plus its .onnx_data weights blob.
    const paths = body.files.map((file: { path: string }) => file.path);
    expect(paths).toContain("onnx/model_q4f16.onnx");
    expect(paths).toContain("onnx/model_q4f16.onnx_data");
  });

  it.each([
    ["POST", POST],
    ["PUT", PUT],
    ["DELETE", DELETE],
    ["PATCH", PATCH],
    ["OPTIONS", OPTIONS],
    ["HEAD", HEAD],
  ])("returns 405 for %s", (_method, handler) => {
    const response = handler();
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  // ── Validation-lane eval candidates (two-tier lookup, mirrors the proxy
  // route). Harness gating keys on the host header: loopback = allowed
  // (NODE_ENV=test maps to development), production hosts = denied.
  describe("validation-lane eval candidates", () => {
    function candidateRequest(host: string): Parameters<typeof GET> {
      const segments = ["candidate", "qwen3-0.6b-q4"];
      return [
        new Request(`http://${host}/api/local-models/manifest/${segments.join("/")}`, {
          headers: { host },
        }),
        { params: Promise.resolve({ modelId: segments }) },
      ];
    }

    it("serves reviewed sizes for a harness (loopback) request", async () => {
      const response = await GET(...candidateRequest("localhost:3000"));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.modelId).toBe("candidate/qwen3-0.6b-q4");
      expect(body.hfId).toBe("onnx-community/Qwen3-0.6B-ONNX");
      const weights = body.files.find(
        (file: { path: string }) => file.path === "onnx/model_q4.onnx",
      );
      // Exact reviewed size — this is what the sustained probe's
      // weights-cached verification compares against the Cache API.
      expect(weights).toMatchObject({ sizeBytes: 919096585 });
    });

    it("stays invisible (404) for a production-host request", async () => {
      const response = await GET(...candidateRequest("econetwork.ai"));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "model_not_in_catalog" });
    });
  });
});
