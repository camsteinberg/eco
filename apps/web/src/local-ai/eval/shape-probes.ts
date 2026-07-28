// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Answer-shape probe set (Wave 2.6 Stage 0).
 *
 * Measures the implicit-depth miss Cam felt (2026-06-11): teach-shaped asks
 * ("please teach me how to X") get a dramatically better answer when the user
 * adds magic words ("deep explanation") — the deep treatment should arrive
 * WITHOUT them. Probes are lowercase, real-user phrased (pitfall: probe
 * batteries must type like real users) and labeled with the shape the ask
 * deserves (`expectedShape`) plus a `depthMatch` word band.
 *
 * Two exports, deliberately split:
 *
 *   - `SHAPE_PROBES` — production-faithful probes. `intent` is EXACTLY what
 *     `inferChatIntent(prompt)` returns today (a test enforces this, so the
 *     set can't drift from the live router). These join EVERY default harness
 *     run: they are the permanent instrument the Stage-1 classifier is gated
 *     on, and their composite is comparable across runs.
 *
 *   - `SHAPE_RESEARCH_ARMS` — A/B arms that deliberately diverge from
 *     production composition. Post-Stage-1 the set holds (a) the
 *     explicit-phrasing ceiling arms (magic words in the user text — the
 *     reference the host can never inject) and (b) the `*-syshint`
 *     counterfactuals (the retired pre-Stage-1 system-front placement), so
 *     the relocation decision stays re-measurable. The Stage-0 forced-deep
 *     and user-turn arms were retired when Stage 1 made them production
 *     behavior (git remembers; the stored `wave26-stage0-baseline` run holds
 *     their data). Arms run only when `EvalRunConfig.includeResearchArms` is
 *     set, so they never pollute routine scorecard composites.
 *
 * Band calibration rationale (documented once, applies per probe below):
 *   - teaching min 120: Wave-1 live probes measured explain-hinted answers at
 *     ~110–130 words — the band floor sits at the top of that range so an
 *     explain-routed teach ask scores near 1 only when it genuinely develops,
 *     while a quick-routed one (no hint, low temp) lands well under.
 *   - brief max 60–80: generous — production single-fact answers with a chip
 *     run 10–40 words; only real lecturing (the bake-off "lectured on a
 *     3-item list" class) breaches it.
 *   - Bands are proxies for shape, not targets; judge dims confirm structure.
 */

import type { EvalPromptSpec } from './types';

export const SHAPE_PROBES: EvalPromptSpec[] = [
  // ── teaching-shaped (speech-act / skill / goal / plurality framing) ──────
  {
    id: 'as1',
    category: 'answer-shape',
    intent: 'deep', // teach speech-act → teaching shape (Stage 1)
    prompt: 'please teach me how to invest',
    expectedShape: 'teaching',
    depthBand: { minWords: 120 },
    judge: ['taskFit', 'coherence'],
    notes: 'Explicit teach speech-act. Deserves a practical guide: where to start, concrete steps, what matters first.',
  },
  {
    id: 'as2',
    category: 'answer-shape',
    intent: 'deep', // "how do i … better" → teaching shape (Stage 1)
    prompt: 'how do i get better at cooking',
    expectedShape: 'teaching',
    depthBand: { minWords: 120 },
    judge: ['taskFit', 'coherence'],
    notes: 'Skill-improvement framing. Potency base B (see SHAPE_RESEARCH_ARMS).',
  },
  {
    id: 'as3',
    category: 'answer-shape',
    intent: 'deep', // goal-framing ("i want to learn") → teaching shape (Stage 1; was a quick hard-miss)
    prompt: 'i want to learn spanish but dont know where to start',
    expectedShape: 'teaching',
    depthBand: { minWords: 120 },
    judge: ['taskFit', 'coherence'],
    notes: 'Goal-framed, no interrogative — was the canonical Stage-0 hard misroute (quick catch-all). Potency base C.',
  },
  {
    id: 'as4',
    category: 'answer-shape',
    intent: 'deep', // plurality ("give me some tips") → teaching shape (Stage 1; was a quick hard-miss)
    prompt: 'give me some tips on negotiating a raise',
    expectedShape: 'teaching',
    depthBand: { minWords: 100 },
    judge: ['taskFit', 'coherence'],
    notes: "The plan's canonical example: plurality marker (tips), no interrogative — was a Stage-0 quick hard-miss. Potency base A.",
  },
  {
    id: 'as5',
    category: 'answer-shape',
    intent: 'deep', // goal-framing ("im trying to get into") → teaching shape (Stage 1; was a quick hard-miss)
    prompt: 'im trying to get into running',
    expectedShape: 'teaching',
    depthBand: { minWords: 100 },
    judge: ['taskFit', 'coherence'],
    notes: 'Pure goal statement, not even a question. A premium product reads the intent and offers a starting plan.',
  },
  {
    id: 'as6',
    category: 'answer-shape',
    intent: 'deep', // "walk me through" → teaching shape (Stage 1)
    prompt: 'walk me through setting up a monthly budget',
    expectedShape: 'teaching',
    depthBand: { minWords: 120 },
    judge: ['taskFit', 'coherence'],
    notes: 'Process walk-through ask — sections/steps are the natural shape.',
  },
  {
    id: 'as7',
    category: 'answer-shape',
    intent: 'deep', // plurality ("ways to") → teaching shape (Stage 1)
    prompt: 'what are some ways to make my resume stand out',
    expectedShape: 'teaching',
    depthBand: { minWords: 100 },
    judge: ['taskFit', 'coherence'],
    notes: 'Plurality marker (ways) + skill outcome. Several concrete suggestions expected.',
  },
  {
    id: 'as8',
    category: 'answer-shape',
    intent: 'deep', // "help me figure out" → teaching shape (Stage 1)
    prompt: 'help me figure out how to study for finals',
    expectedShape: 'teaching',
    depthBand: { minWords: 100 },
    judge: ['taskFit', 'coherence'],
    notes: 'Help-me + process framing — practical method expected, not one generic tip.',
  },

  // ── focused middle (today's explain register is the right treatment) ─────
  {
    id: 'as9',
    category: 'answer-shape',
    intent: 'explain', // focused shape (single-concept explainer)
    prompt: 'how does compound interest work',
    expectedShape: 'focused',
    depthBand: { minWords: 50 },
    judge: ['taskFit'],
    notes: 'Single-concept explainer — developed but on one thread; not a multi-section guide.',
  },
  {
    id: 'as10',
    category: 'answer-shape',
    intent: 'explain', // focused shape (comparison — single-fact veto on "difference between")
    prompt: 'whats the difference between a roth ira and a 401k',
    expectedShape: 'focused',
    depthBand: { minWords: 60 },
    judge: ['taskFit'],
    notes: 'Comparison — both sides plus the distinctions that matter.',
  },
  {
    id: 'as11',
    category: 'answer-shape',
    intent: 'explain', // focused shape (diagnostic why-question)
    prompt: 'why does my bread dough not rise',
    expectedShape: 'focused',
    depthBand: { minWords: 50 },
    judge: ['taskFit'],
    notes: 'Diagnostic question — likely causes and what to check; focused, not a baking course.',
  },

  // ── brief controls (must NOT balloon — over-shoot is the failure) ────────
  {
    id: 'as12',
    category: 'answer-shape',
    intent: 'quick', // single-fact interrogative → brief shape (Stage 1 anti-padding fix)
    prompt: 'what is the capital of australia',
    expectedShape: 'brief',
    expectedAnswers: ['canberra'],
    depthBand: { maxWords: 80 },
    judge: ['taskFit'],
    notes: "Single fact. Rode the explain padding register before Stage 1 (the Wave-1 'polite padding' class) — brief shape fixes the routing half.",
  },
  {
    id: 'as13',
    category: 'answer-shape',
    intent: 'quick', // single-fact interrogative → brief shape
    prompt: 'who wrote the great gatsby',
    expectedShape: 'brief',
    expectedAnswers: ['fitzgerald'],
    depthBand: { maxWords: 80 },
    judge: ['taskFit'],
    notes: 'Single fact — the correctly-brief control (quick-routed before and after Stage 1).',
  },
  {
    id: 'as14',
    category: 'answer-shape',
    intent: 'quick', // single-fact interrogative → brief shape (Stage 1 anti-padding fix)
    prompt: 'when did world war 2 end',
    expectedShape: 'brief',
    expectedAnswers: ['1945'],
    depthBand: { maxWords: 80 },
    judge: ['taskFit'],
    notes: 'Single fact — same padding class as as12; brief shape since Stage 1.',
  },
  {
    id: 'as15',
    category: 'answer-shape',
    intent: 'quick', // explicit length instruction → brief shape (instructions win)
    prompt: 'summarize what a vpn does in one sentence',
    expectedShape: 'brief',
    maxSentences: 1,
    depthBand: { maxWords: 60 },
    judge: ['taskFit'],
    notes: 'Explicit length instruction WINS (inviolable clause) — regression guard for any shape routing.',
  },
  {
    id: 'as16',
    category: 'answer-shape',
    intent: 'quick', // explicit length instruction beats the explain verb → brief shape (Stage 1)
    prompt: 'explain photosynthesis in 2 sentences',
    expectedShape: 'brief',
    maxSentences: 2,
    depthBand: { maxWords: 80 },
    judge: ['taskFit'],
    notes: 'Explain keyword + explicit length cap: instruction must beat the explain hint.',
  },

  // ── short anaphoric follow-ups (register-matching in an ongoing thread) ──
  {
    id: 'as17',
    category: 'answer-shape',
    intent: 'quick', // short anaphoric follow-up → brief shape (register-matching)
    prompt: 'make day 3 harder',
    history: [
      { role: 'user', content: 'give me a simple 5 day workout plan to get started' },
      {
        role: 'assistant',
        content:
          'Here is a simple 5-day plan to get started:\n\n**Day 1 — Walk + stretch.** 20 minutes brisk walking, 5 minutes of gentle stretching.\n**Day 2 — Bodyweight basics.** 2 rounds: 10 squats, 5 push-ups (knees fine), 20-second plank.\n**Day 3 — Walk.** 25 minutes at an easy pace.\n**Day 4 — Bodyweight basics.** Same as day 2, add a round if it felt easy.\n**Day 5 — Longer walk.** 30 minutes, comfortable pace.\n\nKeep the effort easy this first week — consistency matters more than intensity.',
      },
    ],
    expectedShape: 'brief',
    depthBand: { maxWords: 120 },
    judge: ['taskFit', 'coherence'],
    notes: 'Anaphoric edit in an ongoing thread — must match the conversation register (revise day 3), not balloon into a lecture.',
  },
  {
    id: 'as18',
    category: 'answer-shape',
    intent: 'quick', // short anaphoric follow-up ("it" + thread) → brief shape
    prompt: 'what about doing it in an apartment?',
    history: [
      { role: 'user', content: 'how do i start a vegetable garden' },
      {
        role: 'assistant',
        content:
          'Start small and sunny: pick a spot with at least 6 hours of direct light, and begin with a few easy crops — lettuce, radishes, and herbs are forgiving. Prepare the soil by loosening it and mixing in compost, then plant seeds at the depth the packet recommends. Water consistently (the top inch of soil should stay moist), and expect your first harvest in about a month for quick crops. Starting with 3–4 plant types keeps it manageable while you learn what your space wants.',
      },
    ],
    expectedShape: 'focused',
    depthBand: { minWords: 30, maxWords: 250 },
    judge: ['taskFit', 'coherence'],
    notes: 'Elliptical follow-up — adapt the prior subject to the new constraint; mid-register, no restart from scratch.',
  },
  {
    id: 'as19',
    category: 'answer-shape',
    intent: 'quick', // short anaphoric follow-up ("that" + thread) → brief shape
    prompt: 'thanks, can you make that into a checklist',
    history: [
      { role: 'user', content: 'how do i start a vegetable garden' },
      {
        role: 'assistant',
        content:
          'Start small and sunny: pick a spot with at least 6 hours of direct light, and begin with a few easy crops — lettuce, radishes, and herbs are forgiving. Prepare the soil by loosening it and mixing in compost, then plant seeds at the depth the packet recommends. Water consistently (the top inch of soil should stay moist), and expect your first harvest in about a month for quick crops. Starting with 3–4 plant types keeps it manageable while you learn what your space wants.',
      },
    ],
    expectedShape: 'focused',
    depthBand: { maxWords: 250 },
    judge: ['taskFit'],
    notes: 'Format-transform follow-up — reshape the prior content as a checklist; content is already on the table.',
  },
];

// ─── Research arms (run only with includeResearchArms) ─────────────────────
//
// Three bases spanning the teach-shaped asks Stage 0 measured (A = as4 ·
// B = as2 · C = as3 — all route deep naturally since Stage 1):
//   *-explicit  the ask REWRITTEN with magic words — the user-conditioning
//               ceiling the host can never inject. Tracks how close the
//               teaching treatment gets to the explicit-phrasing premium.
//   *-syshint   the SAME deep treatment with the hint joined into the system
//               front (pre-Stage-1 production) — the placement counterfactual
//               that keeps the relocation decision re-measurable.

const ARM_JUDGE: EvalPromptSpec['judge'] = ['taskFit', 'coherence'];
const ARM_BAND = { minWords: 120 } as const;

export const SHAPE_RESEARCH_ARMS: EvalPromptSpec[] = [
  // base A — "give me some tips on negotiating a raise"
  {
    id: 'as4-explicit',
    category: 'answer-shape',
    intent: 'deep', // "detailed"/"in-depth" → LONG_FORM_RE (natural routing)
    prompt: 'give me a detailed, in-depth guide on negotiating a raise',
    expectedShape: 'teaching',
    depthBand: ARM_BAND,
    judge: ARM_JUDGE,
    notes: 'User-conditioning ceiling: magic words in the user text itself.',
  },
  {
    id: 'as4-syshint',
    category: 'answer-shape',
    intent: 'deep', // routes deep naturally since Stage 1
    hintPlacement: 'system',
    prompt: 'give me some tips on negotiating a raise',
    expectedShape: 'teaching',
    depthBand: ARM_BAND,
    judge: ARM_JUDGE,
    notes: 'Placement counterfactual: deep hint in the system front (pre-Stage-1 composition).',
  },
  // base B — "how do i get better at cooking"
  {
    id: 'as2-explicit',
    category: 'answer-shape',
    intent: 'deep', // "detailed"/"in-depth" → LONG_FORM_RE
    prompt: 'give me a detailed, in-depth guide on getting better at cooking',
    expectedShape: 'teaching',
    depthBand: ARM_BAND,
    judge: ARM_JUDGE,
    notes: 'User-conditioning ceiling for base B.',
  },
  {
    id: 'as2-syshint',
    category: 'answer-shape',
    intent: 'deep',
    hintPlacement: 'system',
    prompt: 'how do i get better at cooking',
    expectedShape: 'teaching',
    depthBand: ARM_BAND,
    judge: ARM_JUDGE,
    notes: 'Placement counterfactual for base B.',
  },
  // base C — "i want to learn spanish but dont know where to start"
  {
    id: 'as3-explicit',
    category: 'answer-shape',
    intent: 'deep', // "step-by-step" idiom → LONG_FORM_RE. Bare "plan" stopped
    // matching DEEP_RE when the depth constants were narrowed (2026-07-27); the
    // idiom is what routes this prompt deep now.
    prompt: 'i want to learn spanish but dont know where to start — give me a thorough, step-by-step plan',
    expectedShape: 'teaching',
    depthBand: ARM_BAND,
    judge: ARM_JUDGE,
    notes: 'User-conditioning ceiling for base C.',
  },
  {
    id: 'as3-syshint',
    category: 'answer-shape',
    intent: 'deep',
    hintPlacement: 'system',
    prompt: 'i want to learn spanish but dont know where to start',
    expectedShape: 'teaching',
    depthBand: ARM_BAND,
    judge: ARM_JUDGE,
    notes: 'Placement counterfactual for base C.',
  },
];
