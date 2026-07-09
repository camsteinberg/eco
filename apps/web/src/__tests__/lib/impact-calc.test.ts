// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import {
  calculateImpact,
  WATER_PER_QUERY_LITERS,
  ENERGY_SAVING_KWH_PER_QUERY,
  CO2_SAVED_GRAMS_PER_QUERY,
} from "../../lib/impact-calc";

describe("calculateImpact", () => {
  it("returns standard savings when no options given", () => {
    const result = calculateImpact(5);
    expect(result.waterSavedLiters).toBeCloseTo(5 * WATER_PER_QUERY_LITERS);
    expect(result.energySavedWh).toBeCloseTo(
      5 * ENERGY_SAVING_KWH_PER_QUERY * 1000
    );
    expect(result.co2SavedGrams).toBeCloseTo(5 * CO2_SAVED_GRAMS_PER_QUERY);
  });

  it("returns zeros when queryCount is 0", () => {
    const result = calculateImpact(0);
    expect(result.waterSavedLiters).toBe(0);
    expect(result.energySavedWh).toBe(0);
    expect(result.co2SavedGrams).toBe(0);
  });
});
