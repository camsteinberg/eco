// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import catalogData from "../../src/local-ai/catalog/catalog-data.json";
import { buildModelFileURL } from "../../src/local-ai/download/proxy";
import {
  DEFAULT_MODEL_HOST,
  MODEL_HOST_ENV_VAR,
  acceptanceModelHost,
  appFallsBackOn,
  artifactFor,
  judgeFileSources,
  modelFileUrl,
  sampleFiles,
  type FileProbe,
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

describe("appFallsBackOn — the app's own CDN-to-proxy rule", () => {
  it("falls back when the host is missing the file, overloaded, or unreachable", () => {
    for (const status of ["403", "404", "408", "429", "500", "503", "unreachable (fetch failed)"]) {
      expect(appFallsBackOn(status), status).toBe(true);
    }
  });

  it("does not fall back on any other 4xx", () => {
    for (const status of ["400", "401", "410"]) {
      expect(appFallsBackOn(status), status).toBe(false);
    }
  });
});

describe("judgeFileSources", () => {
  const host = (status: string) => ({ url: `https://models.example/${status}`, status, ok: status === "200" });
  const proxy = (status: string) => ({ url: `http://localhost:3120/api/local-models/${status}`, status, ok: status === "200" });

  it("is silent when the host serves every file", () => {
    const probes: FileProbe[] = [{ file: "a.bin", host: host("200"), proxy: null }];
    expect(judgeFileSources(probes)).toEqual({ notes: [], missing: [] });
  });

  it("notes, without failing, a file only the app's proxy serves", () => {
    // The model host never received this file; the app retries it through its
    // own proxy and the download completes, so the walk can go on.
    const probes: FileProbe[] = [{ file: "a.bin", host: host("404"), proxy: proxy("200") }];
    const verdict = judgeFileSources(probes);
    expect(verdict.missing).toEqual([]);
    expect(verdict.notes).toEqual([
      "the model host is missing a.bin (404); the app fell back to its own proxy",
    ]);
  });

  it("fails a file neither source serves, naming both answers", () => {
    const probes: FileProbe[] = [{ file: "a.bin", host: host("404"), proxy: proxy("403") }];
    const verdict = judgeFileSources(probes);
    expect(verdict.missing).toHaveLength(1);
    expect(verdict.missing[0]).toContain("404 https://models.example/404");
    expect(verdict.missing[0]).toContain("403 http://localhost:3120/api/local-models/403");
  });

  it("fails a file the host refuses for good, even if the proxy has it — the app would not fall back", () => {
    const probes: FileProbe[] = [{ file: "a.bin", host: host("410"), proxy: proxy("200") }];
    expect(judgeFileSources(probes).missing).toHaveLength(1);
  });

  it("notes, without failing, a proxy that could not answer because Hugging Face rate-limited it", () => {
    // A 429 from the proxy is the upstream throttling this machine, not a
    // refusal: it says nothing about whether the file exists. Setup's own
    // download still fails the run if the file is really refused.
    const verdict = judgeFileSources([{ file: "a.bin", host: host("404"), proxy: proxy("429") }]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.notes).toEqual([
      "could not confirm a.bin is served: the app's proxy answered 429 (upstream rate limit); "
        + "continuing — a real refusal during setup still fails the run",
    ]);
  });

  it("notes, without failing, a proxy answering 5xx", () => {
    const verdict = judgeFileSources([{ file: "a.bin", host: null, proxy: proxy("503") }]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.notes).toEqual([
      "could not confirm a.bin is served: the app's proxy answered 503; "
        + "continuing — a real refusal during setup still fails the run",
    ]);
  });

  it("still fails on a definitive proxy refusal", () => {
    for (const status of ["403", "404", "410", "400"]) {
      expect(judgeFileSources([{ file: "a.bin", host: host("404"), proxy: proxy(status) }]).missing, status)
        .toHaveLength(1);
    }
  });

  it("with no separate host, judges the proxy alone and has nothing to note", () => {
    expect(judgeFileSources([{ file: "a.bin", host: null, proxy: proxy("200") }])).toEqual({
      notes: [],
      missing: [],
    });
    expect(judgeFileSources([{ file: "a.bin", host: null, proxy: proxy("404") }]).missing).toEqual([
      "404 http://localhost:3120/api/local-models/404",
    ]);
  });
});
