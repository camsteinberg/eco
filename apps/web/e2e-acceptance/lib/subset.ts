// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Which tasks and which picks this acceptance run walks.
 *
 * The full lane is the product verdict: eleven tasks, both shipping models, the
 * better part of an hour each. That cost is the right price for a verdict and
 * the wrong price for the question "is the lane itself still working?" — which
 * is asked far more often, usually right after someone edits the walk.
 *
 * `ECO_ACCEPTANCE_SMOKE=1` answers that second question in about ten minutes:
 * the everyday pick only, and only the three tasks that exercise the lane's own
 * machinery end to end — a cold-start reply (session plumbing, slot binding,
 * real generation), the tool cards (the non-generation path), and the model
 * switch there and back (the switcher flow, on a second model).
 *
 * The subset also skips the origin wipe, because wiping it re-downloads both
 * models and no ten-minute run survives that. So a smoke run is a self-test of
 * the lane, never an acceptance verdict — the report says so in its header.
 *
 * `ECO_ACCEPTANCE_TASKS=2,4` narrows further still, to exactly the tasks named,
 * for the case "I changed one task and want to see it walk" — about four
 * minutes for a single task (s42, measured 5×). It implies a smoke run and it
 * likewise leaves the origin alone, so the profile stays warm and the models
 * stay downloaded. When both `ECO_ACCEPTANCE_TASKS` and `ECO_ACCEPTANCE_SMOKE`
 * are set, the explicit task list WINS: it is the more specific instruction.
 *
 * Everything here is pure and env-injected so it can be unit-tested without a
 * browser; the spec reads `process.env` once and passes the plan around.
 */

/** The lane's tasks, in the order the README lists them. */
export const ACCEPTANCE_TASKS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** The three tasks the smoke subset walks. */
export const SMOKE_TASKS: readonly number[] = [1, 4, 8];

export const SMOKE_ENV_VAR = "ECO_ACCEPTANCE_SMOKE";

/** Comma-separated task numbers, e.g. `ECO_ACCEPTANCE_TASKS=2,4`. */
export const TASKS_ENV_VAR = "ECO_ACCEPTANCE_TASKS";

export type AcceptancePlan = {
  /** True when the run is the ten-minute self-test rather than the full walk. */
  smoke: boolean;
  /** The tasks this run walks, in order. */
  tasks: readonly number[];
  /** Whether the run starts from a genuinely cold origin. */
  wipesOrigin: boolean;
};

const AFFIRMATIVE = new Set(["1", "true", "yes", "on"]);

/**
 * Parse an explicit task list: positive integers, in the order given, deduped.
 * Anything that is not a positive integer is ignored rather than fatal — a
 * stray space or a typo should narrow the run, not abort it minutes in.
 */
function parseTasks(raw: string | undefined): number[] {
  const seen = new Set<number>();
  const tasks: number[] = [];
  for (const part of (raw ?? "").split(",")) {
    const value = Number(part.trim());
    if (!Number.isInteger(value) || value <= 0 || part.trim() === "" || seen.has(value)) continue;
    seen.add(value);
    tasks.push(value);
  }
  return tasks;
}

/** Read the plan from an environment. Anything but an affirmative flag is the full walk. */
export function acceptancePlan(
  env: Record<string, string | undefined> = process.env,
): AcceptancePlan {
  const smoke = AFFIRMATIVE.has((env[SMOKE_ENV_VAR] ?? "").trim().toLowerCase());
  // The explicit list beats the smoke flag: it is the more specific request.
  const only = parseTasks(env[TASKS_ENV_VAR]);
  if (only.length > 0) return { smoke: true, tasks: only, wipesOrigin: false };
  return {
    smoke,
    tasks: smoke ? SMOKE_TASKS : ACCEPTANCE_TASKS,
    wipesOrigin: !smoke,
  };
}

/** Does this run walk that task? */
export function planWalksTask(plan: AcceptancePlan, task: number): boolean {
  return plan.tasks.includes(task);
}

/**
 * The picks this run walks: all of them, or just the first — which is the
 * everyday pick, declared first in the spec for exactly that reason.
 *
 * Note this narrows only what is WALKED. Both models still get provisioned,
 * because task 8 has to have somewhere to switch to.
 */
export function planPicks<T>(plan: AcceptancePlan, picks: readonly T[]): readonly T[] {
  return plan.smoke ? picks.slice(0, 1) : picks.slice();
}
