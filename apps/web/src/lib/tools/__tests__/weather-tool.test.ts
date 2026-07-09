// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the weather data layer so execute() composition is tested without network.
// Hoisted by Vitest above the import below.
vi.mock("../../weather", () => ({
  lookupWeather: vi.fn(),
}));

import { lookupWeather } from "../../weather";
import type { WeatherReading, WeatherResult } from "../../weather";
import {
  weatherTool,
  isWeatherArgs,
  cleanLocation,
  type WeatherArgs,
} from "../weather-tool";
import { detectTool, DEFAULT_TOOLS } from "../index";

const { match, execute, validate, summarize, presentation } = weatherTool;

const mockLookup = vi.mocked(lookupWeather);

/** A minimal found reading; tests override the fields they assert on. */
function reading(overrides: Partial<WeatherReading> = {}): WeatherReading {
  return {
    locationLabel: "London, England, United Kingdom",
    temperatureC: 12,
    temperatureF: 54,
    conditions: "Partly cloudy",
    ...overrides,
  };
}

function foundResult(overrides: Partial<WeatherReading> = {}): WeatherResult {
  return { found: true, reading: reading(overrides) };
}

beforeEach(() => {
  mockLookup.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// match — true positives (location extraction, Title-Case AND lowercase)
// ---------------------------------------------------------------------------

describe("weatherTool.match — extracts the location (precision)", () => {
  const cases: Array<{ input: string; location: string }> = [
    { input: "what's the weather in London", location: "London" },
    { input: "weather in San Francisco", location: "San Francisco" },
    { input: "London weather", location: "London" },
    { input: "san francisco weather", location: "san francisco" },
    { input: "how hot is it in Tokyo right now", location: "Tokyo" },
    { input: "whats the temperature in paris today", location: "paris" },
    { input: "weather forecast for Berlin", location: "Berlin" },
    { input: "is it raining in Seattle", location: "Seattle" },
    { input: "weather for new york please", location: "new york" },
    // Sanity: real places containing "City"/"Town" must NOT be rejected by the
    // NON_PLACE_OBJECTS denylist (city/town are deliberately excluded from it).
    { input: "weather in New York City", location: "New York City" },
    { input: "weather in Mexico City", location: "Mexico City" },
    { input: "weather in Cape Town", location: "Cape Town" },
    // Pin: "the"-prefixed places resolve via the NORMAL path (shared cleanLocation
    // strips the article), NOT the bare follow-up path — the bare-path's
    // determiner+single-word guard must NEVER interfere with this shared code path.
    { input: "weather in the Bronx", location: "Bronx" },
  ];

  for (const { input, location } of cases) {
    it(`matches "${input}" → ${location}`, () => {
      expect(match(input)).toEqual<WeatherArgs>({ location });
    });
  }
});

// ---------------------------------------------------------------------------
// match — abstains (returns null). PRECISION over recall.
// ---------------------------------------------------------------------------

describe("weatherTool.match — abstains (null)", () => {
  const nonMatches: Array<{ input: string; why: string }> = [
    // Weather cue but NO location — NO geolocation, the model asks the user.
    { input: "what's the weather", why: "no location → no geolocation guess" },
    { input: "what's the temperature right now", why: "cue but no place" },
    // No weather cue — grounding (or normal chat) handles these.
    { input: "tell me about London", why: "no weather cue (grounding's frame)" },
    { input: "what is the capital of France", why: "factual, not weather" },
    // Deny-set: creative / definitional / comparison turns that mention weather.
    { input: "write a poem about the weather", why: "creative deny" },
    { input: "what causes weather", why: "definitional deny" },
    { input: "weather vs climate", why: "comparison/definitional deny" },
    // Bare creative / math / greeting — no cue at all.
    { input: "tell me a story about a forest", why: "no cue" },
    { input: "what is 17 x 23", why: "arithmetic, no cue" },
    { input: "how are you today", why: "greeting, no cue" },
    { input: "", why: "empty" },
    { input: "   ", why: "whitespace" },
    // Bare weather nouns must NOT fire (no genuine lookup cue).
    { input: "make it rain", why: "bare 'rain' is not a cue" },
    { input: "she caught a second wind", why: "bare 'wind' is not a cue" },
    // Mid-sentence cue with question/verb scaffolding must NOT steal a frame: the
    // possessive extractor would otherwise capture "what is the best" / "how is the".
    { input: "what is the best weather app", why: "product question, not a lookup" },
    { input: "how is the weather affecting crops", why: "non-place possessive lead" },
    { input: "I want to talk about the weather", why: "conversational, no place" },
    // C1 — false-positive precision: common nouns that geocode to real hamlets must
    // NEVER produce a cited weather reading for a random town.
    { input: "the forecast for sales", why: "business noun (Sales, France)" },
    { input: "forecast for the economy", why: "business noun (Economy, Indiana)" },
    { input: "the forecast for our company looks good", why: "business possessive" },
    { input: "forecast for the quarter", why: "business/temporal noun" },
    { input: "what's the temperature in the engine", why: "indoor/mechanical noun" },
    { input: "humidity in the basement", why: "indoor noun (Basement Point, AR)" },
    { input: "temperature in the room", why: "indoor noun" },
    { input: "I love the weather in autumn", why: "temporal/season noun" },
    { input: "the history of weather forecasting", why: "meta-weather, non-place" },
    // Bare "forecast" is NOT a cue (C1 — business/economics false-positive class).
    // "forecast" fires ONLY when "weather" is co-present ("weather forecast for X").
    { input: "what is the forecast for Berlin", why: "bare forecast, no weather co-cue" },
    // Determiner + single lowercase common noun — categorically not a place.
    { input: "temperature in my office", why: "determiner + indoor noun" },
    { input: "humidity in our building", why: "determiner + indoor noun" },
    // N1 — geographic-abstract nouns that geocode to real hamlets.
    { input: "weather report for the nation", why: "geographic-abstract (nation)" },
  ];

  for (const { input, why } of nonMatches) {
    it(`abstains on "${input}" (${why})`, () => {
      expect(match(input)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// match — FOLLOW-UP path (weather follow-up T2). Reached only when the normal
// path misses AND a weather antecedent (context.lastWeatherLocation) is present.
// ---------------------------------------------------------------------------

describe("weatherTool.match — follow-up path (new-location)", () => {
  // The prior weather turn was London; the host threads its geocoded label in.
  const context = { lastWeatherLocation: "London, England, United Kingdom" };

  const cases: { input: string; location: string }[] = [
    { input: "what about Paris?", location: "Paris" },
    { input: "and Tokyo?", location: "Tokyo" },
    { input: "how about Berlin?", location: "Berlin" },
    { input: "or Madrid?", location: "Madrid" },
    { input: "in San Francisco?", location: "San Francisco" },
    // Bare Title-Case place (Title-Case-only by construction).
    { input: "Paris?", location: "Paris" },
    { input: "New York?", location: "New York" },
  ];

  for (const { input, location } of cases) {
    it(`matches "${input}" → ${location}`, () => {
      expect(match(input, context)).toEqual<WeatherArgs>({ location });
    });
  }
});

describe("weatherTool.match — follow-up path (same-city re-ask)", () => {
  // The context uses the PRODUCTION label shape ("name, admin1, country") — this
  // pins the T1→T2 granularity contract: citation.title is the full DISPLAY label,
  // but the re-fetch needs the BARE city (first comma-segment) because Open-Meteo's
  // geocoder matches a single place token, not a comma-separated qualifier list.
  // A future change to buildLocationLabel's format must not silently break this.
  const context = { lastWeatherLocation: "London, England, United Kingdom" };

  // No NEW location, but a weather cue → re-fetch the SAME prior city.
  // Includes weather-concept re-asks ("and the weather?") where the cue token
  // itself is rejected as a location by NON_PLACE_OBJECTS → falls through to
  // same-city sub-case (b). The returned location must be the BARE city ("London"),
  // NOT the full display label — geocoder-ready.
  const cases = [
    "is it still raining?",
    "what's the temperature now?",
    "is it still cold there?",
    "and the weather?",
    "what about the temperature?",
  ];

  for (const input of cases) {
    it(`re-fetches the prior city for "${input}"`, () => {
      expect(match(input, context)).toEqual<WeatherArgs>({
        location: "London",
      });
    });
  }

  it("handles a bare single-token lastWeatherLocation (no commas)", () => {
    // A bare label like "London" is a no-op for split(",")[0] — still geocoder-ready.
    const bareContext = { lastWeatherLocation: "London" };
    expect(match("is it still raining?", bareContext)).toEqual<WeatherArgs>({
      location: "London",
    });
  });
});

describe("weatherTool.match — follow-up path abstains (null)", () => {
  const context = { lastWeatherLocation: "London, England, United Kingdom" };

  const nonMatches: { input: string; why: string }[] = [
    // Non-place object noun — cleanLocation's C1 denylist still applies.
    { input: "what about the economy?", why: "non-place object noun" },
    // Deny-set fires BEFORE the follow-up path (Guard 1 protects it).
    { input: "write a poem about Paris", why: "creative deny-set" },
    // TEMPORAL follow-ups name a TIME, not a place — must abstain (current-only).
    { input: "what about tomorrow?", why: "temporal, not a place" },
    { input: "and tonight?", why: "temporal, not a place" },
    { input: "what about this weekend?", why: "temporal phrase" },
    // Determiner + object noun — categorically not a place.
    { input: "and what about my basement?", why: "determiner / object noun" },
    // Bare lowercase word must NOT match the Title-Case bare-place pattern.
    { input: "ok?", why: "bare lowercase, not Title-Case place" },
    // Capitalized conversational filler must not geocode (affirmation reject).
    { input: "Sure?", why: "capitalized affirmation, not a place" },
    // A bare capitalized weather-condition word is a re-ask, NOT a place named
    // "Raining" — the bare-Title-Case path rejects it, and with no re-ask cue of
    // its own it abstains (precise: better than geocoding the condition word).
    { input: "Raining?", why: "bare condition word, not a place" },
    { input: "Cold?", why: "bare condition word, not a place" },
    // Weather-concept cue token with no re-ask cue → abstain (safe degrade).
    // "forecast" is NOT in FOLLOWUP_REASK_CUE, so no same-city re-fetch fires.
    { input: "and the forecast?", why: "weather concept, no re-ask cue" },
    // CRITICAL (quality review) — lowercase common nouns that cleanLocation's
    // denylist (tuned for cue-bearing turns) would pass: the Title-Case gate
    // rejects them because a real city follow-up is essentially always capitalized.
    { input: "what about lunch?", why: "lowercase common noun (Title-Case gate)" },
    { input: "and the game?", why: "lowercase common noun (Title-Case gate)" },
    { input: "for work?", why: "lowercase common noun (Title-Case gate)" },
    { input: "at home?", why: "lowercase common noun (Title-Case gate)" },
    { input: "and the news?", why: "lowercase common noun (Title-Case gate)" },
    { input: "what about school?", why: "lowercase common noun (Title-Case gate)" },
    { input: "what about traffic?", why: "lowercase common noun (Title-Case gate)" },
    // Bare lowercase — neither Title-Case gate nor bare-place regex accepts these.
    { input: "dinner?", why: "bare lowercase, not Title-Case place" },
    // Class 1 — "The <common noun>?" leaks via LEADING_ARTICLE strip on the bare
    // path: BARE_TITLECASE_PLACE captures the full span, cleanLocation strips
    // "The" → a single geocodable noun. The determiner+single-word guard rejects.
    { input: "The Plan?", why: "determiner + single word after article strip" },
    { input: "The Game?", why: "determiner + single word after article strip" },
    { input: "The News?", why: "determiner + single word after article strip" },
    // Class 3 — missing weather-condition adjectives now in affirmation reject.
    { input: "Foggy?", why: "bare condition adjective, not a place" },
    { input: "Misty?", why: "bare condition adjective, not a place" },
    { input: "Overcast?", why: "bare condition adjective, not a place" },
  ];

  for (const { input, why } of nonMatches) {
    it(`abstains on "${input}" (${why})`, () => {
      expect(match(input, context)).toBeNull();
    });
  }
});

describe("weatherTool.match — same-city re-ask guard (Title-Case token)", () => {
  const context = { lastWeatherLocation: "London, England, United Kingdom" };

  it("abstains when the turn carries a Title-Case token (possibly-missed new place)", () => {
    // "is it warm in Portland?" — the normal path misses (WEATHER_CUE needs
    // "how warm is it", not "is it warm"), sub-case (a) lead patterns miss, so
    // sub-case (b) FOLLOWUP_REASK_CUE fires on "is it warm". But "Portland" is a
    // Title-Case proper noun that sub-case (a) didn't extract — returning London
    // (the OLD city) would be a wrong-place cited answer. The Title-Case guard
    // catches it and abstains instead → safe degrade.
    expect(match("is it warm in Portland?", context)).toBeNull();
  });

  it("still re-fetches the prior city for a generic re-ask with NO Title-Case token", () => {
    // "is it still raining?" — all lowercase scaffolding, no proper noun.
    // Returns the bare city (first comma-segment), NOT the full display label.
    expect(match("is it still raining?", context)).toEqual<WeatherArgs>({
      location: "London",
    });
  });
});

describe("weatherTool.match — follow-up requires a weather antecedent", () => {
  it("abstains on a new-location follow-up with NO context", () => {
    // No weather turn happened → nothing to follow up on → abstain (unchanged
    // single-arg behaviour: the elliptical turn has no weather cue of its own).
    expect(match("what about Paris?")).toBeNull();
  });

  it("abstains when lastWeatherLocation is undefined", () => {
    expect(match("what about Paris?", { lastGroundedTitle: "Eiffel Tower" })).toBeNull();
  });

  it("abstains when lastWeatherLocation is an empty string", () => {
    expect(match("what about Paris?", { lastWeatherLocation: "" })).toBeNull();
  });
});

describe("weatherTool.match — normal path still wins WITH context set", () => {
  const context = { lastWeatherLocation: "London, England, United Kingdom" };

  it("an explicit 'weather in Paris' resolves via the NORMAL path, not the follow-up", () => {
    // The new city must come from the in-turn extractor, NOT the carried antecedent.
    expect(match("what's the weather in Paris?", context)).toEqual<WeatherArgs>({
      location: "Paris",
    });
  });

  it("the regression case still extracts London (bare-temporal denylist intact)", () => {
    // "weather in London tomorrow": TRAILING_QUALIFIER strips "tomorrow" first, so
    // "London" survives — the bare-temporal NON_PLACE_OBJECTS addition must NOT
    // reject a temporal word that TRAILS a real place.
    expect(match("weather in London tomorrow", context)).toEqual<WeatherArgs>({
      location: "London",
    });
    // Same with no context — identical result.
    expect(match("weather in London tomorrow")).toEqual<WeatherArgs>({
      location: "London",
    });
  });
});

// ---------------------------------------------------------------------------
// cleanLocation — span hygiene
// ---------------------------------------------------------------------------

describe("cleanLocation", () => {
  it("strips trailing temporal qualifiers", () => {
    expect(cleanLocation("Tokyo right now")).toBe("Tokyo");
    expect(cleanLocation("paris today")).toBe("paris");
    expect(cleanLocation("Berlin this weekend")).toBe("Berlin");
  });
  it("strips trailing politeness + punctuation", () => {
    expect(cleanLocation("London please")).toBe("London");
    expect(cleanLocation("London?")).toBe("London");
    expect(cleanLocation("new york, please")).toBe("new york");
  });
  it("rejects an over-long span (a sentence, not a place name)", () => {
    expect(cleanLocation("the place where I grew up many years ago")).toBeNull();
  });
  it("rejects an empty / letterless span", () => {
    expect(cleanLocation("   ")).toBeNull();
    expect(cleanLocation("12345")).toBeNull();
  });
  it("rejects spans containing non-place object nouns (C1)", () => {
    expect(cleanLocation("sales")).toBeNull();
    expect(cleanLocation("the economy")).toBeNull();
    expect(cleanLocation("basement")).toBeNull();
    expect(cleanLocation("autumn")).toBeNull();
    expect(cleanLocation("the room")).toBeNull();
    expect(cleanLocation("our company")).toBeNull();
    expect(cleanLocation("engine")).toBeNull();
  });
  it("rejects determiner + single lowercase common noun (C1)", () => {
    expect(cleanLocation("the future")).toBeNull();
    expect(cleanLocation("next quarter")).toBeNull();
    expect(cleanLocation("my office")).toBeNull();
  });
  it("rejects bare temporal words (weather follow-up T2 — a TIME is not a place)", () => {
    expect(cleanLocation("tomorrow")).toBeNull();
    expect(cleanLocation("tonight")).toBeNull();
    expect(cleanLocation("today")).toBeNull();
    expect(cleanLocation("this weekend")).toBeNull();
  });
  it("still strips a temporal word TRAILING a real place (no regression)", () => {
    // "tomorrow" trailing "London" is stripped by TRAILING_QUALIFIER before the
    // bare-temporal reject runs, so the place survives.
    expect(cleanLocation("London tomorrow")).toBe("London");
    expect(cleanLocation("Tokyo tonight")).toBe("Tokyo");
  });
});

// ---------------------------------------------------------------------------
// execute — FOUND
// ---------------------------------------------------------------------------

describe("weatherTool.execute — found", () => {
  it("injects temp + conditions and emits an Open-Meteo citation", async () => {
    mockLookup.mockResolvedValue(
      foundResult({ temperatureC: 12, temperatureF: 54, conditions: "Light rain" }),
    );

    const result = await execute({ location: "London" });

    expect(result.ok).toBe(true);
    // forModel carries the current-conditions facts and the not-a-forecast guard.
    expect(result.forModel).toContain("12");
    expect(result.forModel).toContain("Light rain");
    expect(result.forModel).toContain("CURRENT conditions");
    // No URL is injected into the model note (the host renders the chip).
    expect(result.forModel).not.toContain("http");

    expect(result.citation).toBeDefined();
    expect(result.citation?.source).toBe("Open-Meteo");
    expect(result.citation?.title).toBe("London, England, United Kingdom");
    expect(result.citation?.url).toBe("https://open-meteo.com/");
    // Weather is current — no recorded year.
    expect(result.citation?.asOf).toBeUndefined();
    // A successful lookup carries a chip, never an uncertainty marker — a
    // "couldn't confirm this" on a real reading would be a trust bug.
    expect(result.verification).toBeUndefined();
  });

  it("includes the present optional extras (feels-like / humidity / wind)", async () => {
    mockLookup.mockResolvedValue(
      foundResult({
        apparentTemperatureC: 9,
        apparentTemperatureF: 48,
        humidityPercent: 80,
        windSpeedKmh: 15,
      }),
    );

    const result = await execute({ location: "London" });
    expect(result.forModel).toContain("Feels like");
    expect(result.forModel).toContain("80%");
    expect(result.forModel).toContain("15 km/h");
  });

  it("clamps the citation title to the untrusted-span bound", async () => {
    const longLabel = "A".repeat(250);
    mockLookup.mockResolvedValue(foundResult({ locationLabel: longLabel }));

    const result = await execute({ location: "London" });
    expect(result.citation?.title.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// execute — DECLINE / DEGRADE (no citation, honest notes)
// ---------------------------------------------------------------------------

describe("weatherTool.execute — location-not-found", () => {
  it("asks the user to clarify and carries NO citation", async () => {
    mockLookup.mockResolvedValue({ found: false, reason: "location-not-found" });

    const result = await execute({ location: "Atlantis" });
    expect(result.ok).toBe(true);
    expect(result.citation).toBeUndefined();
    // Honest: tells the model it couldn't find the place; never a fabricated temp.
    expect(result.forModel.toLowerCase()).toContain("clarify");
    expect(result.forModel).toContain("Atlantis");
    expect(result.forModel).not.toMatch(/°C|°F/);
    // "Which place did you mean?" is a clarification ask, not an unconfirmable
    // claim — no uncertainty marker (that's reserved for the unreachable case).
    expect(result.verification).toBeUndefined();
  });
});

describe("weatherTool.execute — soft-degrade (timeout / network-error)", () => {
  for (const reason of ["timeout", "network-error"] as const) {
    it(`soft-degrades on ${reason} with NO citation and a transient "unreachable" marker`, async () => {
      mockLookup.mockResolvedValue({ found: false, reason });

      const result = await execute({ location: "London" });
      expect(result.ok).toBe(true);
      expect(result.citation).toBeUndefined();
      expect(result.forModel.toLowerCase()).toContain("couldn't reach");
      expect(result.forModel).not.toMatch(/°C|°F/);
      // The host surfaces a transient "couldn't reach the source — try again"
      // marker so the model's hedge is never the only signal. `unreachable`
      // (not `unverified`): the lookup failed, the claim wasn't disproven.
      expect(result.verification).toEqual({ status: "unreachable" });
    });
  }

  it("threads the abort signal into the data layer", async () => {
    mockLookup.mockResolvedValue(foundResult());
    const controller = new AbortController();
    await execute({ location: "London" }, { signal: controller.signal });
    expect(mockLookup).toHaveBeenCalledWith("London", {
      signal: controller.signal,
    });
  });
});

// ---------------------------------------------------------------------------
// Routing / priority order — weather must win the frame before grounding.
// ---------------------------------------------------------------------------

describe("weatherTool — registration & routing", () => {
  it("precedes wikipedia-grounding in DEFAULT_TOOLS", () => {
    const names = DEFAULT_TOOLS.map((t) => t.name);
    const weatherIdx = names.indexOf("weather");
    const groundingIdx = names.indexOf("wikipedia-grounding");
    expect(weatherIdx).toBeGreaterThanOrEqual(0);
    expect(groundingIdx).toBeGreaterThanOrEqual(0);
    expect(weatherIdx).toBeLessThan(groundingIdx);
  });

  it("detectTool routes a weather question to weather (NOT grounding)", () => {
    const hit = detectTool("what's the weather in London");
    expect(hit).not.toBeNull();
    expect(hit!.tool.name).toBe("weather");
  });

  it("a non-weather 'in <City>' turn still goes to grounding", () => {
    const hit = detectTool("tell me about London");
    expect(hit).not.toBeNull();
    expect(hit!.tool.name).toBe("wikipedia-grounding");
  });

  it("is a citation-presentation tool (gates under the web-lookups setting)", () => {
    expect(presentation).toBe("citation");
  });
});

// ---------------------------------------------------------------------------
// isWeatherArgs — runtime type guard
// ---------------------------------------------------------------------------

describe("isWeatherArgs", () => {
  it("accepts a non-empty location", () => {
    expect(isWeatherArgs({ location: "London" })).toBe(true);
    // The tool's own validate is the same guard.
    expect(validate({ location: "Paris" })).toBe(true);
  });
  it("rejects malformed / empty args", () => {
    expect(isWeatherArgs({ location: "" })).toBe(false);
    expect(isWeatherArgs({ location: "   " })).toBe(false);
    expect(isWeatherArgs({ location: 42 })).toBe(false);
    expect(isWeatherArgs({})).toBe(false);
    expect(isWeatherArgs(null)).toBe(false);
    expect(isWeatherArgs("London")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// summarize — friendly headline
// ---------------------------------------------------------------------------

describe("weatherTool.summarize", () => {
  it("frames the location", () => {
    expect(summarize?.({ location: "London" })).toBe('Weather in "London"');
  });
});

// ---------------------------------------------------------------------------
// I1 — ReDoS defense: long input must return null fast, not freeze the tab.
// ---------------------------------------------------------------------------

describe("weatherTool.match — ReDoS defense (I1)", () => {
  it("returns null on a large paste (> MATCH_MAX_LEN) without freezing", () => {
    // 60k chars with no weather cue — the old unbounded possessive regex would
    // catastrophically backtrack (~5.7s). With the entry length guard this returns
    // null in < 1ms.
    const bigPaste = "x ".repeat(30_000);
    const start = performance.now();
    expect(match(bigPaste)).toBeNull();
    const elapsed = performance.now() - start;
    // Generous bound: even on a slow CI runner, < 50ms is trivially safe.
    expect(elapsed).toBeLessThan(50);
  });

  it("returns null on a paste that contains a weather cue buried deep", () => {
    const bigWithCue = "a ".repeat(20_000) + "weather in London";
    expect(match(bigWithCue)).toBeNull();
  });
});
