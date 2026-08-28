// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { appendContinuation, splitContinuation } from '../continue-final-message';

const history = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'Write a story.' },
];
const partial = { role: 'assistant' as const, content: 'The lighthouse stood tall against the ' };

describe('splitContinuation', () => {
  it('splits the trailing assistant partial off when a continuation is requested', () => {
    expect(splitContinuation([...history, partial], true)).toEqual({
      history,
      partial: partial.content,
    });
  });

  it('is an ordinary generation when the flag is unset', () => {
    expect(splitContinuation([...history, partial], undefined)).toEqual({
      history: [...history, partial],
      partial: null,
    });
  });

  it('is an ordinary generation when the last message is not an assistant turn', () => {
    expect(splitContinuation(history, true)).toEqual({ history, partial: null });
  });

  it('is an ordinary generation when the partial is blank or the array is empty', () => {
    expect(splitContinuation([...history, { role: 'assistant', content: '  \n' }], true).partial).toBeNull();
    expect(splitContinuation([], true)).toEqual({ history: [], partial: null });
  });
});

describe('appendContinuation', () => {
  it('appends the partial verbatim after an ordinary generation prompt', () => {
    const rendered = '<|im_start|>user\nWrite a story.<|im_end|>\n<|im_start|>assistant\n';
    expect(appendContinuation(rendered, partial.content)).toBe(rendered + partial.content);
  });

  it('closes a prefilled open <think> before the partial (LFM2.5-style templates)', () => {
    const rendered = '<|im_start|>user\nWrite a story.<|im_end|>\n<|im_start|>assistant\n<think>';
    expect(appendContinuation(rendered, partial.content)).toBe(
      rendered + '</think>\n' + partial.content,
    );
  });

  it('leaves a balanced think block alone (Qwen non-thinking prefill)', () => {
    const rendered = '<|im_start|>assistant\n<think>\n\n</think>\n\n';
    expect(appendContinuation(rendered, 'x')).toBe(rendered + 'x');
  });
});
