// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Context-stress headroom probes — diagnostic, opt-in, NOT part of the answer-
 * quality bar.
 *
 * Purpose: earn (or refute) a per-model context-window bump. A catalog model's
 * `capabilities.contextTokens` is a MEASURED value — raising it to 8192 needs
 * real-WebGPU evidence that the model's ONNX/WebGPU session actually LOADS and
 * STREAMS a ~8k-token sequence without OOM, a device-lost, or a throughput
 * cliff, AND still attends across the whole window (not merely survives it).
 * See `catalog/__tests__/catalog.test.ts` — the "measured per-model context
 * windows" pin — for the convention this probe supplies evidence for.
 *
 * The transformers runtime (the ONNX path these candidate models use) does not
 * clamp the sequence to `contextTokens`: `toTransformersGenerateArgs` sets only
 * `max_new_tokens`, and the KV cache grows with whatever message sequence the
 * caller feeds. Production caps history earlier via `selectMessagesForContext`
 * (`floor(contextTokens * 0.75)`), but the eval harness passes FULL history to
 * the model — so a single long probe run through the harness pushes the real
 * token count into the KV cache and measures headroom directly, independent of
 * the catalog value.
 *
 * Each probe plants an unguessable secret in the FIRST turn, buries it under a
 * long, specific, distractor-heavy conversation, then asks for it back in the
 * final turn. A pass is three things at once, read by eye on a real-WebGPU run:
 *   1. it loads + streams to completion (no OOM / device-lost) — the headroom;
 *   2. the reply is coherent (the long-context KV is not corrupted);
 *   3. the planted secret comes back verbatim (attention spans the window).
 *
 * These are gated behind the harness research-arms flag (`eco-eval-arms=1`),
 * off by default: they are heavy (~8k input tokens each) and would slow every
 * full-catalog run and shift its selected-set fingerprint if always-on. Run one
 * surgically with `eco-eval-prompts=<id>` (see the ids below).
 */

import { inferChatIntent } from '../../lib/chat-intent';
import type { EvalHistoryTurn, EvalPromptSpec } from './types';

/** The unguessable secret planted in turn 1 and asked for in the final turn. */
const PLANTED_CODENAME = 'Brambleworth';
const PLANTED_COMBINATION = '47-19-83';

/**
 * Distractor sentence templates — a community-garden build, deliberately dense
 * with specific figures, dates and names so the history cannot be compressed to
 * a gist and the model must actually carry the window. `{n}` is substituted per
 * turn so no two turns are byte-identical (a repeated block would let the KV
 * cache short-circuit and understate the memory cost).
 */
const DISTRACTOR_SENTENCES: readonly string[] = [
  'The raised beds along the north fence measured {n} feet by four, and we agreed cedar would outlast the treated pine the supplier quoted on the fifteenth.',
  'Priya counted {n} bags of compost left in the shed, which is short of the load we budgeted for the herb spiral near the gate.',
  'The volunteer rota for the week put Marcus on watering Tuesday and Thursday, with Deng covering the {n} o\'clock slot on the weekend.',
  'We still owe the hardware co-op for {n} metres of drip line and the two brass splitters that came in on back-order.',
  'The soil test from plot {n} came back slightly acidic, so the plan is to work in a measured dose of garden lime before the brassicas go in.',
  'Aunt Rosa offered {n} tomato seedlings from her greenhouse, the San Marzano and a striped heirloom she never named properly.',
  'The council grant covers {n} percent of the water-butt install but not the labour, which the Saturday crew agreed to donate.',
  'Someone left the {n}-litre wheelbarrow out in the rain again and the tyre is going soft, so it needs a valve before the mulch delivery.',
  'The bee hotel went up on the east post at roughly {n} centimetres off the ground, angled so the morning sun hits the tubes.',
  'For the open day we sketched {n} trestle tables, a seed-swap corner, and a chalkboard listing what is in season.',
  'Old Mr Aldous down the row claims the pear tree is a Conference, but the fruit he brought in last autumn looked more like a Comice to {n} of us.',
  'The insurance renewal quote climbed to {n} pounds for the year, which the treasurer flagged as steeper than the committee expected.',
  'We measured the shade from the sycamore at {n} feet by mid-afternoon, which rules out the sun-loving crops on the western third.',
  'The children\'s plot needs {n} more trowels and a spare pair of small gloves before the school group visits on the twelfth.',
  'Deng rebuilt the cold frame with the salvaged windows and reckons it holds heat for about {n} degrees over the outside air overnight.',
  'The wildflower strip germinated unevenly; roughly {n} percent of the yarrow came up but the cornflower is patchy along the path edge.',
  'Our water meter reading jumped by {n} units last month, which nobody could explain until we found the split hose behind the shed.',
];

/** Build one distractor turn of roughly `targetChars` characters. */
function distractorTurn(role: EvalHistoryTurn['role'], turnIndex: number, targetChars: number): EvalHistoryTurn {
  const parts: string[] = [];
  let charsSoFar = 0;
  let pick = turnIndex * 3;
  while (charsSoFar < targetChars) {
    const template = DISTRACTOR_SENTENCES[pick % DISTRACTOR_SENTENCES.length]!;
    // Vary the injected number per (turn, sentence) so no sentence repeats verbatim.
    const n = String(((turnIndex + 1) * 7 + pick * 3) % 89) + (pick % 2 === 0 ? '' : '.5');
    const sentence = template.replace('{n}', n);
    parts.push(sentence);
    charsSoFar += sentence.length + 1;
    pick += 1;
  }
  const lead =
    role === 'user'
      ? `Turn ${String(turnIndex)} — a few more things on my mind: `
      : `Noted. To recap turn ${String(turnIndex)}: `;
  return { role, content: lead + parts.join(' ') };
}

/**
 * Assemble a long-context probe: a planted secret up front, `historyTurns`
 * turns of distractor conversation (targeting `perTurnChars` each), then a
 * recall question as the probed turn.
 */
function buildHeadroomProbe(opts: {
  id: string;
  historyTurns: number;
  perTurnChars: number;
  /** Human label for the window the probe exercises ("~8k", "~4k"). */
  windowLabel: string;
}): EvalPromptSpec {
  const openingUser: EvalHistoryTurn = {
    role: 'user',
    content:
      `Before we get into the garden planning, one housekeeping note so I don't forget it later: ` +
      `the project codename is ${PLANTED_CODENAME} and the shed padlock combination is ${PLANTED_COMBINATION}. ` +
      `Please just hold onto those two facts; I'll ask you to read them back at the very end. ` +
      `Now — we're organising the spring build for the community allotment and there's a lot to work through.`,
  };
  const openingAssistant: EvalHistoryTurn = {
    role: 'assistant',
    content:
      `Got it — I'll keep the codename and the combination in mind and read them back when you ask. ` +
      `Let's work through the spring build. Tell me what's outstanding and I'll help you keep it all straight.`,
  };

  const history: EvalHistoryTurn[] = [openingUser, openingAssistant];
  for (let i = 0; i < opts.historyTurns; i++) {
    const role: EvalHistoryTurn['role'] = i % 2 === 0 ? 'user' : 'assistant';
    history.push(distractorTurn(role, i + 1, opts.perTurnChars));
  }

  const prompt =
    `Okay, that's everything on the garden for now. As promised at the very start of this ` +
    `conversation, please read back the two housekeeping facts I asked you to hold onto: the ` +
    `project codename and the shed padlock combination. Give them exactly as I stated them.`;

  return {
    id: opts.id,
    category: 'factual-known',
    intent: inferChatIntent(prompt, { hasPriorTurns: true }),
    prompt,
    history,
    // Any-of whole-token match; the real pass criterion is read by eye on a
    // real-WebGPU run (both facts back, verbatim, in a coherent reply).
    expectedAnswers: [PLANTED_CODENAME, PLANTED_COMBINATION],
    judge: ['coherence'],
    notes:
      'CONTEXT-STRESS HEADROOM PROBE (diagnostic, not the quality bar). Pass = loads + ' +
      'streams without OOM/device-lost, reply is coherent, and BOTH planted facts ' +
      `("${PLANTED_CODENAME}" and "${PLANTED_COMBINATION}") come back verbatim — proving the ` +
      `KV cache holds and attention spans the full ${opts.windowLabel}-token window.`,
  };
}

/**
 * The context-stress pool. `ctx-stress-8k-recall` targets ~8k input tokens
 * (~33k chars of history at ~4 chars/token), sized to exercise a candidate's
 * 8192 window with headroom margin. Add sibling probes here for other window
 * sizes as needed.
 */
export const CONTEXT_STRESS_PROBES: readonly EvalPromptSpec[] = [
  buildHeadroomProbe({
    id: 'ctx-stress-8k-recall',
    historyTurns: 38,
    perTurnChars: 820,
    windowLabel: '~8k',
  }),
  // ~6k: what chat ACTUALLY sends to an 8192 model — lib/context-window.ts
  // budgets history at floor(contextTokens * 0.75) = 6144. This is the probe
  // that decides whether the shipped 8192 claim is safe in real use.
  buildHeadroomProbe({
    id: 'ctx-stress-6k-recall',
    historyTurns: 28,
    perTurnChars: 820,
    windowLabel: '~6k',
  }),
  // Half-size sibling for models declared at 4096 (the LFM2-2.6B): proves the
  // DECLARED window actually holds. Added 2026-08-26 after the 8k probe GPU-OOMed
  // the 2.6B on an Apple-silicon Mac ("Failed to allocate memory for buffer
  // mapping") — the line has to be measured, not assumed.
  buildHeadroomProbe({
    id: 'ctx-stress-4k-recall',
    historyTurns: 18,
    perTurnChars: 820,
    windowLabel: '~4k',
  }),
];

/**
 * BOUNDARY PROBES — added 2026-08-29 to test a DERIVED prediction rather than
 * bisect for another empirical number.
 *
 * WHAT THESE MEASURE. A model's usable context window is not a property of the
 * model file — every LFM2 config declares `max_position_embeddings: 128000`,
 * which no browser can prefill. It is a property of the DEVICE. These probes
 * find where a given device stops being able to answer, so a catalog window can
 * be derived instead of guessed.
 *
 * THE KV CACHE IS NOT THE CONSTRAINT. LFM2 is hybrid: only 6 of 16 layers (350M,
 * 1.2B) and 8 of 30 (2.6B) hold a growing cache. That is 12 KB/token (350M, 1.2B)
 * and 16 KB/token (2.6B) — roughly 100-134 MB at 8k tokens, against a 4 GiB
 * buffer limit. Any reasoning about context that appeals to KV memory is wrong.
 *
 * WHAT DOES BIND — measured 2026-08-29 on an M1 Pro (16 GB, 4 GiB WebGPU buffer
 * limit), production build, one session, model cached:
 *
 *   | model         | attn heads | ~tokens | outcome                              |
 *   |---------------|-----------:|--------:|--------------------------------------|
 *   | LFM2.5-1.2B   |         32 |   6,577 | PASS, 54s, planted facts returned    |
 *   | LFM2.5-1.2B   |         32 |   7,950 | FAIL, allocation error at first run  |
 *   | LFM2.5-350M   |         16 |  10,800 | no allocation error — but GIBBERISH  |
 *
 * Two conclusions, both load-bearing:
 *
 * 1. The failing allocation scales with `heads x n^2`, not with model size. A
 *    0.28 GB model with ~130 MB of KV cleared 10.8k tokens in the same session
 *    where a 32-head model died at 7.9k. A closed-form ceiling of
 *    `sqrt(maxBufferSize / (2 * heads))` predicts 8191 for 32 heads and 11585 for
 *    16 — the right SHAPE, but it overshoots: the real failure is against
 *    available GPU memory, not the per-buffer cap. So head count tells you how
 *    the ceiling MOVES between models; only a run tells you where it sits on a
 *    given device.
 *
 * 2. Surviving is not working. At 10,800 tokens the 350M streams happily and
 *    returns gibberish — neither planted fact, no coherent sentence. The memory
 *    ceiling and the USABLE ceiling are different numbers and the usable one is
 *    far lower. A window chosen from the allocation limit alone would ship a
 *    model that looks healthy and answers nonsense.
 *
 * Prefill cost is also cleanly quadratic (23s at ~4k vs 59s at 6,577 is a ratio
 * of 2.57 against a predicted 2.58), so a shipped `contextTokens` is in truth a
 * time-to-first-token budget. State it as one.
 *
 * HOW TO USE THIS ON A NEW DEVICE OR MODEL. Run the pair that brackets the
 * expected ceiling for that model's head count and read three things per result:
 * did it allocate, how long to first token, and did BOTH planted facts come back
 * verbatim. The lowest of those three limits is the window. `ctx-boundary-hi`
 * and `ctx-boundary-wide-hi` have not been run — they exist to bracket from
 * above on hardware we do not yet have.
 *
 * Turn counts are calibrated at roughly 241 tokens per turn and are approximate
 * by construction; read `perf.promptTokens` for the length actually fed.
 */
export const CONTEXT_BOUNDARY_PROBES: readonly EvalPromptSpec[] = [
  buildHeadroomProbe({ id: 'ctx-boundary-lo', historyTurns: 33, perTurnChars: 820, windowLabel: '~7.9k' }),
  buildHeadroomProbe({ id: 'ctx-boundary-hi', historyTurns: 35, perTurnChars: 820, windowLabel: '~8.4k' }),
  buildHeadroomProbe({ id: 'ctx-boundary-wide-lo', historyTurns: 45, perTurnChars: 820, windowLabel: '~10.8k' }),
  buildHeadroomProbe({ id: 'ctx-boundary-wide-hi', historyTurns: 50, perTurnChars: 820, windowLabel: '~12.0k' }),
];
