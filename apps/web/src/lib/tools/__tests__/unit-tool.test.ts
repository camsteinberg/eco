// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { unitTool, type UnitArgs } from "../unit-tool";

const { match, execute, validate } = unitTool;

describe("unitTool.match — true positives (must match + correct execute)", () => {
  const cases: Array<{ input: string; family: string; resultContains: string }> = [
    { input: "32°F in C", family: "temperature", resultContains: "= 0°C" },
    { input: "convert 100 C to F", family: "temperature", resultContains: "= 212°F" },
    { input: "0 celsius to kelvin", family: "temperature", resultContains: "= 273.15K" },
    { input: "5 miles in km", family: "length", resultContains: "= 8.0467 km" },
    { input: "10 km to miles", family: "length", resultContains: "mi" },
    { input: "how many cm in 6 feet", family: "length", resultContains: "cm" },
    { input: "convert 10 kg to lbs", family: "mass", resultContains: "lb" },
    { input: "2 pounds in grams", family: "mass", resultContains: "g" },
    { input: "1 gallon to liters", family: "volume", resultContains: "L" },
    { input: "500 ml in cups", family: "volume", resultContains: "cup" },
    { input: "100 meters in feet", family: "length", resultContains: "ft" },
  ];

  for (const { input, family, resultContains } of cases) {
    it(`matches and converts "${input}" (${family})`, async () => {
      const args = match(input);
      expect(args, `expected "${input}" to match`).not.toBeNull();
      expect(args!.family).toBe(family);
      const result = await execute(args!);
      expect(result.ok).toBe(true);
      expect(result.display).toContain(resultContains);
    });
  }
});

describe("unitTool.match — exact conversion values", () => {
  it("32°F → 0°C", async () => {
    const result = await execute(match("32°F in C")!);
    expect(result.display).toBe("32°F = 0°C");
  });
  it("100°C → 212°F", async () => {
    const result = await execute(match("convert 100 C to F")!);
    expect(result.display).toBe("100°C = 212°F");
  });
  it("5 miles → 8.0467 km", async () => {
    const result = await execute(match("5 miles in km")!);
    expect(result.display).toBe("5 mi = 8.0467 km");
  });
  it("6 feet → cm (how-many frame)", async () => {
    const args = match("how many cm in 6 feet");
    expect(args).toEqual({ family: "length", from: "ft", to: "cm", value: 6 });
    const result = await execute(args!);
    expect(result.display).toContain("182.88 cm");
  });
});

describe("unitTool.match — false-positive guard (must NOT match)", () => {
  const nonMatches: string[] = [
    "miles to go before I sleep",
    "that's miles better",
    "a foot in the door",
    "I want to get my foot in the door",
    "go the extra mile",
    "he's a few pounds overweight",
    "pound the pavement",
    "a cup of coffee please",
    "fill my cup",
    "the meter is running",
    "she gave him an inch and he took a mile",
    "convert my excitement into action",
  ];

  for (const input of nonMatches) {
    it(`abstains on "${input}"`, () => {
      expect(match(input)).toBeNull();
    });
  }
});

describe("unitTool.match — cross-family and same-unit abstention", () => {
  it("abstains on cross-family conversion (5 kg in km)", () => {
    expect(match("5 kg in km")).toBeNull();
  });
  it("abstains on identical units (5 km in km)", () => {
    expect(match("5 km in km")).toBeNull();
  });
});

describe("unitTool.match — abstention on empty/garbage", () => {
  it("returns null for empty / whitespace", () => {
    expect(match("")).toBeNull();
    expect(match("   ")).toBeNull();
  });
  it("returns null for an unrecognized unit", () => {
    expect(match("5 furlongs in km")).toBeNull();
  });
});

describe("unitTool.validate", () => {
  it("accepts a well-formed args object", () => {
    expect(
      validate({ family: "length", from: "mi", to: "km", value: 5 } satisfies UnitArgs)
    ).toBe(true);
  });
  it("rejects unknown family", () => {
    expect(validate({ family: "speed", from: "mph", to: "kph", value: 5 })).toBe(false);
  });
  it("rejects non-finite value", () => {
    expect(validate({ family: "length", from: "mi", to: "km", value: Number.NaN })).toBe(false);
  });
  it("rejects null / non-object", () => {
    expect(validate(null)).toBe(false);
    expect(validate("5 miles")).toBe(false);
  });
});

describe("unitTool.execute — formatting", () => {
  it("instructs the model to use the exact value", async () => {
    const result = await execute(match("5 miles in km")!);
    expect(result.forModel.toLowerCase()).toContain("exact");
    expect(result.forModel).toContain("8.0467");
  });
});

describe("unitTool.summarize — friendly headline", () => {
  it("renders value + full unit names with an arrow", () => {
    const args = match("5 miles in km")!;
    expect(unitTool.summarize?.(args)).toBe("5 miles → kilometers");
  });

  it("frames a temperature conversion", () => {
    const args = match("32°F in C")!;
    expect(unitTool.summarize?.(args)).toBe("32 Fahrenheit → Celsius");
  });

  it("frames a mass conversion", () => {
    const args = match("convert 10 kg to lbs")!;
    expect(unitTool.summarize?.(args)).toBe("10 kilograms → pounds");
  });
});

describe("unitTool.match — 'how many X in a Y' (one-unit frame)", () => {
  const cases: Array<{ input: string; args: UnitArgs; display: string }> = [
    {
      input: "how many cups are in a gallon",
      args: { family: "volume", from: "gal", to: "cup", value: 1 },
      display: "1 gal = 16 cup",
    },
    {
      input: "how many ounces in a pound",
      args: { family: "mass", from: "lb", to: "oz", value: 1 },
      display: "1 lb = 16 oz",
    },
    {
      input: "how many grams in a kilogram",
      args: { family: "mass", from: "kg", to: "g", value: 1 },
      display: "1 kg = 1000 g",
    },
    {
      input: "How many feet are in one mile?",
      args: { family: "length", from: "mi", to: "ft", value: 1 },
      display: "1 mi = 5280 ft",
    },
    {
      input: "how many minutes are in a day",
      args: { family: "time", from: "day", to: "min", value: 1 },
      display: "1 day = 1440 min",
    },
    {
      input: "how many seconds in an hour",
      args: { family: "time", from: "h", to: "s", value: 1 },
      display: "1 h = 3600 s",
    },
  ];

  for (const { input, args, display } of cases) {
    it(`"${input}" → ${display}`, async () => {
      expect(match(input)).toEqual(args);
      const result = await execute(args);
      expect(result.ok).toBe(true);
      expect(result.display).toBe(display);
    });
  }

  it("headline uses the singular for an implicit 1", () => {
    expect(unitTool.summarize?.(match("how many cups are in a gallon")!)).toBe("1 gallon → cups");
    expect(unitTool.summarize?.(match("how many cm in 1 foot")!)).toBe("1 foot → centimeters");
    expect(unitTool.summarize?.(match("5 miles in km")!)).toBe("5 miles → kilometers");
  });

  it("abstains when the container is not a unit", () => {
    for (const input of [
      "how many miles in a marathon",
      "how many days in a leap year",
      "how many weeks are in a year",
      "how many cups in the cupboard",
      "how many hours in a work week is normal",
    ]) {
      expect(match(input), input).toBeNull();
    }
  });
});
