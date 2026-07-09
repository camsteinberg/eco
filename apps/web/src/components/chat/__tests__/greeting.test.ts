// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { timeGreeting } from "../greeting";

/** Build a local-time Date at the given hour/minute (date component is irrelevant). */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 0, 1, hour, minute, 0, 0);
}

describe("timeGreeting", () => {
  it("returns evening just before the morning boundary (04:59)", () => {
    expect(timeGreeting(at(4, 59))).toBe("Good evening.");
  });

  it("switches to morning at 05:00 and holds through 11:59", () => {
    expect(timeGreeting(at(5, 0))).toBe("Good morning.");
    expect(timeGreeting(at(11, 59))).toBe("Good morning.");
  });

  it("switches to afternoon at 12:00 and holds through 16:59", () => {
    expect(timeGreeting(at(12, 0))).toBe("Good afternoon.");
    expect(timeGreeting(at(16, 59))).toBe("Good afternoon.");
  });

  it("switches to evening at 17:00 and holds through midnight", () => {
    expect(timeGreeting(at(17, 0))).toBe("Good evening.");
    expect(timeGreeting(at(0, 0))).toBe("Good evening.");
  });
});
