// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Which tasks and which picks this acceptance run walks.
 *
 * The full lane is the product verdict: ten tasks, both shipping models, the
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
 * Everything here is pure and env-injected so it can be unit-tested without a
 * browser; the spec reads `process.env` once and passes the plan around.
 */

/** The lane's tasks, in the order the README lists them. */
export const ACCEPTANCE_TASKS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** The three tasks the smoke subset walks. */
export const SMOKE_TASKS: readonly number[] = [1, 4, 8];

export const SMOKE_ENV_VAR = "ECO_ACCEPTANCE_SMOKE";

export type AcceptancePlan = {
  /** True when the run is the ten-minute self-test rather than the full walk. */
  smoke: boolean;
  /** The tasks this run walks, in order. */
  tasks: readonly number[];
  /** Whether the run starts from a genuinely cold origin. */
  wipesOrigin: boolean;
};

const AFFIRMATIVE = new Set(["1", "true", "yes", "on"]);

/** Read the plan from an environment. Anything but an affirmative flag is the full walk. */
export function acceptancePlan(
  env: Record<string, string | undefined> = process.env,
): AcceptancePlan {
  const smoke = AFFIRMATIVE.has((env[SMOKE_ENV_VAR] ?? "").trim().toLowerCase());
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
