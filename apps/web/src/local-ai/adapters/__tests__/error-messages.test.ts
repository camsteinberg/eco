// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  LOCAL_COOLDOWN_MESSAGE,
  describeLocalCooldownMessage,
} from "../error-messages";

describe("describeLocalCooldownMessage", () => {
  it("keeps the honest countdown in seconds when under a minute", () => {
    const message = describeLocalCooldownMessage(
      "Eco Everyday is cooling down after a recent crash (30s left).",
    );
    expect(message).toContain("about 30 seconds");
    // The raw model name and the word "crash" never reach the user.
    expect(message).not.toContain("crash");
    expect(message).not.toContain("Eco Everyday");
  });

  it("phrases a longer cooldown in minutes rather than awkward raw seconds", () => {
    const message = describeLocalCooldownMessage(
      "Eco Smart is cooling down after a recent crash (300s left).",
    );
    expect(message).toContain("about 5 minutes");
    expect(message).not.toContain("300 seconds");
  });

  it("singularizes the unit at exactly one minute / one second", () => {
    expect(describeLocalCooldownMessage("cooldown (60s left)")).toContain(
      "about 1 minute",
    );
    expect(describeLocalCooldownMessage("cooldown (1s left)")).toContain(
      "about 1 second",
    );
  });

  it("falls back to the no-precision line when the countdown marker is absent", () => {
    expect(describeLocalCooldownMessage("cooling down, please wait")).toBe(
      LOCAL_COOLDOWN_MESSAGE,
    );
    expect(describeLocalCooldownMessage("(0s left)")).toBe(LOCAL_COOLDOWN_MESSAGE);
  });
});
