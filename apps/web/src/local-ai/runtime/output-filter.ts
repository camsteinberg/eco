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
 * Ported from `workers/inference-worker.ts` — the legacy implementations
 * are battle-tested. Behavior is preserved exactly so output looks the
 * same after cutover.
 */

// ─── ThinkTagFilter ─────────────────────────────────────────────────────────

export class ThinkTagFilter {
  private buffer = '';
  private insideThink = false;
  private justClosedThink = false;

  process(chunk: string): string {
    this.buffer += chunk;
    let output = '';

    while (this.buffer.length > 0) {
      if (this.insideThink) {
        const closeIdx = this.buffer.indexOf('</think>');
        if (closeIdx !== -1) {
          this.buffer = this.buffer.slice(closeIdx + 8);
          this.insideThink = false;
          this.justClosedThink = true;
        } else if (this.buffer.length >= 8) {
          this.buffer = this.buffer.slice(-7);
          break;
        } else {
          break;
        }
      } else {
        if (this.justClosedThink) {
          this.buffer = this.buffer.replace(/^\s+/, '');
          this.justClosedThink = false;
          if (this.buffer.length === 0) break;
        }

        const openIdx = this.buffer.indexOf('<think>');
        if (openIdx !== -1) {
          output += this.buffer.slice(0, openIdx);
          this.buffer = this.buffer.slice(openIdx + 7);
          this.insideThink = true;
        } else {
          let partialLen = 0;
          const tag = '<think>';
          for (let len = Math.min(6, this.buffer.length); len >= 1; len--) {
            if (tag.startsWith(this.buffer.slice(-len))) {
              partialLen = len;
              break;
            }
          }

          if (partialLen > 0) {
            output += this.buffer.slice(0, -partialLen);
            this.buffer = this.buffer.slice(-partialLen);
            break;
          } else {
            output += this.buffer;
            this.buffer = '';
          }
        }
      }
    }

    return output;
  }

  flush(): string {
    const wasInsideThink = this.insideThink;
    const remaining = this.buffer;
    this.buffer = '';
    this.insideThink = false;
    this.justClosedThink = false;
    return wasInsideThink ? '' : remaining;
  }
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

export function createFilterChain(stopSequences: string[] = []): FilterChain {
  return {
    think: new ThinkTagFilter(),
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
