// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { EcoTool, EcoToolResult } from "./registry";

/**
 * The unit-conversion tool converts between units in five families: temperature,
 * length, mass, volume, and time. Pure TS conversion tables (no deps).
 *
 * `match` is conservative — it only fires on explicit "X <unit> in/to <unit>" or
 * "how many <unit> in a <unit>" phrasing where both units belong to the same
 * recognized family. Idiomatic uses of unit words ("miles to go", "a foot in the
 * door", "how many days in a leap year") never produce two recognized units in
 * the conversion frame, so they abstain.
 */

type UnitFamily = "temperature" | "length" | "mass" | "volume" | "time";

export type UnitArgs = {
  family: UnitFamily;
  /** Canonical id of the source unit (e.g. "mi"). */
  from: string;
  /** Canonical id of the target unit (e.g. "km"). */
  to: string;
  /** The numeric quantity to convert. */
  value: number;
};

/**
 * Each non-temperature unit maps to a factor that converts it TO the family's base
 * unit (length → metres, mass → grams, volume → litres, time → seconds). Display label is the
 * pretty form used in output.
 */
type LinearUnit = { family: Exclude<UnitFamily, "temperature">; toBase: number; label: string };

const LINEAR_UNITS: Record<string, LinearUnit> = {
  // length (base: metre)
  mm: { family: "length", toBase: 0.001, label: "mm" },
  cm: { family: "length", toBase: 0.01, label: "cm" },
  m: { family: "length", toBase: 1, label: "m" },
  km: { family: "length", toBase: 1000, label: "km" },
  in: { family: "length", toBase: 0.0254, label: "in" },
  ft: { family: "length", toBase: 0.3048, label: "ft" },
  yd: { family: "length", toBase: 0.9144, label: "yd" },
  mi: { family: "length", toBase: 1609.344, label: "mi" },
  // mass (base: gram)
  mg: { family: "mass", toBase: 0.001, label: "mg" },
  g: { family: "mass", toBase: 1, label: "g" },
  kg: { family: "mass", toBase: 1000, label: "kg" },
  oz: { family: "mass", toBase: 28.349523125, label: "oz" },
  lb: { family: "mass", toBase: 453.59237, label: "lb" },
  // volume (base: litre)
  ml: { family: "volume", toBase: 0.001, label: "mL" },
  l: { family: "volume", toBase: 1, label: "L" },
  cup: { family: "volume", toBase: 0.2365882365, label: "cup" },
  pt: { family: "volume", toBase: 0.473176473, label: "pt" },
  qt: { family: "volume", toBase: 0.946352946, label: "qt" },
  gal: { family: "volume", toBase: 3.785411784, label: "gal" },
  // time (base: second)
  s: { family: "time", toBase: 1, label: "s" },
  min: { family: "time", toBase: 60, label: "min" },
  h: { family: "time", toBase: 3600, label: "h" },
  day: { family: "time", toBase: 86_400, label: "day" },
  week: { family: "time", toBase: 604_800, label: "week" },
};

const TEMPERATURE_UNITS = new Set(["c", "f", "k"]);

const TEMPERATURE_LABEL: Record<string, string> = { c: "°C", f: "°F", k: "K" };

/**
 * Aliases and surface forms → canonical unit id. Keys are lowercased; the matcher
 * normalizes °/symbols before lookup. Longer / plural forms included.
 */
const UNIT_ALIASES: Record<string, string> = {
  // temperature
  c: "c", celsius: "c", centigrade: "c", "°c": "c",
  f: "f", fahrenheit: "f", "°f": "f",
  k: "k", kelvin: "k",
  // length
  mm: "mm", millimeter: "mm", millimetre: "mm", millimeters: "mm", millimetres: "mm",
  cm: "cm", centimeter: "cm", centimetre: "cm", centimeters: "cm", centimetres: "cm",
  m: "m", meter: "m", metre: "m", meters: "m", metres: "m",
  km: "km", kilometer: "km", kilometre: "km", kilometers: "km", kilometres: "km",
  in: "in", inch: "in", inches: "in",
  ft: "ft", foot: "ft", feet: "ft",
  yd: "yd", yard: "yd", yards: "yd",
  mi: "mi", mile: "mi", miles: "mi",
  // mass
  mg: "mg", milligram: "mg", milligrams: "mg",
  g: "g", gram: "g", grams: "g", gramme: "g", grammes: "g",
  kg: "kg", kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  // volume
  ml: "ml", milliliter: "ml", millilitre: "ml", milliliters: "ml", millilitres: "ml",
  l: "l", liter: "l", litre: "l", liters: "l", litres: "l",
  cup: "cup", cups: "cup",
  pt: "pt", pint: "pt", pints: "pt",
  qt: "qt", quart: "qt", quarts: "qt",
  gal: "gal", gallon: "gal", gallons: "gal",
  // time — no month/year: their length is not fixed, so "how many days in a
  // year" is left to prose (and the datetime tool) rather than answered wrongly.
  s: "s", sec: "s", secs: "s", second: "s", seconds: "s",
  min: "min", mins: "min", minute: "min", minutes: "min",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h",
  day: "day", days: "day",
  week: "week", weeks: "week", wk: "week", wks: "week",
};

function isUnitArgs(value: unknown): value is UnitArgs {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const familyOk =
    v.family === "temperature" ||
    v.family === "length" ||
    v.family === "mass" ||
    v.family === "volume" ||
    v.family === "time";
  return (
    familyOk &&
    typeof v.from === "string" &&
    typeof v.to === "string" &&
    typeof v.value === "number" &&
    Number.isFinite(v.value)
  );
}

/** Resolve a surface unit token to its canonical id, or null if unrecognized. */
function resolveUnit(token: string): string | null {
  const key = token.trim().toLowerCase().replace(/\s+/g, "");
  return UNIT_ALIASES[key] ?? null;
}

function familyOf(unitId: string): UnitFamily | null {
  if (TEMPERATURE_UNITS.has(unitId)) {
    return "temperature";
  }
  const linear = LINEAR_UNITS[unitId];
  return linear ? linear.family : null;
}

/**
 * Build a regex fragment matching any known unit surface form. Sorted longest-first
 * so "miles" wins over "mi" and "feet" over "ft". Word-boundary-anchored.
 */
const UNIT_SURFACE_PATTERN = Object.keys(UNIT_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/**
 * Frame regex: "<number> <unitA> (in|to|into|as|=) <unitB>", optionally led by
 * "convert" / "how many <unitB> in <number> <unitA>".
 */
function matchUnit(userText: string): UnitArgs | null {
  if (typeof userText !== "string" || userText.trim() === "") {
    return null;
  }
  const text = userText.trim();

  // Normalize degree symbols so "32°F" tokenizes as "32 °f".
  const normalized = text
    .replace(/°\s*([cfk])/gi, " °$1 ")
    .replace(/\s+/g, " ")
    .trim();

  // Pattern A: "<number> <unitA> in|to|into|as <unitB>"
  const frameA = new RegExp(
    `(-?\\d+(?:\\.\\d+)?)\\s*(°?\\s*(?:${UNIT_SURFACE_PATTERN}))\\s+(?:in|into|to|as|=)\\s+(°?\\s*(?:${UNIT_SURFACE_PATTERN}))\\b`,
    "i"
  );
  const a = frameA.exec(normalized);
  if (a !== null) {
    const built = build(a[1], a[2], a[3]);
    if (built) {
      return built;
    }
  }

  // Pattern B: "how many <unitB> (are )?in <number> <unitA>"
  const frameB = new RegExp(
    `how many\\s+(°?\\s*(?:${UNIT_SURFACE_PATTERN}))\\s+(?:are\\s+)?(?:in|per)\\s+(-?\\d+(?:\\.\\d+)?)\\s*(°?\\s*(?:${UNIT_SURFACE_PATTERN}))\\b`,
    "i"
  );
  const b = frameB.exec(normalized);
  if (b !== null) {
    // toUnit is first capture, fromUnit + value follow.
    const built = build(b[2], b[3], b[1]);
    if (built) {
      return built;
    }
  }

  // Pattern C: "how many <unitB> (are )?in (a|an|one) <unitA>" — the everyday
  // "how many cups are in a gallon" form, where the quantity is an implicit 1.
  // Anchored on a recognized unit after the article, so "in a marathon" or
  // "in a leap year" abstain.
  const frameC = new RegExp(
    `how many\\s+(°?\\s*(?:${UNIT_SURFACE_PATTERN}))\\s+(?:are\\s+)?(?:in|per)\\s+(?:a|an|one)\\s+(°?\\s*(?:${UNIT_SURFACE_PATTERN}))\\b`,
    "i"
  );
  const c = frameC.exec(normalized);
  if (c !== null) {
    const built = build("1", c[2], c[1]);
    if (built) {
      return built;
    }
  }

  return null;
}

/** Assemble + validate a UnitArgs from raw value/from/to tokens. */
function build(
  rawValue: string | undefined,
  rawFrom: string | undefined,
  rawTo: string | undefined
): UnitArgs | null {
  if (rawValue === undefined || rawFrom === undefined || rawTo === undefined) {
    return null;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return null;
  }
  const from = resolveUnit(rawFrom);
  const to = resolveUnit(rawTo);
  if (from === null || to === null) {
    return null;
  }
  const fromFamily = familyOf(from);
  const toFamily = familyOf(to);
  // Both units must belong to the SAME recognized family. Cross-family ("5 kg in km")
  // and idiomatic single-unit phrases abstain here.
  if (fromFamily === null || toFamily === null || fromFamily !== toFamily) {
    return null;
  }
  if (from === to) {
    return null;
  }
  return { family: fromFamily, from, to, value };
}

function convertTemperature(value: number, from: string, to: string): number {
  // To Celsius first.
  let celsius: number;
  if (from === "c") {
    celsius = value;
  } else if (from === "f") {
    celsius = (value - 32) * (5 / 9);
  } else {
    celsius = value - 273.15;
  }
  // Celsius → target.
  if (to === "c") {
    return celsius;
  }
  if (to === "f") {
    return celsius * (9 / 5) + 32;
  }
  return celsius + 273.15;
}

function convertLinear(value: number, from: string, to: string): number {
  const fromUnit = LINEAR_UNITS[from];
  const toUnit = LINEAR_UNITS[to];
  if (fromUnit === undefined || toUnit === undefined) {
    return Number.NaN;
  }
  return (value * fromUnit.toBase) / toUnit.toBase;
}

/** Round to at most 4 significant decimals, trimming trailing zeros. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  const rounded = Math.round(n * 10_000) / 10_000;
  return String(rounded);
}

function labelOf(family: UnitFamily, unitId: string): string {
  if (family === "temperature") {
    return TEMPERATURE_LABEL[unitId] ?? unitId;
  }
  return LINEAR_UNITS[unitId]?.label ?? unitId;
}

function executeUnit(args: UnitArgs): EcoToolResult {
  const converted =
    args.family === "temperature"
      ? convertTemperature(args.value, args.from, args.to)
      : convertLinear(args.value, args.from, args.to);

  const fromLabel = labelOf(args.family, args.from);
  const toLabel = labelOf(args.family, args.to);
  const valueStr = formatNumber(args.value);
  const resultStr = formatNumber(converted);

  // Temperature labels already carry the symbol; insert a space for linear units.
  const sep = args.family === "temperature" ? "" : " ";
  const display = `${valueStr}${sep}${fromLabel} = ${resultStr}${sep}${toLabel}`;

  return {
    display,
    // Mirrors the calculator note: without "already done … rather than
    // recalculating", small models re-derive the conversion in prose and get it
    // wrong (observed live: tool said 8.0467 km, prose said 16.0935 km).
    forModel: `A unit converter already computed the exact answer: ${display}. State this result as the answer; the conversion is already done, so repeat the value exactly rather than recalculating or showing alternative working.`,
    ok: true,
  };
}

/**
 * Full, human-readable unit names for the friendly summary headline. Falls back
 * to the canonical id when a name is missing (defensive; all shipping units are
 * covered).
 */
const UNIT_FULL_NAME: Record<string, string> = {
  // temperature
  c: "Celsius", f: "Fahrenheit", k: "Kelvin",
  // length
  mm: "millimeters", cm: "centimeters", m: "meters", km: "kilometers",
  in: "inches", ft: "feet", yd: "yards", mi: "miles",
  // mass
  mg: "milligrams", g: "grams", kg: "kilograms", oz: "ounces", lb: "pounds",
  // volume
  ml: "milliliters", l: "liters", cup: "cups", pt: "pints", qt: "quarts", gal: "gallons",
  // time
  s: "seconds", min: "minutes", h: "hours", day: "days", week: "weeks",
};

/** Irregular singulars; every other plural above just drops its trailing "s". */
const UNIT_SINGULAR_NAME: Record<string, string> = { in: "inch", ft: "foot", c: "Celsius", f: "Fahrenheit", k: "Kelvin" };

function unitName(unitId: string, count = 2): string {
  const plural = UNIT_FULL_NAME[unitId] ?? unitId;
  if (count !== 1) {
    return plural;
  }
  return UNIT_SINGULAR_NAME[unitId] ?? plural.replace(/s$/, "");
}

/** Friendly headline: "5 miles → kilometers", "1 gallon → cups". */
function summarizeUnit(args: UnitArgs): string {
  return `${formatNumber(args.value)} ${unitName(args.from, args.value)} → ${unitName(args.to)}`;
}

export const unitTool: EcoTool<UnitArgs> = {
  name: "unit-conversion",
  description:
    "Convert between units of temperature, length, mass, volume, or time (e.g. 5 miles in km, how many cups in a gallon).",
  validate: isUnitArgs,
  match: matchUnit,
  execute: executeUnit,
  summarize: summarizeUnit,
};
