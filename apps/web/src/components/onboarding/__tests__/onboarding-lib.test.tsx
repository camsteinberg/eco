// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ONBOARDING_KEYS,
  isTourCompleted,
  markTourCompleted,
  isFeatureDiscovered,
  markFeatureDiscovered,
} from "../../../lib/onboarding";

describe("onboarding persistence lib", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe("ONBOARDING_KEYS", () => {
    it("exports expected key constants", () => {
      expect(ONBOARDING_KEYS.TOUR_COMPLETED).toBe("eco-tour-completed");
      expect(ONBOARDING_KEYS.DISCOVERY_MODEL_SELECTOR).toBe(
        "eco-discovery-model-selector"
      );
      expect(ONBOARDING_KEYS.DISCOVERY_KEYBOARD_SHORTCUTS).toBe(
        "eco-discovery-keyboard-shortcuts"
      );
    });
  });

  describe("isTourCompleted", () => {
    it("returns false when no localStorage key exists", () => {
      expect(isTourCompleted()).toBe(false);
    });

    it('returns true when "eco-tour-completed" is "true"', () => {
      localStorage.setItem("eco-tour-completed", "true");
      expect(isTourCompleted()).toBe(true);
    });

    it("returns false for non-true values", () => {
      localStorage.setItem("eco-tour-completed", "false");
      expect(isTourCompleted()).toBe(false);
    });

    it("returns true during SSR (typeof window === undefined)", () => {
      // Simulate SSR by stubbing window to undefined
      const origWindow = globalThis.window;
      // @ts-expect-error -- intentionally removing window for SSR test
      delete globalThis.window;
      try {
        expect(isTourCompleted()).toBe(true);
      } finally {
        globalThis.window = origWindow;
      }
    });
  });

  describe("markTourCompleted", () => {
    it('sets "eco-tour-completed" to "true" in localStorage', () => {
      markTourCompleted();
      expect(localStorage.getItem("eco-tour-completed")).toBe("true");
    });
  });

  describe("isFeatureDiscovered", () => {
    it("returns false when key doesn't exist", () => {
      expect(isFeatureDiscovered("model-selector")).toBe(false);
    });

    it("returns true when feature has been discovered", () => {
      localStorage.setItem("eco-discovery-model-selector", "true");
      expect(isFeatureDiscovered("model-selector")).toBe(true);
    });
  });

  describe("markFeatureDiscovered", () => {
    it('sets "eco-discovery-model-selector" to "true"', () => {
      markFeatureDiscovered("model-selector");
      expect(localStorage.getItem("eco-discovery-model-selector")).toBe("true");
    });

    it("works with arbitrary feature IDs", () => {
      markFeatureDiscovered("keyboard-shortcuts");
      expect(
        localStorage.getItem("eco-discovery-keyboard-shortcuts")
      ).toBe("true");
    });
  });
});
