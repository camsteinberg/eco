// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The dispatch corpus — the probes behind the model-native tool-dispatch
 * measurement (diagnostics only; not part of the harness's checked-in pool).
 *
 * TWO SOURCES, BOTH PRE-COMMITTED.
 *
 * 1. All 50 samples of `__tests__/fixtures/realistic-inputs.ts`, verbatim. That
 *    corpus was authored blind to any dispatcher and already carries the two labels
 *    this measurement needs (`expectLocalTool`, `expectLookup`), so the regex
 *    dispatcher and the model are graded against the SAME key. Its 33 no-tool rows
 *    are the guard: a dispatcher that fires on everything scores perfectly on
 *    recall and destroys the product.
 * 2. Nineteen recall phrasings authored in the frozen protocol BEFORE any model
 *    output existed, copied here verbatim (em-dash and all). They exist because the
 *    measured failure mode of the regex dispatcher is recall, not precision, and
 *    the blind corpus has few naturally-phrased tool asks.
 *
 * THE LABELS ARE FROZEN. `DISPATCH_LABELS` is the key, derived mechanically from
 * the corpus fields and copied verbatim from the protocol's table. Nothing here may
 * be re-labelled after seeing model output, and no probe may be added beyond these
 * 69 — a corpus edited against results measures the editor.
 *
 * `intent` is whatever `inferChatIntent` returns TODAY, matching every other derived
 * probe set, so the run exercises production routing.
 */

import { REALISTIC_INPUTS } from '../../__tests__/fixtures/realistic-inputs';
import { inferChatIntent } from '../../lib/chat-intent';
import type { EvalPromptSpec } from './types';

/** The label vocabulary: a registry tool name, or `NONE` for "no tool should fire". */
export const DISPATCH_NO_TOOL = 'NONE';

/**
 * The 19 recall phrasings, verbatim from the protocol's table, in table order.
 * `expected` is the pre-committed label for each.
 */
const RECALL_PHRASINGS: readonly { prompt: string; expected: string }[] = [
  { prompt: "quick, what's 47 * 89", expected: 'calculator' },
  { prompt: 'whats 15 percent of 240 again', expected: 'calculator' },
  { prompt: "the recipe says 350f, what's that in celsius", expected: 'unit-conversion' },
  { prompt: 'how many km is a 5 mile run', expected: 'unit-conversion' },
  { prompt: 'do my chats get sent to a server?', expected: 'identity' },
  { prompt: 'wait — are my conversations private?', expected: 'identity' },
  { prompt: 'are you ChatGPT under the hood', expected: 'identity' },
  {
    prompt: 'my card is at 24.99% APR and I owe 3400 on it, what is that costing me',
    expected: 'money',
  },
  {
    prompt:
      "if I put 3400 on a card at 24.99% apr and pay 150 a month how long until it's paid off",
    expected: 'money',
  },
  { prompt: "what's 24% apr actually costing me monthly", expected: 'money' },
  { prompt: 'what day is it in 90 days, roughly', expected: 'datetime' },
  { prompt: 'how long till christmas', expected: 'datetime' },
  { prompt: 'I need to book something 3 weeks out, what date is that', expected: 'datetime' },
  {
    prompt: "my landlord hasn't fixed the heating in 3 weeks, what are my options",
    expected: DISPATCH_NO_TOOL,
  },
  {
    prompt: 'can you look over this paragraph and tell me if it reads okay',
    expected: DISPATCH_NO_TOOL,
  },
  { prompt: 'I keep putting off the dentist, help me actually do it', expected: DISPATCH_NO_TOOL },
  {
    prompt: "what's a good gift for someone who says they want nothing",
    expected: DISPATCH_NO_TOOL,
  },
  { prompt: 'explain why my sourdough came out flat', expected: DISPATCH_NO_TOOL },
  { prompt: 'is it normal to feel this tired after a 10k', expected: DISPATCH_NO_TOOL },
];

/** `dispatch/recall-01` … `dispatch/recall-19`, index-stable. */
function recallId(index: number): string {
  return `dispatch/recall-${String(index + 1).padStart(2, '0')}`;
}

const CORPUS_PROBES: EvalPromptSpec[] = REALISTIC_INPUTS.map((sample) => ({
  id: `dispatch/${sample.id}`,
  category: 'dispatch' as const,
  intent: inferChatIntent(sample.text),
  prompt: sample.text,
}));

const RECALL_PROBES: EvalPromptSpec[] = RECALL_PHRASINGS.map((row, index) => ({
  id: recallId(index),
  category: 'dispatch' as const,
  intent: inferChatIntent(row.prompt),
  prompt: row.prompt,
}));

/** The 69 dispatch probes: 50 blind-corpus samples, then the 19 recall phrasings. */
export const DISPATCH_PROBES: EvalPromptSpec[] = [...CORPUS_PROBES, ...RECALL_PROBES];

/**
 * The frozen key: probe id → the tool that SHOULD own the turn, or `NONE`.
 *
 * Corpus rows use the corpus's own labels — `expectLocalTool` when the sample is
 * squarely a local-tool ask, else `wikipedia-grounding` when a reasonable person
 * would expect an outbound lookup, else `NONE`. Recall rows use the protocol's
 * table column.
 */
export const DISPATCH_LABELS: Record<string, string> = Object.freeze({
  ...Object.fromEntries(
    REALISTIC_INPUTS.map((sample) => [
      `dispatch/${sample.id}`,
      sample.expectLocalTool ??
        (sample.expectLookup === 'should-look-up' ? 'wikipedia-grounding' : DISPATCH_NO_TOOL),
    ]),
  ),
  ...Object.fromEntries(RECALL_PHRASINGS.map((row, index) => [recallId(index), row.expected])),
});

/** The dispatch probe ids (mirrors the sibling sets' `*_PROBE_IDS` export). */
export const DISPATCH_PROBE_IDS: ReadonlySet<string> = new Set(DISPATCH_PROBES.map((p) => p.id));
