// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for the Open-Meteo weather lookup engine (capability wave, slice 1).
 *
 * These drive `lookupWeather` (+ the `geocodeLocation` / `fetchCurrentWeather` legs
 * and the `wmoCodeToConditions` map) directly against a mocked `global.fetch`.
 * Fixtures are trimmed real response shapes from Open-Meteo's geocoding + forecast
 * APIs. We assert real behavior — the assembled label, the C→F conversion, the WMO
 * mapping (incl. the unknown-code fallback), serial geocode→forecast ordering, the
 * `Accept` header, every decline path, and timeout/abort handling — not mocks of mocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchCurrentWeather,
  geocodeLocation,
  lookupWeather,
  wmoCodeToConditions,
} from "../open-meteo";

// ─── Fetch mock plumbing ───────────────────────────────────────────────────────

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

let fetchMock: FetchMock;

/** Build a `Response`-like object with the fields our parser reads. */
function jsonResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number }
): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A response whose `.json()` rejects — simulates a malformed JSON body. */
function badJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.reject(new SyntaxError("Unexpected token")),
  } as unknown as Response;
}

/** The URL string of the Nth fetch call (in order). Inputs are always strings here. */
function urlOf(callIndex: number): string {
  const call = fetchMock.mock.calls[callIndex];
  const input = call?.[0];
  return typeof input === "string" ? input : "";
}

/** The headers object passed to the Nth fetch call. */
function headersOf(callIndex: number): Record<string, unknown> {
  const call = fetchMock.mock.calls[callIndex];
  const init = call?.[1];
  return (init?.headers ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Fixtures (trimmed real shapes) ────────────────────────────────────────────

/** A geocoding /search hit for London (count=1). */
const LONDON_GEOCODE = {
  results: [
    {
      id: 2643743,
      name: "London",
      latitude: 51.50853,
      longitude: -0.12574,
      country: "United Kingdom",
      admin1: "England",
      timezone: "Europe/London",
    },
  ],
};

/** A forecast /forecast `current` block (all fields present). */
const LONDON_FORECAST = {
  current: {
    time: "2026-06-13T12:00",
    temperature_2m: 18.4,
    relative_humidity_2m: 62,
    apparent_temperature: 17.1,
    is_day: 1,
    precipitation: 0,
    weather_code: 3,
    wind_speed_10m: 12.6,
  },
  current_units: {
    temperature_2m: "°C",
    wind_speed_10m: "km/h",
  },
};

/** A geocoding response with the `results` key absent — Open-Meteo's zero-match shape. */
const GEOCODE_NO_RESULTS = { generationtime_ms: 0.3 };

// ─── wmoCodeToConditions ───────────────────────────────────────────────────────

describe("wmoCodeToConditions", () => {
  it("maps standard codes to their human descriptions", () => {
    expect(wmoCodeToConditions(0)).toBe("Clear sky");
    expect(wmoCodeToConditions(2)).toBe("Partly cloudy");
    expect(wmoCodeToConditions(3)).toBe("Overcast");
    expect(wmoCodeToConditions(45)).toBe("Fog");
    expect(wmoCodeToConditions(61)).toBe("Slight rain");
    expect(wmoCodeToConditions(71)).toBe("Slight snowfall");
    expect(wmoCodeToConditions(95)).toBe("Thunderstorm");
    expect(wmoCodeToConditions(99)).toBe("Thunderstorm with heavy hail");
  });

  it("falls back to a safe generic string for an unknown code (never throws)", () => {
    expect(wmoCodeToConditions(7)).toBe("Unknown conditions");
    expect(wmoCodeToConditions(-1)).toBe("Unknown conditions");
    expect(wmoCodeToConditions(123456)).toBe("Unknown conditions");
  });
});

// ─── lookupWeather: happy path ─────────────────────────────────────────────────

describe("lookupWeather — success", () => {
  it("geocodes then forecasts and assembles a full reading", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE))
      .mockResolvedValueOnce(jsonResponse(LONDON_FORECAST));

    const result = await lookupWeather("London");

    expect(result.found).toBe(true);
    if (!result.found) return;
    const { reading } = result;

    expect(reading.locationLabel).toBe("London, England, United Kingdom");
    expect(reading.temperatureC).toBe(18.4);
    // 18.4°C → 65.12°F, rounded to one decimal.
    expect(reading.temperatureF).toBe(65.1);
    expect(reading.conditions).toBe("Overcast"); // weather_code 3
    expect(reading.apparentTemperatureC).toBe(17.1);
    expect(reading.apparentTemperatureF).toBe(62.8); // 17.1°C → 62.78 → 62.8
    expect(reading.humidityPercent).toBe(62);
    expect(reading.windSpeedKmh).toBe(12.6);
    expect(reading.precipitationMm).toBe(0);
    expect(reading.isDay).toBe(true);
    expect(reading.observedAtIso).toBe("2026-06-13T12:00");
  });

  it("builds the label from only the non-empty geocode fields", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ name: "Atlantis", latitude: 0, longitude: 0 }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ current: { time: "t", temperature_2m: 10, weather_code: 0 } })
      );

    const result = await lookupWeather("Atlantis");
    expect(result.found).toBe(true);
    if (!result.found) return;
    // No admin1/country → label is just the name (no trailing commas).
    expect(result.reading.locationLabel).toBe("Atlantis");
  });

  it("omits optional extras the forecast did not carry", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE))
      .mockResolvedValueOnce(
        jsonResponse({
          // Only the two required fields — no humidity/wind/apparent/is_day/time.
          current: { temperature_2m: 5, weather_code: 1 },
        })
      );

    const result = await lookupWeather("London");
    expect(result.found).toBe(true);
    if (!result.found) return;
    const { reading } = result;

    expect(reading.temperatureC).toBe(5);
    expect(reading.temperatureF).toBe(41); // 5°C → 41°F exactly
    expect(reading.conditions).toBe("Mainly clear");
    expect(reading.apparentTemperatureC).toBeUndefined();
    expect(reading.apparentTemperatureF).toBeUndefined();
    expect(reading.humidityPercent).toBeUndefined();
    expect(reading.windSpeedKmh).toBeUndefined();
    expect(reading.precipitationMm).toBeUndefined();
    expect(reading.isDay).toBeUndefined();
    expect(reading.observedAtIso).toBeUndefined();
  });

  it("maps is_day:0 to isDay:false", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE))
      .mockResolvedValueOnce(
        jsonResponse({
          current: { temperature_2m: 9, weather_code: 0, is_day: 0 },
        })
      );

    const result = await lookupWeather("London");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.reading.isDay).toBe(false);
  });

  it("sends only the Accept header (no User-Agent) on both requests", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE))
      .mockResolvedValueOnce(jsonResponse(LONDON_FORECAST));

    await lookupWeather("London");

    expect(headersOf(0)).toEqual({ Accept: "application/json" });
    expect(headersOf(1)).toEqual({ Accept: "application/json" });
  });

  it("hits the documented geocode then forecast endpoints in order", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE))
      .mockResolvedValueOnce(jsonResponse(LONDON_FORECAST));

    await lookupWeather("London");

    expect(urlOf(0)).toContain("https://geocoding-api.open-meteo.com/v1/search");
    expect(urlOf(0)).toContain("name=London");
    expect(urlOf(0)).toContain("count=1");
    expect(urlOf(1)).toContain("https://api.open-meteo.com/v1/forecast");
    expect(urlOf(1)).toContain("latitude=51.50853");
    expect(urlOf(1)).toContain("longitude=-0.12574");
    expect(urlOf(1)).toContain("current=temperature_2m");
    expect(urlOf(1)).toContain("timezone=auto");
  });
});

// ─── lookupWeather: serial ordering ────────────────────────────────────────────

describe("lookupWeather — serial ordering", () => {
  it("calls the forecast endpoint only AFTER geocode resolves (serial, not parallel)", async () => {
    const order: string[] = [];
    let resolveGeocode: ((r: Response) => void) | undefined;

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : "";
      if (url.includes("geocoding-api")) {
        order.push("geocode");
        return new Promise<Response>((resolve) => {
          resolveGeocode = resolve;
        });
      }
      order.push("forecast");
      return Promise.resolve(jsonResponse(LONDON_FORECAST));
    });

    const pending = lookupWeather("London");

    // Let the microtask queue drain — forecast must NOT have fired yet.
    await Promise.resolve();
    expect(order).toEqual(["geocode"]);

    resolveGeocode?.(jsonResponse(LONDON_GEOCODE));
    await pending;

    expect(order).toEqual(["geocode", "forecast"]);
  });

  it("never calls the forecast endpoint when geocode finds nothing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(GEOCODE_NO_RESULTS));

    const result = await lookupWeather("Nowherestan");

    expect(result).toEqual({ found: false, reason: "location-not-found" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // forecast never reached
  });
});

// ─── lookupWeather: declines ───────────────────────────────────────────────────

describe("lookupWeather — declines", () => {
  it("declines location-not-found when results key is absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(GEOCODE_NO_RESULTS));
    expect(await lookupWeather("Zzzzz")).toEqual({
      found: false,
      reason: "location-not-found",
    });
  });

  it("declines location-not-found when results is an empty array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
    expect(await lookupWeather("Zzzzz")).toEqual({
      found: false,
      reason: "location-not-found",
    });
  });

  it("declines location-not-found for an empty location name without any fetch", async () => {
    expect(await lookupWeather("   ")).toEqual({
      found: false,
      reason: "location-not-found",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declines network-error on a non-ok geocode response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }));
    expect(await lookupWeather("London")).toEqual({
      found: false,
      reason: "network-error",
    });
  });

  it("declines network-error when the geocode fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await lookupWeather("London")).toEqual({
      found: false,
      reason: "network-error",
    });
  });

  it("declines network-error when geocode JSON fails to parse", async () => {
    fetchMock.mockResolvedValueOnce(badJsonResponse());
    expect(await lookupWeather("London")).toEqual({
      found: false,
      reason: "network-error",
    });
  });

  it("declines network-error on a non-ok forecast response (after a geocode hit)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE))
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 503 }));
    expect(await lookupWeather("London")).toEqual({
      found: false,
      reason: "network-error",
    });
  });

  it("declines network-error when the forecast fetch rejects", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await lookupWeather("London")).toEqual({
      found: false,
      reason: "network-error",
    });
  });

  it("declines network-error when the forecast lacks a current block", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE))
      .mockResolvedValueOnce(jsonResponse({ latitude: 51.5 })); // no `current`
    expect(await lookupWeather("London")).toEqual({
      found: false,
      reason: "network-error",
    });
  });

  it("declines network-error when the forecast lacks the required fields", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE))
      .mockResolvedValueOnce(
        // current exists but has no temperature_2m / weather_code
        jsonResponse({ current: { relative_humidity_2m: 50 } })
      );
    expect(await lookupWeather("London")).toEqual({
      found: false,
      reason: "network-error",
    });
  });

  it("does not throw on a wholly unexpected geocode shape (degrades to network-error)", async () => {
    // A non-object payload is unreadable → network-error (distinct from zero results).
    fetchMock.mockResolvedValueOnce(jsonResponse("totally wrong"));
    expect(await lookupWeather("London")).toEqual({
      found: false,
      reason: "network-error",
    });
  });

  it("declines location-not-found when the first result lacks usable coordinates", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [{ name: "Broken", latitude: "x", longitude: null }] })
    );
    expect(await lookupWeather("Broken")).toEqual({
      found: false,
      reason: "location-not-found",
    });
  });
});

// ─── lookupWeather: timeout + caller abort ─────────────────────────────────────

describe("lookupWeather — timeout and abort", () => {
  it("declines timeout when the geocode request exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    fetchMock.mockImplementation((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = lookupWeather("London", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);

    expect(await pending).toEqual({ found: false, reason: "timeout" });
    expect(clearSpy).toHaveBeenCalled();
  });

  it("declines timeout when the forecast request exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : "";
      if (url.includes("geocoding-api")) {
        return Promise.resolve(jsonResponse(LONDON_GEOCODE));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = lookupWeather("London", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);

    expect(await pending).toEqual({ found: false, reason: "timeout" });
  });

  it("propagates a caller signal abort as a timeout decline", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = lookupWeather("London", { signal: controller.signal });
    controller.abort();

    expect(await pending).toEqual({ found: false, reason: "timeout" });
  });

  it("declines immediately when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await lookupWeather("London", { signal: controller.signal });
    expect(result).toEqual({ found: false, reason: "timeout" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── geocodeLocation (direct leg) ──────────────────────────────────────────────

describe("geocodeLocation", () => {
  it("returns the resolved hit with coordinates and label fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LONDON_GEOCODE));
    const result = await geocodeLocation("London");

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.hit).toEqual({
      name: "London",
      latitude: 51.50853,
      longitude: -0.12574,
      country: "United Kingdom",
      admin1: "England",
    });
  });

  it("omits country/admin1 when the geocode result lacks them", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [{ name: "Spot", latitude: 1.5, longitude: 2.5 }] })
    );
    const result = await geocodeLocation("Spot");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.hit).toEqual({ name: "Spot", latitude: 1.5, longitude: 2.5 });
    expect(result.hit.country).toBeUndefined();
    expect(result.hit.admin1).toBeUndefined();
  });

  it("declines location-not-found for an empty name without any fetch", async () => {
    expect(await geocodeLocation("  ")).toEqual({
      found: false,
      reason: "location-not-found",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── fetchCurrentWeather (direct leg) ──────────────────────────────────────────

describe("fetchCurrentWeather", () => {
  it("narrows the current block to the fields we use", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LONDON_FORECAST));
    const result = await fetchCurrentWeather(51.5, -0.12);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.current).toEqual({
      weatherCode: 3,
      temperatureC: 18.4,
      apparentTemperatureC: 17.1,
      humidityPercent: 62,
      windSpeedKmh: 12.6,
      precipitationMm: 0,
      isDay: true,
      observedAtIso: "2026-06-13T12:00",
    });
  });

  it("declines network-error when current is missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ latitude: 51.5 }));
    expect(await fetchCurrentWeather(51.5, -0.12)).toEqual({
      found: false,
      reason: "network-error",
    });
  });

  it("declines network-error on malformed JSON without throwing", async () => {
    fetchMock.mockResolvedValueOnce(badJsonResponse());
    expect(await fetchCurrentWeather(51.5, -0.12)).toEqual({
      found: false,
      reason: "network-error",
    });
  });
});
