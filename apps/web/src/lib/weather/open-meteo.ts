// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Open-Meteo weather lookup engine (capability wave, slice 1).
 *
 * A pure, self-contained pipeline that turns a location NAME into current
 * conditions via Open-Meteo's keyless public APIs, so on-device chat can answer
 * "what's the weather in London?" with a real reading:
 *   - {@link geocodeLocation}     — city name → coordinates
 *   - {@link fetchCurrentWeather} — coordinates → current conditions
 *   - {@link lookupWeather}       — the orchestrator (geocode FIRST, then forecast)
 *
 * Privacy guarantee (locked, do not break): every request goes DIRECTLY from the
 * browser to Open-Meteo's public endpoints. No proxy, no API key — Eco's servers
 * never see the query. The module is SSR-safe: it touches no browser-only globals
 * at import time (only `fetch`, which is global in both the browser and the
 * Node/test runtime).
 *
 * Failure policy (mirrors the grounding engine): these never throw to the caller.
 * Every outcome degrades to a structured `{ found: false, reason }`. A wrong field
 * path must fall to a decline, never crash.
 *
 * NO CACHE — deliberately. Weather is time-sensitive: a reading is only true for
 * the minute it was fetched, so serving a cached value would be a correctness bug.
 * Every call hits the network fresh. (The grounding engine caches because facts are
 * stable; conditions are not.)
 */

import type {
  WeatherReading,
  WeatherRequestOptions,
  WeatherResult,
} from "./types";

/** Default per-request timeout. Tight, because this gates a chat turn. */
export const DEFAULT_WEATHER_TIMEOUT_MS = 4000;

const GEOCODE_BASE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";

/**
 * The exact `current=` field list we request from the forecast endpoint. Kept as a
 * single constant so the URL builder and the documented response shape can't drift.
 */
const CURRENT_FIELDS = [
  "temperature_2m",
  "relative_humidity_2m",
  "apparent_temperature",
  "is_day",
  "precipitation",
  "weather_code",
  "wind_speed_10m",
].join(",");

// ---------------------------------------------------------------------------
// Fetch plumbing: timeout + caller-signal composition. Single bounded fetch per
// call (no retry, no cache) — Open-Meteo is keyless with generous limits, so the
// grounding engine's Retry-After dance isn't needed here.
// ---------------------------------------------------------------------------

/** Marker so we can tell a timeout/caller abort apart from other rejections. */
class AbortedError extends Error {
  constructor(readonly abortCause: "timeout" | "caller") {
    super(`weather fetch aborted: ${abortCause}`);
    this.name = "AbortedError";
  }
}

/**
 * `fetch` with a bounded timeout, composed with any caller-supplied signal, and an
 * `Accept: application/json` header (Open-Meteo needs no `User-Agent` — and browsers
 * forbid setting one via `fetch` anyway). Resolves to a `Response` (possibly non-ok)
 * or rejects with an {@link AbortedError} (timeout/caller) — every other failure
 * rejects normally so the caller can map it to `network-error`.
 */
async function weatherFetch(
  url: string,
  opts: WeatherRequestOptions | undefined
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WEATHER_TIMEOUT_MS;
  const callerSignal = opts?.signal;

  // Bail immediately if the caller already aborted.
  if (callerSignal?.aborted) {
    throw new AbortedError("caller");
  }

  const controller = new AbortController();

  const onCallerAbort = () => {
    controller.abort("caller");
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => {
    controller.abort("timeout");
  }, timeoutMs);

  try {
    return await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    // Distinguish "we aborted" (timeout/caller) from a genuine network rejection.
    // The abort `reason` we set tells us which fired.
    if (isAbortError(err)) {
      const reason: unknown = controller.signal.reason;
      throw new AbortedError(reason === "caller" ? "caller" : "timeout");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/** Read JSON defensively — a parse failure surfaces as `null`, never a throw. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Defensive response narrowing. The network is the source of truth; every field
// path is guarded so an unexpected shape declines cleanly.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A finite number, or `null` — the only safe way to read a numeric wire field. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-empty trimmed string, or `null`. */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Celsius → Fahrenheit, rounded to one decimal place (clean for an NL answer). */
function celsiusToFahrenheit(celsius: number): number {
  return Math.round((celsius * 1.8 + 32) * 10) / 10;
}

// ---------------------------------------------------------------------------
// WMO weather-code → human description.
// ---------------------------------------------------------------------------

/**
 * The standard WMO weather-interpretation codes Open-Meteo returns in
 * `current.weather_code`, mapped to a short human description. An UNKNOWN code must
 * fall back to a safe generic string — never throw — so a future code addition
 * degrades to a still-usable answer rather than a crash.
 */
const WMO_CODE_DESCRIPTIONS: Readonly<Record<number, string>> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

/** A safe generic fallback for any WMO code we don't have a description for. */
const UNKNOWN_CONDITIONS = "Unknown conditions";

/**
 * Map a WMO `weather_code` to a human description. An unrecognized (or non-integer)
 * code returns {@link UNKNOWN_CONDITIONS} rather than throwing — the answer stays
 * usable even if Open-Meteo introduces a code we haven't mapped.
 */
export function wmoCodeToConditions(code: number): string {
  return WMO_CODE_DESCRIPTIONS[code] ?? UNKNOWN_CONDITIONS;
}

// ---------------------------------------------------------------------------
// geocodeLocation
// ---------------------------------------------------------------------------

/** A geocode hit: the coordinates plus the label fields we assemble into a name. */
type GeocodeHit = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
};

/**
 * The outcome of {@link geocodeLocation}: a single resolved location, or a decline.
 * `location-not-found` is the well-formed-but-zero-results path; `network-error`
 * and `timeout` mirror the fetch failure mapping used everywhere in this module.
 */
type GeocodeResult =
  | { found: true; hit: GeocodeHit }
  | { found: false; reason: "location-not-found" | "timeout" | "network-error" };

/**
 * Resolve a location NAME to coordinates via Open-Meteo's geocoding search.
 *
 * `GET /v1/search?name={name}&count=1&language=en&format=json` →
 *   `{ results?: [ { name, latitude, longitude, country?, admin1? } ] }`.
 *
 * NOTE: the `results` key is ABSENT (not `[]`) when there are zero matches, so a
 * missing/empty/malformed `results` all decline as `location-not-found`. A non-ok
 * HTTP, fetch rejection, or JSON parse failure declines `network-error`; a timeout
 * or caller abort declines `timeout`. Never throws.
 */
export async function geocodeLocation(
  name: string,
  opts?: WeatherRequestOptions
): Promise<GeocodeResult> {
  if (typeof name !== "string" || name.trim() === "") {
    return { found: false, reason: "location-not-found" };
  }

  const url =
    `${GEOCODE_BASE}?name=${encodeURIComponent(name)}` +
    `&count=1&language=en&format=json`;

  try {
    const response = await weatherFetch(url, opts);
    if (!response.ok) {
      return { found: false, reason: "network-error" };
    }

    const payload = await readJson(response);
    // A failed parse (`readJson` → null) is an unreadable response → network-error,
    // distinct from a well-formed payload whose `results` is simply absent/empty.
    if (!isRecord(payload)) {
      return { found: false, reason: "network-error" };
    }

    const results = payload.results;
    // Absent or non-array `results` ⇒ zero matches by Open-Meteo's contract.
    if (!Array.isArray(results) || results.length === 0) {
      return { found: false, reason: "location-not-found" };
    }

    // `Array.isArray` narrows `results` to `any[]`; pin the element back to
    // `unknown` so every field below is read through the defensive guards.
    const first: unknown = results[0];
    if (!isRecord(first)) {
      return { found: false, reason: "location-not-found" };
    }

    const placeName = nonEmptyString(first.name);
    const latitude = finiteNumber(first.latitude);
    const longitude = finiteNumber(first.longitude);
    // Without a name + usable coordinates there is nothing to forecast on.
    if (placeName === null || latitude === null || longitude === null) {
      return { found: false, reason: "location-not-found" };
    }

    const country = nonEmptyString(first.country);
    const admin1 = nonEmptyString(first.admin1);
    const hit: GeocodeHit = {
      name: placeName,
      latitude,
      longitude,
      ...(country !== null ? { country } : {}),
      ...(admin1 !== null ? { admin1 } : {}),
    };
    return { found: true, hit };
  } catch (err) {
    if (err instanceof AbortedError) {
      // Both timeout and caller-abort surface to the user as a timed-out lookup.
      return { found: false, reason: "timeout" };
    }
    return { found: false, reason: "network-error" };
  }
}

// ---------------------------------------------------------------------------
// fetchCurrentWeather
// ---------------------------------------------------------------------------

/** The narrowed `current` block we need from the forecast response. */
type CurrentConditions = {
  weatherCode: number;
  temperatureC: number;
  apparentTemperatureC?: number;
  humidityPercent?: number;
  windSpeedKmh?: number;
  precipitationMm?: number;
  isDay?: boolean;
  observedAtIso?: string;
};

/** The outcome of {@link fetchCurrentWeather}: a narrowed `current` block, or a decline. */
type ForecastResult =
  | { found: true; current: CurrentConditions }
  | { found: false; reason: "timeout" | "network-error" };

/**
 * Fetch the current conditions at a coordinate pair.
 *
 * `GET /v1/forecast?latitude={lat}&longitude={lon}&current={fields}&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto`
 *   → `{ current?: { time, temperature_2m, weather_code, ... } }`.
 *
 * Only `weather_code` + `temperature_2m` are required for a usable reading; the rest
 * are optional extras read defensively (present ⇒ included). A missing/malformed
 * `current` block, or absent required fields, declines `network-error` (the response
 * was readable but unusable). A non-ok HTTP / fetch rejection / parse failure also
 * declines `network-error`; a timeout or caller abort declines `timeout`. Never throws.
 */
export async function fetchCurrentWeather(
  latitude: number,
  longitude: number,
  opts?: WeatherRequestOptions
): Promise<ForecastResult> {
  const url =
    `${FORECAST_BASE}?latitude=${encodeURIComponent(String(latitude))}` +
    `&longitude=${encodeURIComponent(String(longitude))}` +
    `&current=${CURRENT_FIELDS}` +
    `&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto`;

  try {
    const response = await weatherFetch(url, opts);
    if (!response.ok) {
      return { found: false, reason: "network-error" };
    }

    const payload = await readJson(response);
    if (!isRecord(payload)) {
      return { found: false, reason: "network-error" };
    }

    const current = payload.current;
    if (!isRecord(current)) {
      return { found: false, reason: "network-error" };
    }

    // Required: a weather code and an air temperature. Without these the reading
    // can't carry a "what's it like" answer, so we decline rather than half-fill it.
    const weatherCode = finiteNumber(current.weather_code);
    const temperatureC = finiteNumber(current.temperature_2m);
    if (weatherCode === null || temperatureC === null) {
      return { found: false, reason: "network-error" };
    }

    // Optional extras: include each only when it's actually present and well-formed.
    const apparentC = finiteNumber(current.apparent_temperature);
    const humidity = finiteNumber(current.relative_humidity_2m);
    const windKmh = finiteNumber(current.wind_speed_10m);
    const precipMm = finiteNumber(current.precipitation);
    const isDayRaw = finiteNumber(current.is_day);
    const observedAt = nonEmptyString(current.time);

    const narrowed: CurrentConditions = {
      weatherCode,
      temperatureC,
      ...(apparentC !== null ? { apparentTemperatureC: apparentC } : {}),
      ...(humidity !== null ? { humidityPercent: humidity } : {}),
      ...(windKmh !== null ? { windSpeedKmh: windKmh } : {}),
      ...(precipMm !== null ? { precipitationMm: precipMm } : {}),
      ...(isDayRaw !== null ? { isDay: isDayRaw === 1 } : {}),
      ...(observedAt !== null ? { observedAtIso: observedAt } : {}),
    };
    return { found: true, current: narrowed };
  } catch (err) {
    if (err instanceof AbortedError) {
      return { found: false, reason: "timeout" };
    }
    return { found: false, reason: "network-error" };
  }
}

// ---------------------------------------------------------------------------
// lookupWeather — the orchestrator
// ---------------------------------------------------------------------------

/**
 * Resolve a location NAME to its current conditions.
 *
 * Pipeline (strictly serial — never fires both requests at once, mirroring the
 * grounding engine):
 *   1. {@link geocodeLocation} → coordinates + a human label. Zero matches →
 *      decline `location-not-found` WITHOUT touching the forecast endpoint.
 *   2. {@link fetchCurrentWeather} (only on a geocode hit) → the `current` block.
 *   3. Assemble a {@link WeatherReading}: label, C + F temps, conditions from the
 *      WMO code map, and whatever optional extras the forecast carried.
 *
 * Failure mapping: a geocode "not found" stays `location-not-found`; any timeout or
 * caller abort on either leg becomes `timeout`; any non-ok HTTP / fetch rejection /
 * parse failure becomes `network-error`. Never throws — callers branch on `found`.
 */
export async function lookupWeather(
  locationName: string,
  opts?: WeatherRequestOptions
): Promise<WeatherResult> {
  const geocoded = await geocodeLocation(locationName, opts);
  if (!geocoded.found) {
    return { found: false, reason: geocoded.reason };
  }

  const { hit } = geocoded;
  const forecast = await fetchCurrentWeather(hit.latitude, hit.longitude, opts);
  if (!forecast.found) {
    return { found: false, reason: forecast.reason };
  }

  const reading = assembleReading(hit, forecast.current);
  return { found: true, reading };
}

/** Build the human location label from the non-empty of name / admin1 / country. */
function buildLocationLabel(hit: GeocodeHit): string {
  return [hit.name, hit.admin1, hit.country]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(", ");
}

/** Compose a {@link WeatherReading} from a geocode hit and the narrowed conditions. */
function assembleReading(
  hit: GeocodeHit,
  current: CurrentConditions
): WeatherReading {
  return {
    locationLabel: buildLocationLabel(hit),
    temperatureC: current.temperatureC,
    temperatureF: celsiusToFahrenheit(current.temperatureC),
    conditions: wmoCodeToConditions(current.weatherCode),
    ...(current.apparentTemperatureC !== undefined
      ? {
          apparentTemperatureC: current.apparentTemperatureC,
          apparentTemperatureF: celsiusToFahrenheit(current.apparentTemperatureC),
        }
      : {}),
    ...(current.humidityPercent !== undefined
      ? { humidityPercent: current.humidityPercent }
      : {}),
    ...(current.windSpeedKmh !== undefined
      ? { windSpeedKmh: current.windSpeedKmh }
      : {}),
    ...(current.precipitationMm !== undefined
      ? { precipitationMm: current.precipitationMm }
      : {}),
    ...(current.isDay !== undefined ? { isDay: current.isDay } : {}),
    ...(current.observedAtIso !== undefined
      ? { observedAtIso: current.observedAtIso }
      : {}),
  };
}
