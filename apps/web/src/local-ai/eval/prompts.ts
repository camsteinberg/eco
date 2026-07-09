// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Fixed eval prompt set.
 *
 * A small, stable set of prompts spanning the quality dimensions on-device
 * chat must get right: factual recall, arithmetic, reasoning, code, format
 * adherence, instruction-following, appropriate uncertainty, clean stopping,
 * and conversational tone. Ids are stable contract — do not renumber.
 *
 * Each spec carries only the automated-check inputs that apply to it; the
 * rubric (rubric.ts) reads those and a human/LLM judge fills the `judge` dims.
 */

import type { EvalPromptSpec } from './types';

export const EVAL_PROMPTS: EvalPromptSpec[] = [
  {
    id: 'fk1',
    category: 'factual-known',
    intent: 'quick',
    prompt: 'What is the capital of France?',
    expectedAnswers: ['paris'],
  },
  {
    id: 'fk2',
    category: 'factual-known',
    intent: 'quick',
    prompt: 'Who wrote the play Romeo and Juliet?',
    expectedAnswers: ['shakespeare'],
  },
  {
    id: 'm1',
    category: 'math',
    intent: 'quick',
    prompt: 'What is 17 times 24? Reply with just the number.',
    expectedAnswers: ['408'],
  },
  {
    id: 'm2',
    category: 'math',
    intent: 'quick',
    prompt:
      'A train travels 60 miles in 1.5 hours. What is its average speed in miles per hour? Reply with just the number.',
    expectedAnswers: ['40'],
  },
  {
    id: 'r1',
    category: 'reasoning',
    intent: 'deep',
    prompt:
      'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?',
    expectedAnswers: ['0.05', '5 cents', 'five cents'],
    forbiddenAnswers: ['0.10', '10 cents', 'ten cents'],
    judge: ['taskFit'],
  },
  {
    id: 'c1',
    category: 'code',
    intent: 'code',
    prompt:
      'Write a TypeScript function named reverseString that takes a string and returns it reversed. Respond with code only.',
    requireCodeBlock: true,
    expectedAnswers: ['reversestring'],
    judge: ['taskFit'],
  },
  {
    id: 's1',
    category: 'summarization',
    intent: 'writing',
    prompt:
      "Summarize the following text in exactly one sentence:\n\nThe greenhouse effect is the process by which greenhouse gases such as carbon dioxide and methane trap heat in a planet's atmosphere. Sunlight passes through the atmosphere and warms the surface, which then radiates heat back out. Greenhouse gases absorb some of this outgoing heat and re-emit it, keeping the planet warmer than it would otherwise be.",
    maxSentences: 1,
    judge: ['taskFit', 'coherence'],
  },
  {
    id: 'if1',
    category: 'instruction-following',
    intent: 'quick',
    prompt: 'Reply with only the word READY and nothing else.',
    exactReply: 'READY',
  },
  {
    id: 'if2',
    category: 'instruction-following',
    intent: 'quick',
    prompt: 'List exactly three fruits, one per line, with no other text.',
    requireLineCount: 3,
  },
  {
    id: 'if3',
    category: 'instruction-following',
    // Wave 2.6 Stage 1: explicit length instruction → brief shape → quick
    // (production truth — and the gates run caught the old explain pin
    // manufacturing a hint-vs-instruction conflict production never sends).
    intent: 'quick',
    prompt: 'Answer in exactly one sentence: why is the sky blue?',
    maxSentences: 1,
    judge: ['taskFit'],
  },
  {
    id: 'u1',
    category: 'uncertainty',
    intent: 'quick',
    prompt: 'What did I eat for breakfast this morning?',
    expectDecline: true,
    judge: ['taskFit'],
  },
  {
    id: 'u2',
    category: 'uncertainty',
    intent: 'quick',
    prompt: 'What is the population of the town of Briznor Hollow as of 2027?',
    expectDecline: true,
    judge: ['taskFit'],
  },
  {
    id: 'st1',
    category: 'stop-behavior',
    intent: 'quick',
    prompt: 'Say only the word OK and stop.',
    exactReply: 'OK',
  },
  // ── Gemma LiteRT fair-shot gates (2026-06-17) ──────────────────────────
  // These stay model-neutral in scoring, but they target the failure classes
  // seen in Gemma LiteRT integration work: extra prose after exact replies,
  // over-long single-sentence asks, bullets despite "no bullets", and concise
  // teaching shape. They are part of every final model pass.
  {
    id: 'if4',
    category: 'instruction-following',
    intent: 'quick',
    prompt: 'What color is a ripe banana? Reply with one word only.',
    expectedAnswers: ['yellow'],
    exactReply: 'yellow',
  },
  {
    id: 'if5',
    category: 'instruction-following',
    intent: 'quick',
    prompt: 'No bullets: give two quick reasons sleep matters.',
    maxSentences: 2,
    forbidBullets: true,
    depthBand: { maxWords: 45 },
    judge: ['taskFit'],
    notes: 'Must answer in prose, not markdown/list bullets, while still giving two useful reasons.',
  },
  {
    id: 'if6',
    category: 'instruction-following',
    intent: 'quick',
    prompt: 'Answer in exactly one sentence: what does photosynthesis do?',
    maxSentences: 1,
    depthBand: { maxWords: 35 },
    judge: ['taskFit'],
    notes: 'Should be one concise sentence that captures the core conversion of light, water, and carbon dioxide into plant food.',
  },
  {
    id: 'st2',
    category: 'stop-behavior',
    intent: 'quick',
    prompt: 'Say only the word DONE and stop.',
    exactReply: 'DONE',
  },
  {
    id: 'cv1',
    category: 'conversation',
    intent: 'explain',
    prompt: "I'm feeling stressed about a work deadline tomorrow. Any quick advice?",
    judge: ['coherence', 'taskFit'],
  },
  {
    id: 'j1',
    category: 'format-json',
    intent: 'quick',
    prompt:
      'Return a JSON object with keys "name" and "age" for a person named Sam who is 30 years old. Respond with JSON only.',
    requireJsonKeys: ['name', 'age'],
  },
  // ── Richness probes (chat #7) ──────────────────────────────────────────
  // Deliberately phrased the way real users type (lowercase, conversational —
  // see pitfall: probe batteries must type like real users). They catch the
  // terse failure mode ("super short and not helpful") via the answerDepth
  // floor; the strict probes above (if1/if2/st1) are the regression sentinels
  // proving richness scaffolding doesn't break explicit format instructions.
  {
    id: 'rich1',
    category: 'richness',
    // Wave 2.6 Stage 1: "how do i … better" is a teaching-shaped ask → deep
    // (was explain). Richness probes mirror production routing.
    intent: 'deep',
    prompt: 'how do i get better at public speaking',
    minWords: 60,
    judge: ['taskFit', 'coherence'],
    notes: 'Should give several concrete, practical suggestions — not one generic sentence.',
  },
  {
    id: 'rich2',
    category: 'richness',
    intent: 'explain',
    prompt: 'tell me about the roman empire',
    minWords: 80,
    judge: ['taskFit', 'coherence'],
    notes: 'Open invitation — deserves a developed overview, not a single fact.',
  },
  {
    id: 'rich3',
    category: 'richness',
    // Wave 2.6 Stage 1: opinion question with no teaching/brief signals →
    // focused shape → explain (the old quick catch-all is gone; uncertainty
    // routes to the focused middle).
    intent: 'explain',
    prompt: 'is it worth learning to code in 2026',
    minWords: 50,
    judge: ['taskFit'],
    notes: 'Opinion ask, no explicit depth words — tests that the focused register develops a balanced take.',
  },
  {
    id: 'rich4',
    category: 'richness',
    intent: 'explain',
    prompt: 'whats the difference between a virus and bacteria',
    minWords: 60,
    judge: ['taskFit'],
    notes: 'Comparison ask — should cover both sides with the distinctions that matter.',
  },
  {
    id: 'rich5',
    category: 'richness',
    intent: 'deep',
    prompt: 'give exactly three short bullet lines: how can i get better at public speaking',
    requireLineCount: 3,
    depthBand: { minWords: 24, maxWords: 70 },
    judge: ['taskFit', 'coherence'],
    notes: 'Concise teaching ask — should produce exactly three practical bullet lines, not a generic paragraph or sprawling guide.',
  },
];
