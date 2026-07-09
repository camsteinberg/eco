// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_STORAGE_VERSION } from "../../lib/onboarding-version";

describe("onboardingStore persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("does not rehydrate a held launch model as recommended before default eligibility clears", async () => {
    localStorage.setItem(
      "eco-onboarding",
      JSON.stringify({
        state: {
          step: "sprout",
          hasCompletedOnboarding: false,
          hardwareCapability: "wasm",
          deviceMemoryGB: 4,
          recommendedModelId: "local/qwen3-0.6b",
        },
        version: ONBOARDING_STORAGE_VERSION,
      }),
    );

    const { getOnboardingStore } = await import("../onboardingStore");

    const store = getOnboardingStore();
    expect(store).not.toBeNull();
    expect(store?.getState().step).toBe("seed");
    expect(store?.getState().hardwareCapability).toBe("wasm");
    expect(store?.getState().recommendedModel).toBeNull();
  });

  it("falls back to the seed step when an older saved state lacks a recommended model", async () => {
    localStorage.setItem(
      "eco-onboarding",
      JSON.stringify({
        state: {
          step: "sprout",
          hasCompletedOnboarding: false,
        },
        version: ONBOARDING_STORAGE_VERSION,
      }),
    );

    const { getOnboardingStore } = await import("../onboardingStore");

    expect(getOnboardingStore()?.getState().step).toBe("seed");
    expect(getOnboardingStore()?.getState().recommendedModel).toBeNull();
  });

  it("ignores stale onboarding recommendation ids that are not launch-safe defaults", async () => {
    localStorage.setItem(
      "eco-onboarding",
      JSON.stringify({
        state: {
          step: "sprout",
          hasCompletedOnboarding: false,
          hardwareCapability: "webgpu",
          deviceMemoryGB: 16,
          recommendedModelId: "local/ternary-bonsai-4b-q2f16",
        },
        version: ONBOARDING_STORAGE_VERSION,
      }),
    );

    const { getOnboardingStore } = await import("../onboardingStore");

    expect(getOnboardingStore()?.getState().step).toBe("seed");
    expect(getOnboardingStore()?.getState().recommendedModel).toBeNull();
  });

  it("ignores raw or removed onboarding recommendation ids without crashing hydration", async () => {
    localStorage.setItem(
      "eco-onboarding",
      JSON.stringify({
        state: {
          step: "sprout",
          hasCompletedOnboarding: false,
          recommendedModelId: "candidate/raw-source_hold-id",
        },
        version: ONBOARDING_STORAGE_VERSION,
      }),
    );

    const { getOnboardingStore } = await import("../onboardingStore");

    expect(getOnboardingStore()?.getState().step).toBe("seed");
    expect(getOnboardingStore()?.getState().recommendedModel).toBeNull();
  });

  it("treats older completed onboarding as stale for the local-first activation", async () => {
    localStorage.setItem(
      "eco-onboarding",
      JSON.stringify({
        state: {
          step: "complete",
          hasCompletedOnboarding: true,
          hardwareCapability: "wasm",
          deviceMemoryGB: 16,
          recommendedModelId: "local/qwen3-0.6b",
        },
        version: ONBOARDING_STORAGE_VERSION - 1,
      }),
    );

    const { getOnboardingStore } = await import("../onboardingStore");

    expect(getOnboardingStore()?.getState().hasCompletedOnboarding).toBe(false);
    expect(getOnboardingStore()?.getState().step).toBe("seed");
  });
});
