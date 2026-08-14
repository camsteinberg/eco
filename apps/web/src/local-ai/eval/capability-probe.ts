// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The capability probe — a fixed, blind, everyday-task set (28 tasks).
 *
 * This is the runnable form of the frozen instrument authored in eco-notes
 * `decisions/capability-probe-2026-08-12.md`, seeded by the live real-eyes pass
 * (the study-guide bounce). It measures the two things real users bounced on:
 *   - DID-IT (intent): did the model produce the asked-for artifact/answer in
 *     its FIRST reply, or defer/hedge/ask permission?
 *   - FACTS (knowledge): are the stated facts correct?
 *
 * Scoring is deliberately BLIND and by-hand against the doc's vetted answer key
 * with published tolerance bands — NOT the automated rubric (which is provably
 * blind to answer quality and would re-introduce the self-graded trap the
 * refocus diagnosed). So these specs intentionally carry NO `expectedAnswers` /
 * `forbiddenAnswers` / `judge` fields: the harness runs them only to CAPTURE the
 * first-response output; a human judge reads `result.output` against the key.
 *
 * Each task's `intent` is computed at module load through the SAME production
 * classifier `inferChatIntent` that `useChat` runs on a live turn, so the
 * harness composes every prompt (per-intent hint + generation profile) exactly
 * as production dispatch would for that text. The set is a derived probe pool
 * (like the everyday sets): it is NOT in the harness's default checked-in pool,
 * and rides as session-scoped `extraPrompts`, selectable by the
 * `capability-probe` category, so routine scorecard composites are unaffected.
 *
 * Task text is verbatim from the frozen spec (casual, lowercase — how a real
 * non-technical person types); the em-dash in A8 is the author's fixture input,
 * not product copy.
 */

import { inferChatIntent } from '../../lib/chat-intent';
import type { EvalPromptSpec } from './types';

/** One raw task: its stable id and the verbatim user prompt. */
type CapabilityProbeTask = { id: string; prompt: string };

/**
 * The 28 tasks, grouped as in the spec:
 *   A (9) produce-an-artifact / do-a-task — intent stress
 *   B (5) look-up / factual — knowledge stress
 *   C (5) reason / figure-out
 *   D (4) transform (do it, don't explain)
 *   E (5) explain / how-to
 */
const CAPABILITY_PROBE_TASKS: readonly CapabilityProbeTask[] = [
  // ── A. Produce-an-artifact / do-a-task (intent stress) ──
  { id: 'cap-a1', prompt: 'please make a study guide for an upcoming final exam i have on calc 1' },
  { id: 'cap-a2', prompt: 'write a quick email to my landlord asking him to fix the leaking tap in the bathroom' },
  { id: 'cap-a3', prompt: "i'm going to portugal for a week in october, make me a packing list" },
  { id: 'cap-a4', prompt: 'give me a 20 minute beginner workout i can do at home with no equipment' },
  { id: 'cap-a5', prompt: 'turn this into a grocery list: i want to make spaghetti bolognese and a caesar salad for 4 people' },
  { id: 'cap-a6', prompt: "write a short birthday message for my coworker sarah who's turning 30" },
  { id: 'cap-a7', prompt: "i've got a job interview tomorrow and i'm really nervous, any tips to calm down and do well" },
  { id: 'cap-a8', prompt: "we can't decide between getting a cat or a dog as our first pet — which is easier for a busy first-timer" },
  { id: 'cap-a9', prompt: 'write me a short funny poem about mondays' },

  // ── B. Look-up / factual (knowledge stress) ──
  { id: 'cap-b1', prompt: "what's the capital of australia" },
  { id: 'cap-b2', prompt: 'how many bones are in the adult human body' },
  { id: 'cap-b3', prompt: "what's the boiling point of water in fahrenheit" },
  { id: 'cap-b4', prompt: 'roughly how far is the moon from earth' },
  { id: 'cap-b5', prompt: "how do you say 'where is the bathroom' in spanish" },

  // ── C. Reason / figure-out ──
  { id: 'cap-c1', prompt: 'a bat and a ball cost $1.10 together. the bat costs $1 more than the ball. how much is the ball?' },
  { id: 'cap-c2', prompt: "if a shirt is $40 and it's 25% off, what do i pay" },
  { id: 'cap-c3', prompt: "i've got $50 for dinner for 2 including a 20% tip. roughly how much can the food itself cost?" },
  { id: 'cap-c4', prompt: 'my flight is at 6am and i want to be at the airport 90 minutes before. it\'s a 40 minute drive. what time should i leave?' },
  { id: 'cap-c5', prompt: 'which is bigger, 3/4 or 5/8?' },

  // ── D. Transform (do the transform, don't explain) ──
  { id: 'cap-d1', prompt: "proofread this: 'Their going to the store tomorow to by some new close for the party.'" },
  { id: 'cap-d2', prompt: "summarize this in one sentence: 'The museum will close early on Friday for a private event. Regular hours resume Saturday. Members get free entry all weekend as an apology.'" },
  { id: 'cap-d3', prompt: "make this more formal: 'hey can u send me that file whenever, no rush thx'" },
  { id: 'cap-d4', prompt: "shorten this into a text message: 'I wanted to let you know that I'm running about fifteen minutes behind schedule and should arrive at approximately quarter past seven.'" },

  // ── E. Explain / how-to ──
  { id: 'cap-e1', prompt: 'explain how a credit score works, simply' },
  { id: 'cap-e2', prompt: "what's the difference between a virus and a bacteria" },
  { id: 'cap-e3', prompt: "explain what compound interest is like i'm 12" },
  { id: 'cap-e4', prompt: 'why is the sky blue' },
  { id: 'cap-e5', prompt: 'how do i get a red wine stain out of a white shirt' },
] as const;

/**
 * The 28 capability-probe specs. `intent` is the production classification of
 * each prompt, so the harness's per-intent hint + generation profile match
 * exactly what a live `/chat` turn would apply to that text.
 */
export const CAPABILITY_PROBE_PROBES: EvalPromptSpec[] = CAPABILITY_PROBE_TASKS.map((task) => ({
  id: task.id,
  category: 'capability-probe',
  intent: inferChatIntent(task.prompt),
  prompt: task.prompt,
}));
