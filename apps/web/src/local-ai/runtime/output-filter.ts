// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Output filters — three small, composable utilities run in series on the
 * streamed token stream to clean up model output:
 *
 *   1. StopSequenceFilter — hard-stops generation at a configured marker
 *      (typically `<|endoftext|>` or `<|im_end|>`). Buffers up to the
 *      longest stop sequence so a partial match at chunk boundary doesn't
 *      leak past.
 *
 *   2. ThinkTagFilter — strips `<think>…</think>` blocks emitted by
 *      reasoning models (Qwen3, etc.) before they reach the user. The
 *      chain-of-thought stays useful inside the model but should not be
 *      shown.
 *
 *   3. DisclaimerFilter — strips canned "As an AI…" openers baked into
 *      small-model RLHF that prompting alone can't suppress.
 *
 * Each filter exposes the same shape: `process(chunk)` returns the visible
 * text for that chunk (possibly empty); `flush()` releases any final
 * buffered content on generation end.
 *
 * Ported from `workers/inference-worker.ts`. The legacy implementations were
 * carried over as-is; the one deliberate divergence since is the stray-close
 * handling in ThinkTagFilter documented on that class.
 */

// ─── ThinkTagFilter ─────────────────────────────────────────────────────────

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Longest tag prefix that can sit unresolved at the end of a chunk. */
const MAX_PARTIAL_TAG_LEN = Math.max(THINK_OPEN.length, THINK_CLOSE.length) - 1;

/**
 * Length of the longest suffix of `text` that is a proper prefix of EITHER
 * think tag — i.e. how many trailing characters have to be held back in case
 * the next chunk completes a tag. Tokenizers routinely split `</think>` into
 * `</` + `think` + `>`, so a close needs the same protection an open has
 * always had.
 */
function pendingTagPrefixLength(text: string): number {
  const longest = Math.min(MAX_PARTIAL_TAG_LEN, text.length);
  for (let len = longest; len >= 1; len--) {
    const suffix = text.slice(-len).toLowerCase();
    if (THINK_OPEN.startsWith(suffix) || THINK_CLOSE.startsWith(suffix)) return len;
  }
  return 0;
}

/**
 * Strips reasoning blocks from a streamed reply.
 *
 * ★ INVARIANT: a complete `<think>` or `</think>` never reaches visible output,
 * whether or not it is part of a well-formed pair, and whatever its case. That
 * has to hold defensively, because a model can and does emit an UNMATCHED
 * close: `candidate/qwen3.5-2b-onnx` produced one mid-reply on the
 * `convo-grape-climbdown` conversation probe, and the old state machine — which
 * only looked for `</think>` while already inside a block — passed it straight
 * through to the user (`noThinkLeakage: 0`).
 *
 * Why a model emits a lone close: with thinking disabled, the Qwen3.5 template
 * (plus our KV-reuse patch, runtime/template-patches.ts) renders every assistant
 * turn — history included — as `<|im_start|>assistant\n<think>\n\n</think>\n\n…`.
 * Deep in a conversation the model has seen `</think>\n\n` immediately ahead of
 * assistant prose many times over, so emitting one mid-answer and starting the
 * answer again is an unremarkable continuation of its own context. Suppressing
 * the restart is a decoding question; keeping the tag off the screen is this
 * filter's job, and it is the half that can be made deterministic.
 *
 * A stray close is dropped in place, zero-width. The blank lines behind it are
 * swallowed (as after a real close) ONLY when no visible text has been emitted
 * yet, so a reply can't open with blank lines — while mid-reply the surrounding
 * whitespace is left alone rather than welding two sentences together.
 */
export class ThinkTagFilter {
  private buffer = '';
  private insideThink: boolean;
  private justClosedThink = false;
  private startedVisibleText = false;

  /**
   * @param options.startInsideThink seed the machine ALREADY inside a reasoning
   *   block. Some templates prefill an unmatched `<think>` OPEN into the
   *   generation prompt — LFM2.5 ends every generation prompt with
   *   `<|im_start|>assistant\n<think>` unconditionally (no `enable_thinking`
   *   gate), so the model's output stream begins as
   *   `<reasoning> </think> <answer>` with no opening tag of its own. Unseeded,
   *   the machine would treat that `</think>` as a stray close and EMIT the
   *   reasoning ahead of it (the "The user wants… I should…" leak). Seeded, the
   *   reasoning up to the first `</think>` is discarded exactly as if the open
   *   tag had been streamed. If the model never emits `</think>` (spent its
   *   whole token budget thinking), `flush()` yields empty output — the honest
   *   signal that no answer survived the budget.
   */
  constructor(options: { startInsideThink?: boolean } = {}) {
    this.insideThink = options.startInsideThink ?? false;
  }

  process(chunk: string): string {
    this.buffer += chunk;
    let output = '';

    const emit = (text: string): void => {
      if (text.length === 0) return;
      output += text;
      if (!this.startedVisibleText && /\S/.test(text)) this.startedVisibleText = true;
    };

    while (this.buffer.length > 0) {
      const lower = this.buffer.toLowerCase();

      if (this.insideThink) {
        const closeIdx = lower.indexOf(THINK_CLOSE);
        if (closeIdx === -1) {
          // Hidden reasoning: discard it, keeping only what could head a close.
          if (this.buffer.length > MAX_PARTIAL_TAG_LEN) {
            this.buffer = this.buffer.slice(-MAX_PARTIAL_TAG_LEN);
          }
          break;
        }
        this.buffer = this.buffer.slice(closeIdx + THINK_CLOSE.length);
        this.insideThink = false;
        this.justClosedThink = true;
        continue;
      }

      if (this.justClosedThink) {
        this.buffer = this.buffer.replace(/^\s+/, '');
        this.justClosedThink = false;
        if (this.buffer.length === 0) break;
        continue;
      }

      const openIdx = lower.indexOf(THINK_OPEN);
      const closeIdx = lower.indexOf(THINK_CLOSE);

      if (openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
        emit(this.buffer.slice(0, openIdx));
        this.buffer = this.buffer.slice(openIdx + THINK_OPEN.length);
        this.insideThink = true;
        continue;
      }

      if (closeIdx !== -1) {
        // A close with no opener — see the invariant above.
        emit(this.buffer.slice(0, closeIdx));
        this.buffer = this.buffer.slice(closeIdx + THINK_CLOSE.length);
        this.justClosedThink = !this.startedVisibleText;
        continue;
      }

      const pending = pendingTagPrefixLength(this.buffer);
      if (pending > 0) {
        emit(this.buffer.slice(0, this.buffer.length - pending));
        this.buffer = this.buffer.slice(this.buffer.length - pending);
        break;
      }

      emit(this.buffer);
      this.buffer = '';
    }

    return output;
  }

  flush(): string {
    const wasInsideThink = this.insideThink;
    const remaining = this.buffer;
    this.buffer = '';
    this.insideThink = false;
    this.justClosedThink = false;
    this.startedVisibleText = false;
    return wasInsideThink ? '' : remaining;
  }
}

/**
 * True when a rendered generation prompt leaves an unmatched `<think>` OPEN —
 * i.e. the model will begin generating INSIDE a reasoning block, and its output
 * stream starts with hidden chain-of-thought terminated by a lone `</think>`.
 * LFM2.5's template does exactly this, unconditionally, on every turn.
 *
 * Callers seed `createFilterChain(stops, { startInsideThink: true })` from this
 * so the reasoning is stripped rather than leaking as a stray-close prefix.
 *
 * Balanced prompts return false — no seeding, unchanged behavior. That covers
 * models with no think block at all AND Qwen's non-thinking mode, whose prompt
 * carries an EMPTY, already-CLOSED `<think>\n\n</think>` block (opens == closes).
 * Computed once at load from the boot-time template smoke (fixed content, no
 * user text), so a stray `<think>` inside a user message can never trip it.
 */
export function promptStartsInThinkBlock(renderedPrompt: string): boolean {
  const opens = renderedPrompt.match(/<think>/gi)?.length ?? 0;
  const closes = renderedPrompt.match(/<\/think>/gi)?.length ?? 0;
  return opens > closes;
}

// ─── DisclaimerFilter ──────────────────────────────────────────────────────

const AI_DISCLAIMER_OPENING_RE =
  /^As an AI( language model| assistant)?,? ?(I )?(don't|do not|cannot|can't) (have |possess )?(personal )?(experiences?|feelings?|opinions?|preferences?|consciousness)(,? ?(but|however|though|so|and) ?)?/i;

export class DisclaimerFilter {
  private buffer = '';
  private checked = false;

  process(chunk: string): string {
    if (this.checked) return chunk;

    this.buffer += chunk;
    if (this.buffer.length === 0) return '';
    if (!this.couldStillBeDisclaimerOpening() || AI_DISCLAIMER_OPENING_RE.test(this.buffer)) {
      return this.stripAndRelease();
    }
    if (this.buffer.length < 200) return '';

    return this.stripAndRelease();
  }

  flush(): string {
    if (this.checked) {
      const remaining = this.buffer;
      this.buffer = '';
      return remaining;
    }
    return this.stripAndRelease();
  }

  private couldStillBeDisclaimerOpening(): boolean {
    const normalized = this.buffer.trimStart().toLowerCase();
    if (normalized.length === 0) return true;
    const starters = ['as an ai', 'as an ai language model', 'as an ai assistant'];
    return starters.some((starter) =>
      starter.startsWith(normalized) || normalized.startsWith(starter),
    );
  }

  private stripAndRelease(): string {
    this.checked = true;
    let text = this.buffer;
    this.buffer = '';

    const before = text;
    text = text.replace(AI_DISCLAIMER_OPENING_RE, '');

    if (text !== before && text.length > 0 && text[0] !== text[0]!.toUpperCase()) {
      text = text[0]!.toUpperCase() + text.slice(1);
    }

    return text;
  }
}

// ─── StopSequenceFilter ────────────────────────────────────────────────────

export class StopSequenceFilter {
  private buffer = '';
  private isStopped = false;
  private readonly stopSequences: string[];

  constructor(stopSequences: string[]) {
    this.stopSequences = Array.from(new Set(stopSequences.filter(Boolean)))
      .sort((a, b) => b.length - a.length);
  }

  get stopped(): boolean {
    return this.isStopped;
  }

  process(chunk: string): string {
    if (this.isStopped) return '';
    if (this.stopSequences.length === 0) return chunk;

    this.buffer += chunk;
    const stopIndex = this.findStopIndex(this.buffer);
    if (stopIndex >= 0) {
      const visible = this.buffer.slice(0, stopIndex);
      this.buffer = '';
      this.isStopped = true;
      return visible;
    }

    const pendingLength = this.pendingStopPrefixLength(this.buffer);
    if (pendingLength === 0) {
      const visible = this.buffer;
      this.buffer = '';
      return visible;
    }

    const emitLength = this.buffer.length - pendingLength;
    const visible = this.buffer.slice(0, emitLength);
    this.buffer = this.buffer.slice(emitLength);
    return visible;
  }

  flush(): string {
    if (this.isStopped) {
      this.buffer = '';
      return '';
    }
    const visible = this.buffer;
    this.buffer = '';
    return visible;
  }

  private findStopIndex(text: string): number {
    let earliest = -1;
    for (const stop of this.stopSequences) {
      const index = text.indexOf(stop);
      if (index >= 0 && (earliest === -1 || index < earliest)) {
        earliest = index;
      }
    }
    return earliest;
  }

  private pendingStopPrefixLength(text: string): number {
    let pendingLength = 0;
    for (const stop of this.stopSequences) {
      const maxCandidateLength = Math.min(stop.length - 1, text.length);
      for (let length = maxCandidateLength; length > pendingLength; length--) {
        if (stop.startsWith(text.slice(-length))) {
          pendingLength = length;
          break;
        }
      }
    }
    return pendingLength;
  }
}

// ─── Chained pipeline ──────────────────────────────────────────────────────

/**
 * Run all three filters in series on a chunk. Returns the final visible
 * text. The pipeline is stateful — callers must reuse the same instances
 * across all chunks in one generation, then call `flushFilterChain()` on
 * generation end.
 */
export type FilterChain = {
  think: ThinkTagFilter;
  disclaimer: DisclaimerFilter;
  stop: StopSequenceFilter;
};

export function createFilterChain(
  stopSequences: string[] = [],
  options: { startInsideThink?: boolean } = {},
): FilterChain {
  return {
    think: new ThinkTagFilter({ startInsideThink: options.startInsideThink }),
    disclaimer: new DisclaimerFilter(),
    stop: new StopSequenceFilter(stopSequences),
  };
}

export function processThroughChain(chain: FilterChain, chunk: string): string {
  const afterStop = chain.stop.process(chunk);
  if (chain.stop.stopped && afterStop.length === 0) return '';
  const afterThink = chain.think.process(afterStop);
  return chain.disclaimer.process(afterThink);
}

export function flushFilterChain(chain: FilterChain): string {
  const stopTail = chain.stop.flush();
  const thinkTail = chain.think.process(stopTail) + chain.think.flush();
  return chain.disclaimer.process(thinkTail) + chain.disclaimer.flush();
}
