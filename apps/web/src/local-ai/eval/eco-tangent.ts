// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eco-tangent A/B — experiment set, identity-sentence arms, and the tangent
 * flagger (reporting path only).
 *
 * Root cause #2 of the prompt-persona quality pass: the hypothesis
 * that the on-device prompt's "You are Eco" identity sentence primes small
 * models toward unprompted ecology talk. This module is the
 * measure-first machinery behind that A/B.
 *
 * THREE pieces, deliberately isolated from the curated felt set:
 *   1. ECO_TANGENT_PROBES — a session-scoped experiment set (~15 single-turn +
 *      3 multi-turn), NEVER merged into FELT_PROBES. Fed to the harness via
 *      `EvalRunConfig.extraPrompts`; the felt set is the bar and this must not
 *      dilute it.
 *   2. The identity-sentence arms + `applyEcoTangentArm` — a LOCAL, UNSHIPPED
 *      parameterization threaded through `EvalRunConfig.identityArm`. It swaps
 *      only the first sentence of the base system prompt; the rest is untouched.
 *      The A/B never lands in prod code — only the winning sentence ships, as a
 *      one-line change to `ON_DEVICE_PROMPT`.
 *   3. `flagEcoTangent` / `reportEcoTangentFlags` — a lexicon flagger on the
 *      REPORTING path. It surfaces replies for HUMAN confirmation and never
 *      touches scoring: a flagged reply is a candidate, not a failure. The
 *      metric is the human-confirmed tangent rate per arm × model.
 */

import type { EvalPromptSpec, EvalResult, EvalRun } from './types';

// ─── Identity-sentence arms (A/B/C) ──────────────────────────────────────────

/** The three candidate identity-sentence arms under test. */
export type EcoTangentArm = 'A' | 'B' | 'C';

/**
 * Arm A — control: the live first sentence of `ON_DEVICE_PROMPT`
 * (lib/system-prompt.ts), VERBATIM. It must stay byte-identical to the shipped
 * sentence, or `applyEcoTangentArm` silently no-ops for B/C. The drift guard is
 * a unit test asserting `getOnDeviceSystemPrompt()` still contains this string —
 * we deliberately do NOT import the prod constant (this module must never be a
 * back door that couples the A/B into the shipping prompt).
 */
export const ECO_TANGENT_ARM_A_SENTENCE =
  'You are Eco, a private AI — a compact open model running entirely on this device; conversations stay with the user.';

/**
 * Arm B — name-as-label: the name rides as an appositive label rather than the
 * leading predicate. Smallest diff from control (the tie-break winner per the
 * rubric).
 */
export const ECO_TANGENT_ARM_B_SENTENCE =
  'You are a private AI called Eco — a compact open model running entirely on this device; conversations stay with the user.';

/**
 * Arm C — name-after-facts: the identity facts lead and the name lands last, in
 * its own clause.
 */
export const ECO_TANGENT_ARM_C_SENTENCE =
  'You are a private AI — a compact open model running entirely on this device; conversations stay with the user. Your name is Eco.';

/** The arm → sentence lookup. Arm A is the live sentence (a no-op swap). */
export const ECO_TANGENT_ARM_SENTENCES: Record<EcoTangentArm, string> = {
  A: ECO_TANGENT_ARM_A_SENTENCE,
  B: ECO_TANGENT_ARM_B_SENTENCE,
  C: ECO_TANGENT_ARM_C_SENTENCE,
};

/**
 * Swap the identity sentence for the A/B arm. Replaces the control sentence
 * (arm A, verbatim) with the arm's sentence in the base system prompt, leaving
 * the rest untouched. Arm A returns the prompt unchanged. If the control
 * sentence is not present (prompt drift), the prompt is returned unchanged — the
 * drift-guard unit test is the real catch, so a silent no-op here can never ship
 * a wrong sentence.
 */
export function applyEcoTangentArm(basePrompt: string, arm: EcoTangentArm): string {
  const replacement = ECO_TANGENT_ARM_SENTENCES[arm];
  if (replacement === ECO_TANGENT_ARM_A_SENTENCE) return basePrompt;
  return basePrompt.replace(ECO_TANGENT_ARM_A_SENTENCE, replacement);
}

// ─── Tangent lexicon flagger (reporting path) ────────────────────────────────

/**
 * Case-insensitive lexicon that FLAGS a reply for human tangent review. Each
 * entry pairs the design's stem with a word-boundary pattern: hyphen-suffixed
 * stems (`sustainab-`) match as prefixes (`\w*`); the rest match as whole words
 * or the named variants (`green(er|est)`). Word boundaries keep the obvious
 * non-matches out ("greeting", "greenhouse", "carbonara") while KEEPING the
 * genuinely ambiguous ones IN by design — "development environment" (code),
 * "climate" as weather (travel), "green vegetables" (cooking) all flag, and a
 * human confirms or rejects each. Over-flagging is the intended failure
 * direction: this is a confirm queue, never an auto-fail.
 */
export const ECO_TANGENT_LEXICON: readonly { stem: string; pattern: RegExp }[] = [
  { stem: 'eco-friendly', pattern: /\beco-friendly\b/i },
  { stem: 'sustainab', pattern: /\bsustainab\w*/i },
  { stem: 'environment', pattern: /\benvironment\w*/i },
  { stem: 'carbon', pattern: /\bcarbon\b/i },
  { stem: 'climate', pattern: /\bclimate\b/i },
  { stem: 'planet', pattern: /\bplanet\w*/i },
  { stem: 'green', pattern: /\bgreen(?:er|est)?\b/i },
  { stem: 'recycl', pattern: /\brecycl\w*/i },
  { stem: 'renewable', pattern: /\brenewable\w*/i },
  { stem: 'footprint', pattern: /\bfootprint\w*/i },
  { stem: 'earth-friendly', pattern: /\bearth-friendly\b/i },
];

/** The outcome of running the tangent lexicon over one reply. */
export type EcoTangentFlag = {
  /** True when at least one lexicon stem matched. */
  flagged: boolean;
  /** The distinct lexicon stems that matched, in lexicon order. */
  matchedStems: string[];
};

/**
 * Run the tangent lexicon over one reply. Pure and deterministic. Returns the
 * matched stems for the human confirm queue — it NEVER decides a pass/fail.
 */
export function flagEcoTangent(output: string): EcoTangentFlag {
  const matchedStems: string[] = [];
  for (const { stem, pattern } of ECO_TANGENT_LEXICON) {
    if (pattern.test(output)) matchedStems.push(stem);
  }
  return { flagged: matchedStems.length > 0, matchedStems };
}

// ─── Reporting over a run ────────────────────────────────────────────────────

/** One flagged tangent-probe reply, queued for human confirmation. */
export type EcoTangentFlagRow = {
  promptId: string;
  modelId: string;
  /** Present only on multi-sample runs (mirrors EvalResult.sampleIndex). */
  sampleIndex?: number;
  /** The lexicon stems that matched (why it was flagged). */
  matchedStems: string[];
  /** The full reply, so a human can confirm or reject the tangent. */
  output: string;
};

/** Per-model tally of tangent-probe results and how many the lexicon flagged. */
export type EcoTangentModelTally = {
  modelId: string;
  /** Tangent-probe results scored for this model. */
  total: number;
  /** How many the lexicon flagged (an UPPER bound on confirmed tangents). */
  flagged: number;
};

/**
 * The tangent-flag report for ONE run (one arm). The human runs three arms and
 * compares the confirmed rates; `flags` is the confirm queue that turns the
 * flagged UPPER bound into the confirmed metric.
 */
export type EcoTangentReport = {
  runId: string;
  label: string;
  /** Tangent-probe results considered (across all models in the run). */
  totalResults: number;
  /** How many were flagged by the lexicon (before human confirmation). */
  flaggedResults: number;
  byModel: EcoTangentModelTally[];
  flags: EcoTangentFlagRow[];
};

/**
 * Build the tangent-flag report for a run. Considers ONLY the results whose
 * `promptId` is an eco-tangent probe (the experiment set), so the flagger never
 * touches felt/fixed probes. Errored results (empty output) simply don't flag.
 */
export function reportEcoTangentFlags(run: EvalRun): EcoTangentReport {
  const tangentResults = run.results.filter((r) => ECO_TANGENT_PROBE_IDS.has(r.promptId));
  const flags: EcoTangentFlagRow[] = [];
  const tallies = new Map<string, EcoTangentModelTally>();

  for (const result of tangentResults) {
    const tally = tallies.get(result.modelId) ?? { modelId: result.modelId, total: 0, flagged: 0 };
    tally.total += 1;

    const flag = flagEcoTangent(result.output);
    if (flag.flagged) {
      tally.flagged += 1;
      flags.push(rowForResult(result, flag.matchedStems));
    }
    tallies.set(result.modelId, tally);
  }

  return {
    runId: run.runId,
    label: run.label,
    totalResults: tangentResults.length,
    flaggedResults: flags.length,
    byModel: [...tallies.values()],
    flags,
  };
}

function rowForResult(result: EvalResult, matchedStems: string[]): EcoTangentFlagRow {
  return {
    promptId: result.promptId,
    modelId: result.modelId,
    ...(result.sampleIndex !== undefined ? { sampleIndex: result.sampleIndex } : {}),
    matchedStems,
    output: result.output,
  };
}

// ─── Tangent experiment set ──────────────────────────────────────────────────
//
// ~15 single-turn prompts spanning everyday domains with ZERO environmental
// content, plus three 3-turn mini-scripts (a tangent may surface later in a
// conversation). Deliberately NOT in FELT_PROBES: they carry no automated
// pass/fail — the ONLY signal is the lexicon flag + human confirm — so an
// eco-word here must never fail a probe. `intent` stays in lockstep with the
// live router (a unit test asserts it); the hand-written history turns avoid
// eco-words too, but only the model's OWN reply to the final turn is ever
// flagged (the report scans EvalResult.output, never the scripted history).

export const ECO_TANGENT_PROBES: EvalPromptSpec[] = [
  // ── cooking (2) ──
  {
    id: 'eco-tangent-cooking-pasta',
    category: 'conversation',
    intent: 'quick',
    prompt: "What's a quick pasta dinner I can make on a weeknight?",
    notes: 'Tangent probe: everyday cooking ask, no environmental content. Flagger + human confirm only.',
  },
  {
    id: 'eco-tangent-cooking-substitute',
    category: 'conversation',
    intent: 'explain',
    prompt: "I'm out of eggs — what can I use instead when baking cookies?",
    notes: 'Tangent probe: cooking substitution, no environmental content. Flagger + human confirm only.',
  },
  // ── travel planning (2) ──
  {
    id: 'eco-tangent-travel-weekend',
    category: 'conversation',
    intent: 'explain',
    prompt: 'Where should I go for a relaxing weekend trip near the coast?',
    notes: 'Tangent probe: travel suggestion, no environmental content. Flagger + human confirm only.',
  },
  {
    id: 'eco-tangent-travel-pack',
    category: 'conversation',
    intent: 'explain',
    prompt: 'What should I pack for a five-day trip to a warm city?',
    notes: 'Tangent probe: packing help, no environmental content. Flagger + human confirm only.',
  },
  // ── code help (2) ──
  {
    id: 'eco-tangent-code-reverse',
    category: 'code',
    intent: 'code',
    prompt: 'Write a JavaScript function that reverses the words in a sentence.',
    notes: 'Tangent probe: code task, no environmental content. Flagger + human confirm only.',
  },
  {
    id: 'eco-tangent-code-debug',
    category: 'code',
    intent: 'code',
    prompt: 'Why does my Python loop print the same value every time?',
    notes: 'Tangent probe: code debugging, no environmental content. Flagger + human confirm only.',
  },
  // ── fitness ──
  {
    id: 'eco-tangent-fitness-start',
    category: 'conversation',
    intent: 'explain',
    prompt: 'How do I start running if I get winded after one block?',
    notes: 'Tangent probe: fitness beginner ask, no environmental content. Flagger + human confirm only.',
  },
  // ── budgeting ──
  {
    id: 'eco-tangent-budget-groceries',
    category: 'conversation',
    intent: 'explain',
    prompt: 'How can I spend less on groceries each month?',
    notes: 'Tangent probe: budgeting ask, no environmental content. Flagger + human confirm only.',
  },
  // ── writing help ──
  {
    id: 'eco-tangent-writing-email',
    category: 'conversation',
    intent: 'writing',
    prompt: 'Help me write a friendly email asking a coworker to swap shifts.',
    notes: 'Tangent probe: everyday writing task, no environmental content. Flagger + human confirm only.',
  },
  // ── gift ideas ──
  {
    id: 'eco-tangent-gift-ideas',
    category: 'conversation',
    intent: 'deep',
    prompt: 'Can you suggest some gift ideas for my sister who loves cooking?',
    notes: 'Tangent probe: gift brainstorming, no environmental content. Flagger + human confirm only.',
  },
  // ── movie recommendation ──
  {
    id: 'eco-tangent-movie-rec',
    category: 'conversation',
    intent: 'explain',
    prompt: 'Can you recommend a feel-good movie for a rainy afternoon?',
    notes: 'Tangent probe: movie recommendation, no environmental content. Flagger + human confirm only.',
  },
  // ── sleep habits ──
  {
    id: 'eco-tangent-sleep-habits',
    category: 'conversation',
    intent: 'explain',
    prompt: 'What can I do to fall asleep faster at night?',
    notes: 'Tangent probe: sleep-habit advice, no environmental content. Flagger + human confirm only.',
  },
  // ── small talk opener ──
  {
    id: 'eco-tangent-smalltalk-joke',
    category: 'conversation',
    intent: 'quick',
    prompt: 'Tell me a joke.',
    notes: 'Tangent probe: casual small-talk opener, no environmental content. Flagger + human confirm only.',
  },
  // ── party planning ──
  {
    id: 'eco-tangent-party-plan',
    category: 'conversation',
    intent: 'deep',
    prompt: 'Help me plan a birthday party for a ten-year-old.',
    notes: 'Tangent probe: party planning, no environmental content. Flagger + human confirm only.',
  },
  // ── resume bullet ──
  {
    id: 'eco-tangent-resume-bullet',
    category: 'conversation',
    intent: 'writing',
    prompt: 'Rewrite this resume bullet to sound stronger: managed a small team.',
    notes: 'Tangent probe: resume editing, no environmental content. Flagger + human confirm only.',
  },
  // ── multi-turn script A: dinner plan → tweak → shopping list ──
  {
    id: 'eco-tangent-script-dinner-list',
    category: 'conversation',
    intent: 'quick',
    history: [
      { role: 'user', content: 'Help me plan a dinner for four friends this Saturday.' },
      {
        role: 'assistant',
        content:
          "Sure — how about a pasta night: spaghetti, a crisp side salad, garlic bread, and a simple dessert. It's easy to scale for four and most people enjoy it.",
      },
      { role: 'user', content: 'Can you make it vegetarian and a little lighter?' },
      {
        role: 'assistant',
        content:
          'Of course — swap the meat sauce for a tomato-and-basil sauce, keep the side salad, and finish with fresh fruit instead of a heavy dessert.',
      },
    ],
    prompt: 'Now turn that into a shopping list.',
    notes: 'Tangent probe (multi-turn): a tangent may surface deep in a conversation. Final turn only is scored. Flagger + human confirm only.',
  },
  // ── multi-turn script B: trip → packing → budget ──
  {
    id: 'eco-tangent-script-trip-budget',
    category: 'conversation',
    intent: 'explain',
    history: [
      { role: 'user', content: "I'm planning a week-long trip to Lisbon next month." },
      {
        role: 'assistant',
        content:
          'Nice choice — Lisbon is lovely. A week gives you time for the historic neighborhoods, a day trip to Sintra, and plenty of good food.',
      },
      { role: 'user', content: 'What should I pack?' },
      {
        role: 'assistant',
        content:
          'Pack light layers, comfortable walking shoes, a light jacket for evenings, and a small day bag for excursions.',
      },
    ],
    prompt: 'Roughly how much should I budget for the week?',
    notes: 'Tangent probe (multi-turn): a tangent may surface deep in a conversation. Final turn only is scored. Flagger + human confirm only.',
  },
  // ── multi-turn script C: story idea → continue → title ──
  {
    id: 'eco-tangent-script-story-title',
    category: 'conversation',
    intent: 'quick',
    history: [
      { role: 'user', content: 'I have an idea for a short story about a lighthouse keeper.' },
      {
        role: 'assistant',
        content:
          "That's a great premise — a lighthouse keeper offers isolation, routine, and a big view of the sea, which gives you lots of room for mood and reflection.",
      },
      {
        role: 'user',
        content: 'Can you continue the opening line I started: The lamp had not been lit in years.',
      },
      {
        role: 'assistant',
        content:
          'The lamp had not been lit in years, yet every night he climbed the spiral stairs out of habit, resting his hand on the cold glass as if it might remember the light.',
      },
    ],
    prompt: "What's a good title for it?",
    notes: 'Tangent probe (multi-turn): a tangent may surface deep in a conversation. Final turn only is scored. Flagger + human confirm only.',
  },
];

/** The eco-tangent probe ids, for scoping the reporting flagger to the set. */
export const ECO_TANGENT_PROBE_IDS: ReadonlySet<string> = new Set(
  ECO_TANGENT_PROBES.map((p) => p.id),
);
