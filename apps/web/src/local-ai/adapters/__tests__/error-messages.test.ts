// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  LOCAL_COOLDOWN_MESSAGE,
  LOCAL_GENERATION_REPEATED_MESSAGE,
  LOCAL_RUNTIME_HICCUP_MESSAGE,
  describeLocalCooldownMessage,
} from "../error-messages";

describe("centralized on-device failure copy", () => {
  it("pins the repeated-failure escalation copy exactly", () => {
    expect(LOCAL_GENERATION_REPEATED_MESSAGE).toBe(
      "On-device AI hit the same snag again. Eco reset the model for a fresh start — if it keeps happening, a lighter model may run better on this device.",
    );
  });

  it("pins the runtime-hiccup copy byte-identical to the persisted literal", () => {
    // chat-recovery.ts writes this onto persisted assistant messages, and
    // ErrorMessage matches it by exact string — it must never drift.
    expect(LOCAL_RUNTIME_HICCUP_MESSAGE).toBe(
      "On-device AI needed a moment. Try again on this device to pick up where you left off.",
    );
  });
});

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
