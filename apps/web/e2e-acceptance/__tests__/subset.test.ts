// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_TASKS,
  RUNTIME_ENV_VAR,
  SMOKE_ENV_VAR,
  SMOKE_TASKS,
  TASKS_ENV_VAR,
  WEBLLM_TASKS,
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
    expect(plan.tasks).toHaveLength(14);
    expect(plan.wipesOrigin).toBe(true);
    expect(plan.runtime).toBe("onnx");
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
  it("walks exactly the tasks named", () => {
    const plan = acceptancePlan({ [TASKS_ENV_VAR]: "2,4" });
    expect(plan.tasks).toEqual([2, 4]);
    expect(plan.smoke).toBe(true);
  });

  it("keeps the list as given; the walk itself decides the running order", () => {
    // The spec runs tasks in its own fixed order (task 7 last, because it ends
    // the page) and only asks the plan WHETHER to walk each one.
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

  it("walks only tasks 1, 4, 8 and 12 in a smoke run", () => {
    const plan = acceptancePlan({ [SMOKE_ENV_VAR]: "1" });
    const walked = ACCEPTANCE_TASKS.filter((task) => planWalksTask(plan, task));
    expect(walked).toEqual([1, 4, 8, 12]);
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

describe("acceptancePlan for a WebLLM run", () => {
  it("walks tasks 1, 12, 13 and 14 without wiping the origin", () => {
    const plan = acceptancePlan({ [RUNTIME_ENV_VAR]: "webllm" });
    expect(plan.runtime).toBe("webllm");
    expect(plan.tasks).toEqual(WEBLLM_TASKS);
    expect(WEBLLM_TASKS).toEqual([1, 12, 13, 14]);
    expect(plan.wipesOrigin).toBe(false);
    // Narrowed by construction, so the report never reads it as a verdict.
    expect(plan.smoke).toBe(true);
  });

  it("is unchanged by the smoke flag", () => {
    const plan = acceptancePlan({ [RUNTIME_ENV_VAR]: "webllm", [SMOKE_ENV_VAR]: "1" });
    expect(plan.tasks).toEqual(WEBLLM_TASKS);
  });

  it("still takes an explicit task list", () => {
    const plan = acceptancePlan({ [RUNTIME_ENV_VAR]: "WebLLM ", [TASKS_ENV_VAR]: "12" });
    expect(plan.runtime).toBe("webllm");
    expect(plan.tasks).toEqual([12]);
  });

  it("walks both WebLLM models, even on a task list", () => {
    const plan = acceptancePlan({ [RUNTIME_ENV_VAR]: "webllm", [TASKS_ENV_VAR]: "12" });
    expect(planPicks(plan, PICKS)).toEqual(PICKS);
  });

  it("treats an empty runtime as the default ONNX walk", () => {
    expect(acceptancePlan({ [RUNTIME_ENV_VAR]: "" }).runtime).toBe("onnx");
    expect(acceptancePlan({ [RUNTIME_ENV_VAR]: "onnx" }).runtime).toBe("onnx");
  });

  it("refuses a runtime it does not know, rather than starting the full walk", () => {
    expect(() => acceptancePlan({ [RUNTIME_ENV_VAR]: "webgpu" })).toThrow(/webgpu/);
  });
});
