// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import {
  calculateImpact,
  calculateImpactFromTokens,
  WATER_PER_QUERY_LITERS,
  ENERGY_SAVING_KWH_PER_QUERY,
  CO2_SAVED_GRAMS_PER_QUERY,
  AVG_TOKENS_PER_QUERY,
  WATER_PER_TOKEN_LITERS,
  ENERGY_PER_TOKEN_KWH,
  CO2_PER_TOKEN_GRAMS,
} from "../impact-calc";
import type { CumulativeImpact } from "../impact-calc";

describe("constants", () => {
  it("WATER_PER_QUERY_LITERS is 0.25", () => {
    expect(WATER_PER_QUERY_LITERS).toBe(0.25);
  });

  it("ENERGY_SAVING_KWH_PER_QUERY is 0.002", () => {
    expect(ENERGY_SAVING_KWH_PER_QUERY).toBe(0.002);
  });

  it("CO2_SAVED_GRAMS_PER_QUERY is 1.26", () => {
    expect(CO2_SAVED_GRAMS_PER_QUERY).toBe(1.26);
  });
});

describe("calculateImpact", () => {
  it("returns zeros for 0 queries", () => {
    const result = calculateImpact(0);
    expect(result).toEqual({
      waterSavedLiters: 0,
      energySavedWh: 0,
      co2SavedGrams: 0,
    });
  });

  it("returns correct values for 4 queries", () => {
    const result = calculateImpact(4);
    expect(result).toEqual({
      waterSavedLiters: 1.0,
      energySavedWh: 8.0,
      co2SavedGrams: 5.04,
    });
  });

  it("returns correct scaled values for 100 queries", () => {
    const result = calculateImpact(100);
    expect(result).toEqual({
      waterSavedLiters: 25.0,
      energySavedWh: 200.0,
      co2SavedGrams: 126.0,
    });
  });

  it("handles 1 query correctly", () => {
    const result = calculateImpact(1);
    expect(result.waterSavedLiters).toBe(0.25);
    expect(result.energySavedWh).toBe(2.0);
    expect(result.co2SavedGrams).toBe(1.26);
  });
});

describe("per-token constants", () => {
  it("AVG_TOKENS_PER_QUERY is 256", () => {
    expect(AVG_TOKENS_PER_QUERY).toBe(256);
  });

  it("WATER_PER_TOKEN_LITERS equals WATER_PER_QUERY_LITERS / 256", () => {
    expect(WATER_PER_TOKEN_LITERS).toBeCloseTo(WATER_PER_QUERY_LITERS / 256, 10);
  });

  it("ENERGY_PER_TOKEN_KWH equals ENERGY_SAVING_KWH_PER_QUERY / 256", () => {
    expect(ENERGY_PER_TOKEN_KWH).toBeCloseTo(ENERGY_SAVING_KWH_PER_QUERY / 256, 10);
  });

  it("CO2_PER_TOKEN_GRAMS equals CO2_SAVED_GRAMS_PER_QUERY / 256", () => {
    expect(CO2_PER_TOKEN_GRAMS).toBeCloseTo(CO2_SAVED_GRAMS_PER_QUERY / 256, 10);
  });
});

describe("calculateImpactFromTokens", () => {
  it("returns same result as calculateImpact(1) for 256 tokens", () => {
    const fromTokens = calculateImpactFromTokens(256);
    const fromQueries = calculateImpact(1);
    expect(fromTokens.waterSavedLiters).toBeCloseTo(fromQueries.waterSavedLiters, 10);
    expect(fromTokens.energySavedWh).toBeCloseTo(fromQueries.energySavedWh, 10);
    expect(fromTokens.co2SavedGrams).toBeCloseTo(fromQueries.co2SavedGrams, 10);
  });

  it("returns same result as calculateImpact(2) for 512 tokens", () => {
    const fromTokens = calculateImpactFromTokens(512);
    const fromQueries = calculateImpact(2);
    expect(fromTokens.waterSavedLiters).toBeCloseTo(fromQueries.waterSavedLiters, 10);
    expect(fromTokens.energySavedWh).toBeCloseTo(fromQueries.energySavedWh, 10);
    expect(fromTokens.co2SavedGrams).toBeCloseTo(fromQueries.co2SavedGrams, 10);
  });

  it("returns all zeros for 0 tokens", () => {
    const result = calculateImpactFromTokens(0);
    expect(result).toEqual({
      waterSavedLiters: 0,
      energySavedWh: 0,
      co2SavedGrams: 0,
    });
  });
});

describe("CumulativeImpact type", () => {
  it("includes daysActive, totalQueries, and networkContribution fields", () => {
    const cumulative: CumulativeImpact = {
      waterSavedLiters: 10,
      energySavedWh: 50,
      co2SavedGrams: 25,
      daysActive: 5,
      totalQueries: 40,
      networkContribution: {
        waterSavedLiters: 100,
        energySavedWh: 500,
        co2SavedGrams: 250,
      },
    };
    expect(cumulative.daysActive).toBe(5);
    expect(cumulative.totalQueries).toBe(40);
    expect(cumulative.networkContribution.waterSavedLiters).toBe(100);
  });
});
