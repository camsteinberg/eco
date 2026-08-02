// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { scoreThinkLeakage } from '../../eval/rubric';
import {
  DisclaimerFilter,
  StopSequenceFilter,
  ThinkTagFilter,
  createFilterChain,
  flushFilterChain,
  processThroughChain,
} from '../output-filter';

describe('ThinkTagFilter', () => {
  it('passes plain text through unchanged', () => {
    const f = new ThinkTagFilter();
    expect(f.process('hello world')).toBe('hello world');
    expect(f.flush()).toBe('');
  });

  it('strips a complete <think>…</think> block', () => {
    const f = new ThinkTagFilter();
    const out = f.process('<think>internal stuff</think>visible');
    expect(out).toBe('visible');
  });

  it('handles a block split across chunks', () => {
    const f = new ThinkTagFilter();
    expect(f.process('hello <thi')).toBe('hello ');
    expect(f.process('nk>secret</think> world')).toBe('world');
  });

  it('discards content inside an unclosed think block on flush', () => {
    const f = new ThinkTagFilter();
    f.process('<think>still thinking');
    expect(f.flush()).toBe('');
  });

  it('preserves text after the closing tag with leading whitespace stripped', () => {
    const f = new ThinkTagFilter();
    expect(f.process('<think>a</think>\n\nResult: 42')).toBe('Result: 42');
  });
});

describe('ThinkTagFilter — stray closing tags', () => {
  /**
   * ★ THE REPRODUCTION. Shape taken from the real `convo-grape-climbdown`
   * failure on `candidate/qwen3.5-2b-onnx`: a well-formed think block, the
   * answer, then a BARE `</think>` with no opener, then a near-repeat of the
   * answer. Before the fix the bare tag fell through the "no `<think>` here"
   * branch and was emitted verbatim — `noThinkLeakage: 0` on a real reply.
   *
   * Why this model produces one at all: the KV-reuse template patch renders
   * EVERY history assistant turn as `<|im_start|>assistant\n<think>\n\n</think>\n\n…`
   * (runtime/template-patches.ts), so in a nine-turn conversation the model has
   * seen `</think>\n\n` immediately before assistant prose five times. Emitting
   * that boundary mid-answer and starting the answer over is an ordinary
   * continuation of what it was shown. The filter cannot stop the model doing
   * it — it can refuse to put the tag on screen.
   */
  it('never emits a bare </think> that arrives outside a think block', () => {
    const f = new ThinkTagFilter();
    let out = f.process(
      '<think>weigh the two questions</think>Chicken and rice is fine before bloodwork.',
    );
    out += f.process('\n\n</think>\n\nChicken and rice is fine before the bloodwork.');
    out += f.flush();

    expect(out).not.toContain('</think>');
    expect(out).not.toContain('<think>');
    // Pinned exactly: the tag is a zero-width deletion mid-reply, so the
    // model's own blank lines survive on both sides. Markdown renders
    // `\n\n\n\n` as the single paragraph break it already looked like;
    // collapsing it here would be reflowing the reply, which is not this
    // filter's job. The duplicate paragraph is a separate, decoding-side
    // failure this fix deliberately does not claim to solve.
    expect(out).toBe(
      'Chicken and rice is fine before bloodwork.\n\n\n\nChicken and rice is fine before the bloodwork.',
    );
  });

  it('strips a stray </think> arriving as its own chunk', () => {
    const f = new ThinkTagFilter();
    let out = f.process('First half. ');
    out += f.process('</think>');
    out += f.process('Second half.');
    out += f.flush();

    expect(out).not.toContain('think>');
    expect(out).toBe('First half. Second half.');
  });

  it('strips a stray </think> split across chunk boundaries', () => {
    // A tokenizer splits the tag into pieces (`</`, `think`, `>`); the filter
    // must hold a partial close the same way it holds a partial open.
    const f = new ThinkTagFilter();
    let out = f.process('Answer. ');
    out += f.process('</');
    out += f.process('think');
    out += f.process('>');
    out += f.process('More answer.');
    out += f.flush();

    expect(out).not.toContain('think>');
    expect(out).toBe('Answer. More answer.');
  });

  it('strips a stray </think> at the very start of a stream, with its trailing blank lines', () => {
    const f = new ThinkTagFilter();
    let out = f.process('</think>\n\nHere is the answer.');
    out += f.flush();

    expect(out).toBe('Here is the answer.');
  });

  it('strips multiple stray </think> tags in one stream', () => {
    const f = new ThinkTagFilter();
    let out = f.process('One.</think> Two.');
    out += f.process('</think> Three.</think>');
    out += f.flush();

    expect(out).not.toContain('think>');
    expect(out).toContain('One.');
    expect(out).toContain('Two.');
    expect(out).toContain('Three.');
  });

  it('still opens a real think block after a stray close', () => {
    const f = new ThinkTagFilter();
    let out = f.process('Visible.</think> also visible.');
    out += f.process('<think>hidden</think>tail');
    out += f.flush();

    expect(out).not.toContain('think>');
    expect(out).not.toContain('hidden');
    expect(out).toContain('Visible.');
    expect(out).toContain('also visible.');
    expect(out).toContain('tail');
  });

  it('strips tags whatever their case', () => {
    // The leak instrument (eval/rubric scoreThinkLeakage) matches
    // case-insensitively, so the filter has to as well or the two disagree
    // about what a leak is.
    const f = new ThinkTagFilter();
    let out = f.process('Answer.</THINK> tail <Think>hidden</Think> end');
    out += f.flush();

    expect(out.toLowerCase()).not.toContain('think>');
    expect(out).not.toContain('hidden');
  });

  it('leaves ordinary angle-bracket text alone', () => {
    const f = new ThinkTagFilter();
    let out = f.process('Use `a < b` and `</div>` in the markup, and think about it.');
    out += f.flush();

    expect(out).toBe('Use `a < b` and `</div>` in the markup, and think about it.');
  });

  it('the visible output of a stray-close stream scores clean on the leak instrument', () => {
    const f = new ThinkTagFilter();
    let out = f.process('<think>reason</think>Answer paragraph.\n\n</think>\n\nAnswer paragraph.');
    out += f.flush();

    expect(scoreThinkLeakage(out)).toBe(1);
  });
});

describe('DisclaimerFilter', () => {
  it('strips a canned AI disclaimer opening', () => {
    const f = new DisclaimerFilter();
    const out = f.process("As an AI language model, I don't have personal experiences, but here is what I think.");
    expect(out.startsWith('Here is what I think')).toBe(true);
  });

  it('streams non-disclaimer text immediately', () => {
    const f = new DisclaimerFilter();
    const out = f.process('Hello! Here is the answer.');
    expect(out).toBe('Hello! Here is the answer.');
  });

  it('releases buffer once it determines the text is safe', () => {
    const f = new DisclaimerFilter();
    expect(f.process('The capital of France')).toBe('The capital of France');
  });

  it('flush releases the disclaimer-prefix buffer when never confirmed', () => {
    const f = new DisclaimerFilter();
    // "As" matches the start of "as an ai" so it gets buffered.
    expect(f.process('As')).toBe('');
    // Flush before further input releases the still-buffered prefix.
    expect(f.flush()).toBe('As');
  });
});

describe('StopSequenceFilter', () => {
  it('passes text through unchanged when no stops match', () => {
    const f = new StopSequenceFilter(['<|endoftext|>']);
    expect(f.process('hello')).toBe('hello');
    expect(f.process(' world')).toBe(' world');
    expect(f.stopped).toBe(false);
  });

  it('stops at the first occurrence of any configured stop', () => {
    const f = new StopSequenceFilter(['<|endoftext|>']);
    expect(f.process('hello <|endoftext|> trailing')).toBe('hello ');
    expect(f.stopped).toBe(true);
    expect(f.process('more text')).toBe('');
  });

  it('handles a stop sequence split across chunks', () => {
    const f = new StopSequenceFilter(['<|im_end|>']);
    expect(f.process('result <|im_')).toBe('result ');
    expect(f.process('end|> more')).toBe('');
    expect(f.stopped).toBe(true);
  });

  it('flush releases buffered text when no stop was hit', () => {
    const f = new StopSequenceFilter(['<|im_end|>']);
    f.process('partial <|im_');
    expect(f.flush()).toBe('<|im_');
  });

  it('no stops configured is a pass-through', () => {
    const f = new StopSequenceFilter([]);
    expect(f.process('anything <|endoftext|>')).toBe('anything <|endoftext|>');
    expect(f.stopped).toBe(false);
  });
});

describe('Filter chain', () => {
  it('runs all three filters in series', () => {
    const chain = createFilterChain(['<|im_end|>']);
    let output = '';
    output += processThroughChain(chain, "As an AI language model, I don't have personal experiences. ");
    output += processThroughChain(chain, '<think>scratchpad</think>The answer is 42.<|im_end|> trailing');
    output += flushFilterChain(chain);
    expect(output).toContain('The answer is 42.');
    expect(output).not.toContain('As an AI');
    expect(output).not.toContain('<think>');
    expect(output).not.toContain('<|im_end|>');
    expect(output).not.toContain('trailing');
  });

  it('flushFilterChain releases all tails', () => {
    const chain = createFilterChain([]);
    processThroughChain(chain, 'Here is the answer: ');
    expect(flushFilterChain(chain)).toBe('');
  });
});
