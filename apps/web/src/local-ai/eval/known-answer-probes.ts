// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Known-answer probes — everyday asks with a checkable right answer.
 *
 * WHY THIS EXISTS. The harness's other sets score the SHAPE of a reply: did it
 * stop, did it repeat, did it deliver, did it keep the person's facts. None of
 * them could see that "APR = Annual Percentage Ratio" or "the train arrives at
 * 12:42 AM" is simply wrong (first real read, 2026-08-26). This set asks the
 * other question — is the answer RIGHT — using the rubric's existing
 * `exactness` dim (`expectedAnswers` any-of, `forbiddenAnswers` trap), so no new
 * scorer is introduced and old runs stay comparable.
 *
 * ── HOW TO READ IT ──────────────────────────────────────────────────────────
 *
 * `exactness` per probe: 1 = a right answer is present; 0.5 = right AND a
 * trap answer both present (read by eye — "not $0.10, it's $0.05" is fine);
 * 0 = no right answer stated. The headline is `computeKnownAnswerAccuracy`.
 *
 * ── AUTHORING RULES ─────────────────────────────────────────────────────────
 *
 * - Everyday phrasing, the way a person actually types. No "reply with just the
 *   number": the point is what an ordinary ask gets back, not a benchmark form.
 * - `expectedAnswers` lists the SPELLINGS a right reply plausibly uses
 *   ("4:05", "4:05pm", "16:05"), because the matcher is whole-token literal.
 * - `forbiddenAnswers` only on genuine TRAPS (the classic wrong answer), never
 *   on values a correct explanation legitimately mentions along the way.
 * - No expected answer may appear in the prompt itself (a test scores each
 *   prompt as if it were the reply and requires 0), so a parrot can't pass.
 * - Keys for the lookup/reasoning items mirror the vetted band in eco-notes
 *   `decisions/capability-probe-2026-08-12.md`; the rest are arithmetic.
 * - `intent` is whatever `inferChatIntent` returns TODAY, so the probe always
 *   measures production routing (a test keeps it in lockstep).
 *
 * NOT in the harness's default prompt pool: rides as `extraPrompts` via the
 * diagnostics autorun (`eco-eval-categories=known-answer`).
 */

import { inferChatIntent } from '../../lib/chat-intent';
import type { EvalPromptSpec } from './types';

type KnownAnswerTask = {
  id: string;
  prompt: string;
  expectedAnswers: string[];
  forbiddenAnswers?: string[];
  notes?: string;
};

const TASKS: readonly KnownAnswerTask[] = [
  // ── time arithmetic (both shipping tiers failed this on 2026-08-26) ──
  {
    id: 'ka-time-1',
    prompt: 'my train leaves at 2:15pm and the journey takes 1 hour 50 minutes, what time does it arrive',
    expectedAnswers: ['4:05', '4:05pm', '4.05', '16:05'],
    notes: 'Correct: 4:05pm. Both shipping tiers answered a wrong clock time on the first real read.',
  },
  {
    id: 'ka-time-2',
    prompt:
      "my flight is at 6am and i want to be at the airport 90 minutes before. it's a 40 minute drive. what time should i leave?",
    expectedAnswers: ['3:50', '3:50am', '3.50', '03:50', '3:45', '3:45am'],
    notes: 'Vetted band 3:45–3:50am (capability probe C4).',
  },
  {
    id: 'ka-time-3',
    prompt: 'if i start a 45 minute workout at 6:20 what time do i finish',
    expectedAnswers: ['7:05', '7:05am', '7:05pm', '7.05', '07:05', '19:05'],
  },
  {
    id: 'ka-time-4',
    prompt: 'i need to be at the dentist at 9:30 and it takes 25 minutes to get there, when should i leave',
    expectedAnswers: ['9:05', '9:05am', '9.05', '09:05'],
  },
  {
    id: 'ka-time-5',
    prompt: 'a movie is 2 hours 20 minutes long and starts at 7:40pm, when does it end',
    expectedAnswers: ['10:00', '10:00pm', '10pm', '10 pm', '22:00'],
  },
  {
    id: 'ka-time-6',
    prompt: 'if i drive 120 miles at 60 mph how long does it take',
    expectedAnswers: ['2 hours', 'two hours', '2 hrs', '2h', '2 hr'],
  },
  {
    id: 'ka-time-7',
    prompt: 'if today is wednesday what day is it in 10 days',
    expectedAnswers: ['saturday'],
  },
  // ── money ──
  {
    id: 'ka-money-1',
    prompt: "if a shirt is $40 and it's 25% off, what do i pay",
    expectedAnswers: ['30', '$30', '30.00'],
    notes: 'Vetted key $30 (capability probe C2).',
  },
  {
    id: 'ka-money-2',
    prompt: "dinner was $84, what's a 20% tip",
    expectedAnswers: ['16.80', '16.8', '$16.80'],
  },
  {
    id: 'ka-money-3',
    prompt: 'the bill is $126 and we are splitting it 3 ways, how much each',
    expectedAnswers: ['42', '$42', '42.00'],
  },
  {
    id: 'ka-money-4',
    prompt: 'if i put $1000 in a savings account at 5% a year, how much interest do i earn in the first year',
    expectedAnswers: ['50', '$50', '50.00'],
  },
  {
    id: 'ka-money-5',
    prompt: 'my rent is $1,200 a month, what is that per year',
    expectedAnswers: ['14,400', '14400', '$14,400'],
  },
  {
    id: 'ka-money-6',
    prompt: 'a bat and a ball cost $1.10 together. the bat costs $1 more than the ball. how much is the ball?',
    expectedAnswers: ['0.05', '5 cents', 'five cents', '$.05'],
    forbiddenAnswers: ['0.10', '10 cents', 'ten cents'],
    notes: 'Vetted key $0.05; $0.10 is the trap (capability probe C1).',
  },
  {
    id: 'ka-money-7',
    prompt: 'what does APR mean on a credit card',
    expectedAnswers: ['annual percentage rate'],
    forbiddenAnswers: [
      'annual percentage ratio',
      'annual percent ratio',
      'annual payment rate',
      'annual percentage return',
      'average percentage rate',
    ],
    notes: 'The 350M expanded it as "Annual Percentage Ratio" on the first real read.',
  },
  // ── percentages & arithmetic ──
  { id: 'ka-math-1', prompt: "what's 15% of 80", expectedAnswers: ['12'] },
  {
    id: 'ka-math-2',
    prompt: 'i got 42 out of 60 on a test, what percent is that',
    expectedAnswers: ['70', '70%'],
  },
  { id: 'ka-math-3', prompt: "what's 12 squared", expectedAnswers: ['144'] },
  { id: 'ka-math-4', prompt: 'whats a quarter of 200', expectedAnswers: ['50'] },
  { id: 'ka-math-5', prompt: 'whats 7 times 8', expectedAnswers: ['56'] },
  {
    id: 'ka-math-6',
    prompt: 'a recipe for 4 people needs 300g of pasta, how much do i need for 6 people',
    expectedAnswers: ['450', '450g'],
  },
  {
    id: 'ka-math-7',
    prompt: "i'm 34 and my sister is 5 years younger. how old was she when i was 20?",
    expectedAnswers: ['15', 'fifteen'],
  },
  // ── unit conversions ──
  { id: 'ka-conv-1', prompt: 'how many cups are in a gallon', expectedAnswers: ['16', 'sixteen'] },
  { id: 'ka-conv-2', prompt: 'how many ounces in a pound', expectedAnswers: ['16', 'sixteen'] },
  {
    id: 'ka-conv-3',
    prompt: "what's 30 celsius in fahrenheit",
    expectedAnswers: ['86'],
  },
  {
    id: 'ka-conv-4',
    prompt: 'how much is 5 miles in kilometers',
    expectedAnswers: ['8', '8.0', '8.04', '8.05', '8.1'],
  },
  {
    id: 'ka-conv-5',
    prompt: 'how tall is 6 feet in cm',
    expectedAnswers: ['183', '182', '182.88', '182.9', '182.8', '181.68'],
  },
  {
    id: 'ka-conv-6',
    prompt: 'how many grams in a kilogram',
    expectedAnswers: ['1000', '1,000', 'thousand'],
  },
  {
    id: 'ka-conv-7',
    prompt: 'how many minutes are in a day',
    expectedAnswers: ['1440', '1,440'],
  },
  // ── lookups (vetted keys, capability probe B) ──
  { id: 'ka-fact-1', prompt: "what's the capital of australia", expectedAnswers: ['canberra'] },
  {
    id: 'ka-fact-2',
    prompt: 'how many bones are in the adult human body',
    expectedAnswers: ['206'],
  },
  {
    id: 'ka-fact-3',
    prompt: "what's the boiling point of water in fahrenheit",
    expectedAnswers: ['212', '211', '213'],
    notes: 'Band 211–213°F. A Celsius-only "100" answers the wrong unit.',
  },
  {
    id: 'ka-fact-4',
    prompt: 'roughly how far is the moon from earth',
    expectedAnswers: [
      '384,400',
      '384400',
      '384,000',
      '385,000',
      '380,000',
      '238,855',
      '238,900',
      '238,000',
      '239,000',
      '240,000',
      'quarter of a million',
      'quarter million',
    ],
    notes: 'Band 360,000–405,000 km or 225,000–252,000 mi; spellings listed are the common ones.',
  },
  {
    id: 'ka-fact-5',
    prompt: "how do you say 'where is the bathroom' in spanish",
    expectedAnswers: ['dónde está el baño', 'donde esta el bano', 'está el baño', 'esta el bano'],
  },
  { id: 'ka-fact-6', prompt: "what's the freezing point of water in fahrenheit", expectedAnswers: ['32'] },
  { id: 'ka-fact-7', prompt: 'what planet is closest to the sun', expectedAnswers: ['mercury'] },
  { id: 'ka-fact-8', prompt: 'how many days are in a leap year', expectedAnswers: ['366'] },
  { id: 'ka-fact-9', prompt: 'how many sides does a hexagon have', expectedAnswers: ['6', 'six'] },
  { id: 'ka-fact-10', prompt: 'how many weeks are in a year', expectedAnswers: ['52'] },
] as const;

export const KNOWN_ANSWER_PROBES: EvalPromptSpec[] = TASKS.map((task) => ({
  id: task.id,
  category: 'known-answer',
  intent: inferChatIntent(task.prompt),
  prompt: task.prompt,
  expectedAnswers: [...task.expectedAnswers],
  ...(task.forbiddenAnswers ? { forbiddenAnswers: [...task.forbiddenAnswers] } : {}),
  ...(task.notes ? { notes: task.notes } : {}),
}));

export const KNOWN_ANSWER_PROBE_IDS: ReadonlySet<string> = new Set(TASKS.map((t) => t.id));
