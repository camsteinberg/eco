// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Adding a shipping model is a ONE-FILE change.
 *
 * Sampling and length budgets used to be scattered across `lib/chat-intent.ts`
 * and `lib/local-model-generation-profiles.ts`; device rules lived in
 * `local-ai/device/compatibility.ts` and presentation copy in
 * `local-ai/display.ts` + `components/local-ai/welcome-choices.ts`. A new catalog
 * entry that touched only catalog-data.json resolved someone else's numbers
 * through a family fallback, or was declined on every device and rendered under
 * its raw vendor name — silently, with a green suite.
 *
 * This test replaces catalog-data.json with a fixture containing a model that
 * appears NOWHERE ELSE in the tree, then drives the real public resolution
 * path. Every value it asserts can only have come from the fixture entry, so
 * the test fails if any second file ever has to be edited for a model to serve
 * correctly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceProfile } from "../../local-ai/types";

const FIXTURE_ID = "fixture/one-file-model";

/**
 * The whole fixture entry, in one object. Every variant below spreads it and
 * removes exactly one block, so each "rejects an entry missing X" case differs
 * from a loadable entry by X alone.
 */
const FIXTURE_ENTRY = {
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
  compat: {
    requireWebgpu: true,
    minDeviceMemoryGB: 6,
    allowedBrowsers: ["firefox"],
    warnIfMobile: true,
  },
  display: {
    friendlyName: "Fixture Brand (Fixture Co)",
    qualityPhrase: "Only this fixture says so",
    provider: "Fixture Co",
    welcome: {
      name: "Fixture Brand",
      tagline: "A tagline that exists nowhere else in the tree.",
      speed: 3,
      depth: 1,
    },
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
};

vi.mock("../../local-ai/catalog/catalog-data.json", () => ({
  default: { models: [FIXTURE_ENTRY] },
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

  it("resolves device rules from the catalog entry alone", async () => {
    const { getCatalog } = await import("../../local-ai/catalog/catalog");
    const { isCompatible, isAssignable, hasCompatibilityRule } = await import(
      "../../local-ai/device/compatibility"
    );

    const model = getCatalog()[0]!;
    const firefox: DeviceProfile = {
      browserClass: "firefox",
      webgpuSupport: "webgpu",
      deviceMemoryGB: 8,
      isMobile: false,
      override: "auto",
    };

    expect(hasCompatibilityRule(FIXTURE_ID)).toBe(true);
    // allowedBrowsers: ["firefox"] — only this entry says firefox is allowed.
    expect(isCompatible(model, firefox)).toBe("supported");
    // warnIfMobile from the entry.
    expect(isCompatible(model, { ...firefox, isMobile: true })).toBe("with-warning");
    // minDeviceMemoryGB: 6 — a value no other model in the tree uses.
    expect(isCompatible(model, { ...firefox, deviceMemoryGB: 4 })).toBe("unsupported");
    // requireWebgpu from the entry.
    expect(isCompatible(model, { ...firefox, webgpuSupport: "wasm-only" })).toBe("unsupported");
    // allowedBrowsers excludes chromium for this entry.
    expect(isAssignable(model, { ...firefox, browserClass: "chromium" })).toBe(false);
  });

  it("resolves display and welcome-card copy from the catalog entry alone", async () => {
    const { getCatalog } = await import("../../local-ai/catalog/catalog");
    const { getDisplayInfo, dedupeByDisplayName } = await import("../../local-ai/display");
    const { toWelcomeChoice } = await import("../../components/local-ai/welcome-choices");

    const model = getCatalog()[0]!;

    expect(getDisplayInfo(FIXTURE_ID, model)).toEqual({
      friendlyName: "Fixture Brand (Fixture Co)",
      qualityPhrase: "Only this fixture says so",
      provenance: "Fixture Co · 0.1 GB",
    });
    expect(toWelcomeChoice(model)).toEqual({
      id: FIXTURE_ID,
      name: "Fixture Brand",
      sizeLabel: "~0.1 GB",
      tagline: "A tagline that exists nowhere else in the tree.",
      speed: 3,
      depth: 1,
    });
    // The entry's branded name is what dedupe groups on.
    expect(dedupeByDisplayName([model]).map((m) => m.id)).toEqual([FIXTURE_ID]);
  });

  it("resolves the adapter-side quirk from the catalog entry alone", async () => {
    vi.doMock("../../local-ai/catalog/catalog-data.json", () => ({
      default: { models: [{ ...FIXTURE_ENTRY, runtime: "webllm", format: "mlc-q4f16",
        quirks: { webllmModelLibFile: "Fixture-Only-lib.wasm" } }] },
    }));
    const { getCatalog } = await import("../../local-ai/catalog/catalog");
    const { webllmModelLibPathFor } = await import("../../local-ai/runtime/webllm-config");

    expect(webllmModelLibPathFor(getCatalog()[0]!)).toBe(
      "/webllm/v0_2_84/Fixture-Only-lib.wasm",
    );
  });

  it("rejects an entry missing its compat block instead of defaulting", async () => {
    vi.doMock("../../local-ai/catalog/catalog-data.json", () => ({
      default: { models: [{ ...FIXTURE_ENTRY, id: "fixture/no-compat", compat: undefined }] },
    }));

    await expect(import("../../local-ai/catalog/catalog")).rejects.toThrow(
      /fixture\/no-compat.*compat/s,
    );
  });

  it("rejects an entry missing its display block instead of defaulting", async () => {
    vi.doMock("../../local-ai/catalog/catalog-data.json", () => ({
      default: { models: [{ ...FIXTURE_ENTRY, id: "fixture/no-display", display: undefined }] },
    }));

    await expect(import("../../local-ai/catalog/catalog")).rejects.toThrow(
      /fixture\/no-display.*display/s,
    );
  });

  it("rejects a webllm entry with no vendored model_lib wasm", async () => {
    vi.doMock("../../local-ai/catalog/catalog-data.json", () => ({
      default: { models: [{ ...FIXTURE_ENTRY, id: "fixture/no-lib", runtime: "webllm" }] },
    }));

    await expect(import("../../local-ai/catalog/catalog")).rejects.toThrow(
      /fixture\/no-lib.*quirks/s,
    );
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
