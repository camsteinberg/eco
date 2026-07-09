// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
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
