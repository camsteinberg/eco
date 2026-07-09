// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from "vitest";

// Mock BEFORE the route is imported so the mocks land at module load.
// Synthetic catalog ids exist (per catalog mock) but their registry
// entries are absent or have empty fileMetadata (per registry mock),
// exercising the defensive 404 branches the real data cannot exercise
// (every real model has full fileMetadata).
vi.mock("../../../../../src/local-ai/catalog/catalog", () => ({
  getModel: (id: string) => {
    if (
      id === "local/synthetic-no-artifact"
      || id === "local/synthetic-empty-metadata"
    ) {
      return {
        id,
        friendlyName: "Synthetic Fixture",
        vendor: "Test",
        sizeGB: 0.1,
        runtime: "transformers",
        format: "onnx-q4f16",
        capabilities: { intent: ["balanced"], tasks: ["chat"], contextTokens: 1024 },
        bestFor: "test fixture",
        knownLimitation: "test fixture",
        evidenceTier: "proven",
        artifact: {
          hfId: "synthetic/" + id.replace("local/", ""),
          revision: "0000000000000000000000000000000000000000",
          files: ["model.onnx"],
        },
      };
    }
    return undefined;
  },
  getCatalog: () => [],
}));

vi.mock("../../../../../src/lib/local-model-registry", () => ({
  getLocalModelRegistryEntry: (id: string) => {
    if (id === "local/synthetic-no-artifact") return undefined;
    if (id === "local/synthetic-empty-metadata") {
      return {
        modelId: id,
        artifact: {
          hfId: "synthetic/empty-metadata",
          revision: "0000000000000000000000000000000000000000",
          files: ["model.onnx"],
          fileMetadata: {},
        },
      };
    }
    return undefined;
  },
}));

// Import AFTER the mocks so the route picks up the mocked deps.
import { GET } from "./route";

function manifestRequest(modelIdSegments: string[]): Parameters<typeof GET> {
  return [
    new Request("http://127.0.0.1:3000/api/local-models/manifest/" + modelIdSegments.join("/")),
    { params: Promise.resolve({ modelId: modelIdSegments }) },
  ];
}

describe("GET /api/local-models/manifest/[...modelId] — model_artifact_unavailable", () => {
  it("returns 404 with model_artifact_unavailable when registry has no entry for a catalog model", async () => {
    const response = await GET(...manifestRequest(["local", "synthetic-no-artifact"]));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "model_artifact_unavailable" });
  });

  it("returns 404 with model_artifact_unavailable when fileMetadata exists but produces zero entries", async () => {
    const response = await GET(...manifestRequest(["local", "synthetic-empty-metadata"]));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "model_artifact_unavailable" });
  });
});
