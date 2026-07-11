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

  it("returns 200 with correct shape for local/bonsai-1.7b-q4", async () => {
    const response = await GET(...manifestRequest(["local", "bonsai-1.7b-q4"]));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.modelId).toBe("local/bonsai-1.7b-q4");
    expect(body.hfId).toBe("onnx-community/Bonsai-1.7B-ONNX");
    expect(body.revision).toBe("3f3cf1759daf66342d26610488b9931f2fafcb29");
    expect(body.files.length).toBeGreaterThan(0);

    for (const file of body.files) {
      expect(typeof file.path).toBe("string");
      expect(file.sizeBytes).toBeGreaterThan(0);
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
});
