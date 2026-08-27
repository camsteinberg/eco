// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Environmental impact constants: what ONE data-center chat query is estimated
 * to cost, at the high end of the published range. Every figure is the
 * data-center cost avoided when the reply is generated on the user's device —
 * the device's own draw is not subtracted, and the copy says so.
 *
 * Sources (also listed on /impact):
 * - Water: Li et al., "Making AI Less Thirsty" (UC Riverside, 2023) — GPT-3
 *   consumes a 500 mL bottle per roughly 10–50 medium-length responses,
 *   i.e. 10–50 mL per response, on-site + off-site. We use the top of the
 *   range (50 mL). Google's 2025 measurement of a median Gemini prompt is
 *   0.26 mL on-site only — so this is a worst-common-case figure, not typical.
 * - Energy: de Vries, "The growing energy footprint of artificial
 *   intelligence" (Joule, 2023) — at most 2.9 Wh per ChatGPT request on
 *   2023-era serving. Epoch AI (2025) estimates ~0.3 Wh for GPT-4o and Google
 *   reports 0.24 Wh median for Gemini; again we use the high end.
 * - CO2: 2.9 Wh × US average grid intensity of 823 lb CO2/MWh
 *   (EPA eGRID 2022, ≈0.373 kg/kWh) ≈ 1.08 g per query. No PUE uplift is
 *   applied — de Vries' figure is already a whole-service estimate.
 */

/** Liters of water saved per query vs data center AI (cooling water avoided). */
export const WATER_PER_QUERY_LITERS = 0.05;

/** kWh of energy saved per query vs centralized inference. */
export const ENERGY_SAVING_KWH_PER_QUERY = 0.0029;

/** Grams of CO2 avoided per query vs data center inference. */
export const CO2_SAVED_GRAMS_PER_QUERY = 1.08;

/**
 * Average tokens per query -- a rough working assumption, not measured.
 * Used to derive per-token impact rates from peer-reviewed per-query constants.
 */
export const AVG_TOKENS_PER_QUERY = 256;

/** Liters of water saved per token (derived: per-query figure / 256 tokens). */
export const WATER_PER_TOKEN_LITERS = WATER_PER_QUERY_LITERS / AVG_TOKENS_PER_QUERY;

/** kWh of energy saved per token (derived: per-query figure / 256 tokens). */
export const ENERGY_PER_TOKEN_KWH = ENERGY_SAVING_KWH_PER_QUERY / AVG_TOKENS_PER_QUERY;

/** Grams of CO2 avoided per token (derived: per-query figure / 256 tokens). */
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
