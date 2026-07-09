// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Result types for the Open-Meteo weather lookup engine (capability wave, slice 1).
 *
 * These are the pure data shapes returned by the weather primitives in
 * {@link ./open-meteo}. Nothing here renders or wires into the chat pipeline —
 * a later slice composes these into a tool and a render. They mirror the grounding
 * engine's result-type style: a discriminated union on `found` and a decline-reason
 * string union, so callers branch instead of catching.
 */

/** Why a weather lookup declined to return a reading. */
export type WeatherDeclineReason =
  /** The location name didn't geocode to any coordinates. */
  | "location-not-found"
  /** The request exceeded `timeoutMs` (or a caller-supplied signal aborted it). */
  | "timeout"
  /** Non-ok HTTP, a fetch rejection, or a JSON parse failure on either endpoint. */
  | "network-error";

/**
 * A successful current-conditions reading, assembled from a geocode hit plus the
 * forecast's `current` block. Temperatures are reported in both Celsius and
 * Fahrenheit so the caller can phrase a natural-language answer in either unit
 * without re-deriving the conversion. The optional extras are present only when the
 * forecast actually carried them (every field is optional-chained on the wire).
 */
export type WeatherReading = {
  /**
   * A human label assembled from the geocode fields — the non-empty of
   * name / admin1 / country joined with ", " (e.g. "London, England, United Kingdom").
   */
  locationLabel: string;
  /** Current air temperature in degrees Celsius (`temperature_2m`). */
  temperatureC: number;
  /** Current air temperature in degrees Fahrenheit (computed from `temperatureC`). */
  temperatureF: number;
  /** A human-readable description of the sky/precipitation, mapped from the WMO code. */
  conditions: string;
  /** "Feels like" temperature in Celsius (`apparent_temperature`), when present. */
  apparentTemperatureC?: number;
  /** "Feels like" temperature in Fahrenheit (computed), when present. */
  apparentTemperatureF?: number;
  /** Relative humidity as a percentage 0–100 (`relative_humidity_2m`), when present. */
  humidityPercent?: number;
  /** Wind speed in km/h (`wind_speed_10m`), when present. */
  windSpeedKmh?: number;
  /** Current-hour precipitation in mm (`precipitation`), when present. */
  precipitationMm?: number;
  /** Whether it is currently daytime at the location (`is_day` → boolean), when present. */
  isDay?: boolean;
  /** The observation timestamp the provider reports (`current.time`), when present. */
  observedAtIso?: string;
};

/**
 * The outcome of {@link lookupWeather}: either a current-conditions reading, or a
 * structured decline reason. Never throws — callers branch on `found`.
 */
export type WeatherResult =
  | { found: true; reading: WeatherReading }
  | { found: false; reason: WeatherDeclineReason };

/** Per-call knobs for the weather primitives. Same shape as `GroundingRequestOptions`. */
export type WeatherRequestOptions = {
  /** A caller-owned abort signal. If it aborts, the in-flight fetch aborts. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_WEATHER_TIMEOUT_MS}. */
  timeoutMs?: number;
};
