// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_TASKS,
  SMOKE_ENV_VAR,
  SMOKE_TASKS,
  acceptancePlan,
  planPicks,
  planWalksTask,
} from "../lib/subset";

const PICKS = [
  { tileName: "Eco Fast" },
  { tileName: "Eco Deeper" },
] as const;

describe("acceptancePlan", () => {
  it("is the full walk when the flag is absent", () => {
    const plan = acceptancePlan({});
    expect(plan.smoke).toBe(false);
    expect(plan.tasks).toEqual(ACCEPTANCE_TASKS);
    expect(plan.wipesOrigin).toBe(true);
  });

  it("is the full walk when the flag is off", () => {
    for (const value of ["", "0", "false", "no"]) {
      expect(acceptancePlan({ [SMOKE_ENV_VAR]: value }).smoke, value).toBe(false);
    }
  });

  it("is the smoke subset when the flag is set", () => {
    const plan = acceptancePlan({ [SMOKE_ENV_VAR]: "1" });
    expect(plan.smoke).toBe(true);
    expect(plan.tasks).toEqual(SMOKE_TASKS);
    // A wipe would re-download both models, which is the opposite of a
    // ten-minute self-test.
    expect(plan.wipesOrigin).toBe(false);
  });

  it("accepts the other affirmative spellings of the flag", () => {
    for (const value of ["true", "TRUE", " 1 ", "yes"]) {
      expect(acceptancePlan({ [SMOKE_ENV_VAR]: value }).smoke, value).toBe(true);
    }
  });
});

describe("planWalksTask", () => {
  it("walks all ten tasks in a full run", () => {
    const plan = acceptancePlan({});
    for (const task of ACCEPTANCE_TASKS) {
      expect(planWalksTask(plan, task), `task ${task}`).toBe(true);
    }
  });

  it("walks only tasks 1, 4 and 8 in a smoke run", () => {
    const plan = acceptancePlan({ [SMOKE_ENV_VAR]: "1" });
    const walked = ACCEPTANCE_TASKS.filter((task) => planWalksTask(plan, task));
    expect(walked).toEqual([1, 4, 8]);
  });
});

describe("planPicks", () => {
  it("walks every pick in a full run", () => {
    expect(planPicks(acceptancePlan({}), PICKS)).toEqual(PICKS);
  });

  it("walks only the first pick in a smoke run", () => {
    const plan = acceptancePlan({ [SMOKE_ENV_VAR]: "1" });
    expect(planPicks(plan, PICKS)).toEqual([{ tileName: "Eco Fast" }]);
  });

  it("leaves the caller's array untouched", () => {
    const plan = acceptancePlan({ [SMOKE_ENV_VAR]: "1" });
    planPicks(plan, PICKS);
    expect(PICKS).toHaveLength(2);
  });
});
