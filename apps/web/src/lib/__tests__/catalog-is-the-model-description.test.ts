// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Adding a shipping model is a ONE-FILE change.
 *
 * Sampling and length budgets used to be scattered across `lib/chat-intent.ts`
 * and `lib/local-model-generation-profiles.ts`, so a new catalog entry that
 * touched only catalog-data.json resolved someone else's numbers through a
 * family fallback — silently, with a green suite.
 *
 * This test replaces catalog-data.json with a fixture containing a model that
 * appears NOWHERE ELSE in the tree, then drives the real public resolution
 * path. Every value it asserts can only have come from the fixture entry, so
 * the test fails if any second file ever has to be edited for a model to serve
 * correctly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURE_ID = "fixture/one-file-model";

vi.mock("../../local-ai/catalog/catalog-data.json", () => ({
  default: {
    models: [
      {
        id: FIXTURE_ID,
        friendlyName: "One File",
        vendor: "Fixture",
        sizeGB: 0.1,
        runtime: "transformers",
        format: "onnx-q4",
        capabilities: { intent: ["snappy"], tasks: ["chat"], contextTokens: 8192 },
        generation: {
          temperature: 0.37,
          topP: 0.71,
          topK: 13,
          repetitionPenalty: 1.11,
          intentOverrides: {
            code: { temperature: 0.11, topP: 0.61 },
          },
        },
        maxNewTokens: {
          ceiling: 900,
          default: 300,
          max: 800,
          intentTokens: { quick: 200, deep: 4000 },
        },
        bestFor: "Fixture",
        knownLimitation: "Fixture",
        evidenceTier: "experimental",
        license: {
          spdx: "Apache-2.0",
          name: "Apache License 2.0",
          url: "https://www.apache.org/licenses/LICENSE-2.0",
          upstreamRepo: "fixture/one-file",
          confirmed: true,
          textFile: "apache-2.0.txt",
          artifactLicenseFile: null,
        },
      },
    ],
  },
}));

beforeEach(() => {
  vi.resetModules();
});

describe("a catalog entry is the whole description of a model", () => {
  it("resolves base sampling from the catalog entry alone", async () => {
    const { getGenerationProfile } = await import("../chat-intent");

    expect(getGenerationProfile("explain", true, FIXTURE_ID)).toEqual({
      temperature: 0.37,
      topP: 0.71,
      topK: 13,
      repetitionPenalty: 1.11,
      maxTokens: 300,
    });
  });

  it("applies the entry's per-intent sampling override", async () => {
    const { getGenerationProfile } = await import("../chat-intent");

    expect(getGenerationProfile("code", true, FIXTURE_ID)).toMatchObject({
      temperature: 0.11,
      topP: 0.61,
      // Not overridden per-intent, so they fall through from the base row.
      topK: 13,
      repetitionPenalty: 1.11,
    });
  });

  it("applies the entry's per-intent budget, its max clamp and its ceiling", async () => {
    const { getGenerationProfile, getMaxNewTokensCeiling } = await import("../chat-intent");

    // intentTokens.quick, below both clamps.
    expect(getGenerationProfile("quick", true, FIXTURE_ID).maxTokens).toBe(200);
    // intentTokens.deep (4000) clamped by max (800).
    expect(getGenerationProfile("deep", true, FIXTURE_ID).maxTokens).toBe(800);
    // No intentTokens row → default (300).
    expect(getGenerationProfile("writing", true, FIXTURE_ID).maxTokens).toBe(300);
    // The ceiling is the reserve context-window selection works from.
    expect(getMaxNewTokensCeiling(FIXTURE_ID)).toBe(900);
  });

  it("rejects an entry missing its generation block instead of defaulting", async () => {
    vi.doMock("../../local-ai/catalog/catalog-data.json", () => ({
      default: { models: [{ id: "fixture/no-generation", license: {} }] },
    }));

    await expect(import("../../local-ai/catalog/catalog")).rejects.toThrow(
      /fixture\/no-generation.*generation/s,
    );
  });
});
