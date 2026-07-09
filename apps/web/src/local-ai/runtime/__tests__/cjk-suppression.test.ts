// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import {
  collectCjkTokenIds,
  decideCjkSuppression,
  startCjkTokenScan,
} from '../cjk-suppression';
import type { ChatMessage } from '../types';

const sys = (content: string): ChatMessage => ({ role: 'system', content });
const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

describe('decideCjkSuppression', () => {
  it('suppresses on a plain English factual ask (the s1 leak class)', () => {
    expect(
      decideCjkSuppression([sys('You are Eco.'), user('what is methane?')]),
    ).toEqual({ suppress: true, reason: 'applied' });
  });

  it('does not suppress when the user writes CJK', () => {
    expect(
      decideCjkSuppression([sys('You are Eco.'), user('你好，请介绍一下自己')]),
    ).toEqual({ suppress: false, reason: 'cjk-conversation' });
  });

  it('does not suppress when CJK appears inside an English ask', () => {
    expect(
      decideCjkSuppression([sys('You are Eco.'), user('what does 甲烷 mean?')]),
    ).toEqual({ suppress: false, reason: 'cjk-conversation' });
  });

  it('does not suppress when the SYSTEM side carries CJK (grounded extract)', () => {
    expect(
      decideCjkSuppression([
        sys('You are Eco.\n\nSource: Beijing (北京) is the capital of China.'),
        user('tell me about beijing'),
      ]),
    ).toEqual({ suppress: false, reason: 'cjk-conversation' });
  });

  it('IGNORES assistant turns — a prior leak must not disable the guard', () => {
    expect(
      decideCjkSuppression([
        sys('You are Eco.'),
        user('what is methane?'),
        assistant('Methane (甲烷) is a colorless gas.'),
        user('and what is it used for?'),
      ]),
    ).toEqual({ suppress: true, reason: 'applied' });
  });

  describe('language-request escape', () => {
    const escapes = [
      'how do you say hello in japanese',
      'how do you say hello in japanese?',
      'what is thank you in korean?',
      "what's good morning in chinese",
      'translate good morning to chinese',
      'translate this into mandarin: good evening',
      'how do I write my name in korean',
      'how is hello written in japanese?',
      'what is sushi called in japanese',
      'say it in chinese please',
      'what does it mean in cantonese?',
      'how do you pronounce hello in chinese characters',
      "what's the kanji for water?",
      'show me the hiragana alphabet',
      'write that in hangul',
    ];
    it.each(escapes)('does not suppress: %s', (prompt) => {
      expect(decideCjkSuppression([sys('You are Eco.'), user(prompt)])).toEqual({
        suppress: false,
        reason: 'cjk-language-request',
      });
    });

    const nonEscapes = [
      // Topical mentions of a language/people are NOT requests for CJK output.
      'what was the biggest city in chinese history',
      'tell me about japanese cuisine',
      'who is the most famous korean actor in hollywood',
      'why is mandarin in china more spoken than cantonese overall',
      'explain the role of japanese in ww2 codebreaking efforts',
      'what is methane?',
      'whats the capital of france',
    ];
    it.each(nonEscapes)('still suppresses: %s', (prompt) => {
      expect(decideCjkSuppression([sys('You are Eco.'), user(prompt)])).toEqual({
        suppress: true,
        reason: 'applied',
      });
    });

    it('keeps the escape active for the whole conversation via replayed history', () => {
      expect(
        decideCjkSuppression([
          sys('You are Eco.'),
          user('how do you say hello in japanese'),
          assistant('こんにちは (konnichiwa).'),
          user('now use it in a sentence'),
        ]),
      ).toEqual({ suppress: false, reason: 'cjk-language-request' });
    });

    it('does not let an ASSISTANT mention of a translation frame trigger the escape', () => {
      expect(
        decideCjkSuppression([
          sys('You are Eco.'),
          user('what is methane?'),
          assistant('Methane is CH4. You could ask me how to say methane in chinese.'),
          user('and ethane?'),
        ]),
      ).toEqual({ suppress: true, reason: 'applied' });
    });
  });
});

describe('collectCjkTokenIds', () => {
  // A toy vocab: ids decode to fixed strings.
  const vocab = ['hello', ' world', '甲', '烷', 'こん', '한국', '�', '?', ' 中国'];
  const decode = (id: number): string => {
    const entry = vocab[id];
    if (entry === undefined) throw new Error(`bad id ${id}`);
    return entry;
  };

  it('collects exactly the CJK-decoding ids', async () => {
    const ids = await collectCjkTokenIds(decode, vocab.length, () => Promise.resolve());
    expect(ids).toEqual([2, 3, 4, 5, 8]);
  });

  it('never bans replacement-character (partial-byte) tokens', async () => {
    const ids = await collectCjkTokenIds(decode, vocab.length, () => Promise.resolve());
    expect(ids).not.toContain(6);
  });

  it('skips ids whose decode throws', async () => {
    const throwing = (id: number): string => {
      if (id === 2) throw new Error('boom');
      return decode(id);
    };
    const ids = await collectCjkTokenIds(throwing, vocab.length, () => Promise.resolve());
    expect(ids).toEqual([3, 4, 5, 8]);
  });

  it('yields between chunks on large vocabs', async () => {
    let yields = 0;
    const count = () => {
      yields++;
      return Promise.resolve();
    };
    // 20_000 ids at chunk size 8192 → chunks [0,8192), [8192,16384), [16384,20000)
    // → 2 yields (none after the final chunk).
    await collectCjkTokenIds(() => 'x', 20_000, count);
    expect(yields).toBe(2);
  });

  it('returns empty for an empty vocab', async () => {
    await expect(collectCjkTokenIds(decode, 0)).resolves.toEqual([]);
  });
});

describe('startCjkTokenScan', () => {
  it('resolves with ids and a duration', async () => {
    let t = 100;
    const scan = startCjkTokenScan((id) => (id === 1 ? '中' : 'a'), 3, () => (t += 50));
    await scan.ready;
    expect(scan.ids).toEqual([1]);
    expect(scan.failed).toBe(false);
    expect(scan.scanMs).toBeGreaterThanOrEqual(0);
  });

  it('succeeds with zero ids when every decode throws (per-id throws are swallowed)', async () => {
    const scan = startCjkTokenScan(
      () => {
        throw new Error('boom');
      },
      5,
    );
    await scan.ready;
    // The `failed` branch is defensive-only today (collectCjkTokenIds swallows
    // per-id throws and the default yield never rejects) — a fully-throwing
    // decode therefore SUCCEEDS with zero ids; the worker reports scan-empty.
    expect(scan.failed).toBe(false);
    expect(scan.ids).toEqual([]);
  });
});
