// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Environmental impact calculation constants.
 * Sources:
 * - Water: UC Riverside research (~0.25L per AI query for GPT-4 class models)
 * - Energy: Luccioni et al. (2023) -- data center GPU inference ~0.005 kWh/query,
 *   home GPU marginal ~0.003 kWh/query, savings ~0.002 kWh/query
 * - CO2: EPA eGRID 2024 average US grid carbon intensity (0.42 kg CO2/kWh),
 *   data center PUE ~1.2, net savings ~1.26g CO2 per query
 */

/** Liters of water saved per query vs data center AI (cooling water avoided). */
export const WATER_PER_QUERY_LITERS = 0.25;

/** kWh of energy saved per query vs centralized inference. */
export const ENERGY_SAVING_KWH_PER_QUERY = 0.002;

/** Grams of CO2 avoided per query vs data center inference. */
export const CO2_SAVED_GRAMS_PER_QUERY = 1.26;

/**
 * Average tokens per query -- conservative estimate for 7B-class models.
 * Used to derive per-token impact rates from peer-reviewed per-query constants.
 */
export const AVG_TOKENS_PER_QUERY = 256;

/** Liters of water saved per token (derived: 0.25L / 256 tokens). */
export const WATER_PER_TOKEN_LITERS = WATER_PER_QUERY_LITERS / AVG_TOKENS_PER_QUERY;

/** kWh of energy saved per token (derived: 0.002kWh / 256 tokens). */
export const ENERGY_PER_TOKEN_KWH = ENERGY_SAVING_KWH_PER_QUERY / AVG_TOKENS_PER_QUERY;

/** Grams of CO2 avoided per token (derived: 1.26g / 256 tokens). */
export const CO2_PER_TOKEN_GRAMS = CO2_SAVED_GRAMS_PER_QUERY / AVG_TOKENS_PER_QUERY;

export type ImpactResult = {
  waterSavedLiters: number;
  energySavedWh: number;
  co2SavedGrams: number;
};

/**
 * Cumulative impact for a user, extending ImpactResult with engagement
 * and network-level contribution data.
 */
export type CumulativeImpact = ImpactResult & {
  /** Number of days the user has been active. */
  daysActive: number;
  /** Total queries the user has made. */
  totalQueries: number;
  /** Impact from queries served to others via the network. */
  networkContribution: ImpactResult;
};

/**
 * Calculate environmental impact savings for a given number of queries.
 * Each completed Eco response is treated as one avoided data-center query.
 */
export function calculateImpact(queryCount: number): ImpactResult {
  return {
    waterSavedLiters: queryCount * WATER_PER_QUERY_LITERS,
    energySavedWh: queryCount * ENERGY_SAVING_KWH_PER_QUERY * 1000, // Convert to Wh
    co2SavedGrams: queryCount * CO2_SAVED_GRAMS_PER_QUERY,
  };
}

/**
 * Calculate environmental impact savings from a raw token count.
 * Converts tokens to query equivalents using AVG_TOKENS_PER_QUERY,
 * then delegates to calculateImpact for consistent calculation.
 */
export function calculateImpactFromTokens(tokenCount: number): ImpactResult {
  const queryEquivalent = tokenCount / AVG_TOKENS_PER_QUERY;
  return calculateImpact(queryEquivalent);
}
