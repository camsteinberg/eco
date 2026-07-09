// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Open-Meteo weather lookup engine — public surface (capability wave, slice 1).
 *
 * A later slice composes {@link lookupWeather} into a chat tool and a render. This
 * slice ships only the data layer. The lower-level {@link geocodeLocation} and
 * {@link fetchCurrentWeather} primitives are exported too so the tool layer (and
 * tests) can drive each leg independently.
 */

export type {
  WeatherDeclineReason,
  WeatherReading,
  WeatherRequestOptions,
  WeatherResult,
} from "./types";
export {
  DEFAULT_WEATHER_TIMEOUT_MS,
  fetchCurrentWeather,
  geocodeLocation,
  lookupWeather,
  wmoCodeToConditions,
} from "./open-meteo";
