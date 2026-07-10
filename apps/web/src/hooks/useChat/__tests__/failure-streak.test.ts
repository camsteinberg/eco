// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from "vitest";
import {
  recordLocalGenerationFailure,
  resetLocalGenerationFailureStreak,
  _resetFailureStreakForTesting,
} from "../failure-streak";

describe("failure-streak", () => {
  beforeEach(() => {
    _resetFailureStreakForTesting();
  });

  it("increments consecutive failures for the same model key", () => {
    expect(recordLocalGenerationFailure("model-a")).toBe(1);
    expect(recordLocalGenerationFailure("model-a")).toBe(2);
    expect(recordLocalGenerationFailure("model-a")).toBe(3);
  });

  it("resets to 1 when the model key changes", () => {
    expect(recordLocalGenerationFailure("model-a")).toBe(1);
    expect(recordLocalGenerationFailure("model-a")).toBe(2);
    // A different model starts a fresh streak.
    expect(recordLocalGenerationFailure("model-b")).toBe(1);
    expect(recordLocalGenerationFailure("model-b")).toBe(2);
  });

  it("resets to 1 after an explicit streak reset", () => {
    expect(recordLocalGenerationFailure("model-a")).toBe(1);
    expect(recordLocalGenerationFailure("model-a")).toBe(2);
    resetLocalGenerationFailureStreak();
    expect(recordLocalGenerationFailure("model-a")).toBe(1);
  });
});
