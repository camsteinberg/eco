// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Which tasks and which picks this acceptance run walks.
 *
 * The full lane is the product verdict: fourteen tasks, both shipping models, the
 * better part of an hour each. That cost is the right price for a verdict and
 * the wrong price for the question "is the lane itself still working?" — which
 * is asked far more often, usually right after someone edits the walk.
 *
 * `ECO_ACCEPTANCE_SMOKE=1` answers that second question in about ten minutes:
 * the everyday pick only, and only the four tasks that exercise the lane's own
 * machinery end to end — a cold-start reply (session plumbing, slot binding,
 * real generation), the tool cards (the non-generation path), the model switch
 * there and back (the switcher flow, on a second model), and Stop mid-reply
 * followed by the next message (the one action a scripted walk never took
 * until Stop was found to jam the next reply).
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
 * A task list chooses WHICH tasks run, never their order: the walk always runs
 * them in its own order, with task 7 last because it ends the page.
 *
 * `ECO_ACCEPTANCE_RUNTIME=webllm` walks the app's WebLLM models instead of its
 * ONNX ones (see the spec for how the browser is routed there). It is a
 * narrowed run by construction — the four tasks that matter most on that
 * runtime, both of its models, no origin wipe — so it is never a product
 * verdict either.
 *
 * Everything here is pure and env-injected so it can be unit-tested without a
 * browser; the spec reads `process.env` once and passes the plan around.
 */

/** The lane's tasks, in the order the README lists them. */
export const ACCEPTANCE_TASKS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/** The four tasks the smoke subset walks. */
export const SMOKE_TASKS: readonly number[] = [1, 4, 8, 12];

/**
 * What a WebLLM run walks by default: a first reply, then the three things a
 * person does mid-conversation — Stop, Try again after a failure, and edit.
 * Stop used to leave the WebLLM engine locked, so the next message hung; these
 * are the tasks that would have caught it.
 */
export const WEBLLM_TASKS: readonly number[] = [1, 12, 13, 14];

export const SMOKE_ENV_VAR = "ECO_ACCEPTANCE_SMOKE";

/** Comma-separated task numbers, e.g. `ECO_ACCEPTANCE_TASKS=2,4`. */
export const TASKS_ENV_VAR = "ECO_ACCEPTANCE_TASKS";

/** `onnx` (the default) or `webllm`. */
export const RUNTIME_ENV_VAR = "ECO_ACCEPTANCE_RUNTIME";

export type AcceptanceRuntime = "onnx" | "webllm";

export type AcceptancePlan = {
  /** True when the run is narrowed (smoke, a task list, or WebLLM) rather than the full walk. */
  smoke: boolean;
  /** The tasks this run walks. They always run in the walk's own order. */
  tasks: readonly number[];
  /** Whether the run starts from a genuinely cold origin. */
  wipesOrigin: boolean;
  /** Which of the app's runtimes the walked models run on. */
  runtime: AcceptanceRuntime;
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

/**
 * Read the runtime. An unknown value is fatal rather than ignored: a typo would
 * otherwise start the full ONNX walk — an origin wipe and the better part of
 * an hour — when the person asked for something else.
 */
function parseRuntime(raw: string | undefined): AcceptanceRuntime {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "onnx") return "onnx";
  if (value === "webllm") return "webllm";
  throw new Error(
    `${RUNTIME_ENV_VAR}=${String(raw)} is not a runtime this lane walks: use "onnx" (the default) or "webllm".`,
  );
}

/** Read the plan from an environment. Anything but an affirmative flag is the full walk. */
export function acceptancePlan(
  env: Record<string, string | undefined> = process.env,
): AcceptancePlan {
  const runtime = parseRuntime(env[RUNTIME_ENV_VAR]);
  const smoke = AFFIRMATIVE.has((env[SMOKE_ENV_VAR] ?? "").trim().toLowerCase());
  // The explicit list beats the smoke flag: it is the more specific request.
  const only = parseTasks(env[TASKS_ENV_VAR]);
  if (only.length > 0) return { smoke: true, tasks: only, wipesOrigin: false, runtime };
  // A WebLLM run keeps its own profile and is narrowed by construction, so the
  // smoke flag changes nothing about it.
  if (runtime === "webllm") {
    return { smoke: true, tasks: WEBLLM_TASKS, wipesOrigin: false, runtime };
  }
  return {
    smoke,
    tasks: smoke ? SMOKE_TASKS : ACCEPTANCE_TASKS,
    wipesOrigin: !smoke,
    runtime,
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
 *
 * A WebLLM run always walks both of its models: they are small, and a defect
 * on that runtime has shown up on both at once.
 */
export function planPicks<T>(plan: AcceptancePlan, picks: readonly T[]): readonly T[] {
  return plan.smoke && plan.runtime !== "webllm" ? picks.slice(0, 1) : picks.slice();
}
