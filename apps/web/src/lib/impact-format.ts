// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

type ImpactFormatOptions = {
  smallFractionDigits?: number;
  largeFractionDigits?: number;
};

function formatScaledMetric(
  value: number,
  {
    threshold,
    divisor,
    smallUnit,
    largeUnit,
    smallFractionDigits,
    largeFractionDigits,
  }: {
    threshold: number;
    divisor: number;
    smallUnit: string;
    largeUnit: string;
    smallFractionDigits: number;
    largeFractionDigits: number;
  },
): string {
  if (value >= threshold) {
    return `${(value / divisor).toFixed(largeFractionDigits)} ${largeUnit}`;
  }

  return `${value.toFixed(smallFractionDigits)} ${smallUnit}`;
}

export function formatImpactWater(
  liters: number,
  { smallFractionDigits = 2, largeFractionDigits = 1 }: ImpactFormatOptions = {},
): string {
  return formatScaledMetric(liters, {
    threshold: 1000,
    divisor: 1000,
    smallUnit: "L",
    largeUnit: "kL",
    smallFractionDigits,
    largeFractionDigits,
  });
}

export function formatImpactEnergy(
  wattHours: number,
  { smallFractionDigits = 1, largeFractionDigits = 1 }: ImpactFormatOptions = {},
): string {
  return formatScaledMetric(wattHours, {
    threshold: 1000,
    divisor: 1000,
    smallUnit: "Wh",
    largeUnit: "kWh",
    smallFractionDigits,
    largeFractionDigits,
  });
}

export function formatImpactCo2(
  grams: number,
  { smallFractionDigits = 2, largeFractionDigits = 1 }: ImpactFormatOptions = {},
): string {
  return formatScaledMetric(grams, {
    threshold: 1000,
    divisor: 1000,
    smallUnit: "g",
    largeUnit: "kg",
    smallFractionDigits,
    largeFractionDigits,
  });
}
