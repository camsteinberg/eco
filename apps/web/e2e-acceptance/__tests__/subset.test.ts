// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_TASKS,
  SMOKE_ENV_VAR,
  SMOKE_TASKS,
  TASKS_ENV_VAR,
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
    // The count is asserted, not just the identity: a task added to the lane
    // without being added here would otherwise pass silently.
    expect(plan.tasks).toHaveLength(11);
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

describe("acceptancePlan with an explicit task list", () => {
  it("walks exactly the tasks named, in the order given", () => {
    const plan = acceptancePlan({ [TASKS_ENV_VAR]: "2,4" });
    expect(plan.tasks).toEqual([2, 4]);
    expect(plan.smoke).toBe(true);
  });

  it("keeps the caller's order rather than sorting", () => {
    expect(acceptancePlan({ [TASKS_ENV_VAR]: "8,1" }).tasks).toEqual([8, 1]);
  });

  it("dedupes and ignores anything that is not a positive integer", () => {
    expect(acceptancePlan({ [TASKS_ENV_VAR]: " 2 , 2 ,x" }).tasks).toEqual([2]);
    expect(acceptancePlan({ [TASKS_ENV_VAR]: "0,-1,2.5,,3" }).tasks).toEqual([3]);
  });

  it("is the full walk when the list parses to nothing", () => {
    for (const value of ["", "   ", "x,y", "0"]) {
      expect(acceptancePlan({ [TASKS_ENV_VAR]: value }).tasks, value).toEqual(ACCEPTANCE_TASKS);
    }
  });

  it("beats the smoke flag when both are set", () => {
    const plan = acceptancePlan({ [TASKS_ENV_VAR]: "2", [SMOKE_ENV_VAR]: "1" });
    expect(plan.tasks).toEqual([2]);
  });

  it("falls back to the smoke subset when the list is empty and the flag is on", () => {
    const plan = acceptancePlan({ [TASKS_ENV_VAR]: "", [SMOKE_ENV_VAR]: "1" });
    expect(plan.tasks).toEqual(SMOKE_TASKS);
  });

  it("leaves the origin alone, so the profile stays warm", () => {
    // The whole point of a single-task run is ~4 min on already-downloaded
    // models; a wipe would re-download ~2.5 GB first.
    expect(acceptancePlan({ [TASKS_ENV_VAR]: "2" }).wipesOrigin).toBe(false);
  });

  it("walks only the tasks named", () => {
    const plan = acceptancePlan({ [TASKS_ENV_VAR]: "2,4" });
    expect(ACCEPTANCE_TASKS.filter((task) => planWalksTask(plan, task))).toEqual([2, 4]);
  });
});

describe("planWalksTask", () => {
  it("walks every task in a full run", () => {
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
