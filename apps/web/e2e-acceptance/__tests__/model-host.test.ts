// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import catalogData from "../../src/local-ai/catalog/catalog-data.json";
import { buildModelFileURL } from "../../src/local-ai/download/proxy";
import {
  DEFAULT_MODEL_HOST,
  MODEL_HOST_ENV_VAR,
  acceptanceModelHost,
  artifactFor,
  modelFileUrl,
  sampleFiles,
} from "../lib/model-host";

const ARTIFACT = {
  hfId: "org/Some-Model",
  revision: "abc123",
  files: ["params_shard_0.bin", "nested/tokenizer.json", "params_shard_1.bin"],
};

describe("acceptanceModelHost", () => {
  it("is the production model CDN when unset", () => {
    expect(acceptanceModelHost({})).toBe(DEFAULT_MODEL_HOST);
  });

  it("is empty — the app's own proxy — when set to empty", () => {
    expect(acceptanceModelHost({ [MODEL_HOST_ENV_VAR]: "" })).toBe("");
    expect(acceptanceModelHost({ [MODEL_HOST_ENV_VAR]: "   " })).toBe("");
  });

  it("takes another host, without a trailing slash", () => {
    expect(acceptanceModelHost({ [MODEL_HOST_ENV_VAR]: " https://models.example/ " })).toBe(
      "https://models.example",
    );
  });
});

describe("modelFileUrl", () => {
  it("builds the URL the app fetches, on a host and through its proxy", () => {
    // The app's own builder is the reference: the lane must check the URL the
    // browser will actually request, not a look-alike.
    const parsed = { modelId: ARTIFACT.hfId, revision: ARTIFACT.revision, filePath: "nested/tokenizer.json" };
    expect(modelFileUrl(ARTIFACT, "nested/tokenizer.json", "https://models.example", "http://localhost:3120")).toBe(
      buildModelFileURL(parsed, "https://models.example"),
    );
    expect(modelFileUrl(ARTIFACT, "nested/tokenizer.json", "", "http://localhost:3120/")).toBe(
      `http://localhost:3120${buildModelFileURL(parsed, null)}`,
    );
  });
});

describe("artifactFor", () => {
  it("reads a shipping WebLLM model's files from the real catalog", () => {
    const artifact = artifactFor(catalogData, "candidate/qwen2.5-0.5b-mlc");
    expect(artifact?.hfId).toMatch(/MLC$/);
    expect(artifact?.files.length).toBeGreaterThan(0);
  });

  it("is null for a model it does not know, or a catalog of the wrong shape", () => {
    expect(artifactFor(catalogData, "no/such-model")).toBeNull();
    expect(artifactFor(null, "candidate/qwen2.5-0.5b-mlc")).toBeNull();
    expect(artifactFor({ models: [{ id: "x", artifact: { hfId: 1 } }] }, "x")).toBeNull();
  });
});

describe("sampleFiles", () => {
  it("checks the first and last file", () => {
    expect(sampleFiles(ARTIFACT)).toEqual(["params_shard_0.bin", "params_shard_1.bin"]);
  });

  it("checks a single-file model once", () => {
    expect(sampleFiles({ ...ARTIFACT, files: ["model.bin"] })).toEqual(["model.bin"]);
  });
});
