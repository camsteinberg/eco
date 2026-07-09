// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  formatImpactCo2,
  formatImpactEnergy,
  formatImpactWater,
} from "../impact-format";

describe("impact-format", () => {
  it("uses the default presentation precision for share surfaces", () => {
    expect(formatImpactWater(2.5)).toBe("2.50 L");
    expect(formatImpactEnergy(20)).toBe("20.0 Wh");
    expect(formatImpactCo2(12.6)).toBe("12.60 g");
  });

  it("supports dashboard-style compact precision", () => {
    expect(formatImpactWater(2.5, { smallFractionDigits: 1 })).toBe("2.5 L");
    expect(formatImpactCo2(12.6, { smallFractionDigits: 1 })).toBe("12.6 g");
  });

  it("switches to larger units at one thousand", () => {
    expect(formatImpactWater(1000)).toBe("1.0 kL");
    expect(formatImpactEnergy(1000)).toBe("1.0 kWh");
    expect(formatImpactCo2(1000)).toBe("1.0 kg");
  });
});
