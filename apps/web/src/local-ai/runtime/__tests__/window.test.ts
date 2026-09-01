// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The runtime-side history window, tested DIRECTLY.
 *
 * Before R5a the equivalent behaviour was reachable only through `useChat` (a
 * mock-heavy hook suite) and through a synchronous `chars/4` walk. The selector
 * is now a pure async function of (messages, budget, counter), so it is tested
 * as one — no hook, no store, no adapter mock.
 */

import { describe, it, expect, vi } from 'vitest';
import { selectWindow, EVICTION_QUANTUM_FRACTION } from '../window';
import type { ChatMessage } from '../types';

/**
 * A deterministic stand-in for a model tokenizer: one token per whitespace-
 * delimited word. Real tokenizers are not reachable from a unit test (the
 * weights live in the worker), and the point of these tests is the SELECTION
 * logic, which only needs a counter that is real from the selector's point of
 * view — async, per-message, and not derived from `content.length / 4`.
 */
const wordCounter = async (text: string): Promise<number> =>
  text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

/** `pairs` user/assistant exchanges of `words` words each, uniquely marked. */
function conversation(pairs: number, words = 20): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let n = 0; n < pairs; n++) {
    out.push(msg('user', `u${n} ${'word '.repeat(words - 1).trim()}`));
    out.push(msg('assistant', `a${n} ${'word '.repeat(words - 1).trim()}`));
  }
  return out;
}

const SYSTEM = msg('system', 'you are a helpful assistant on this device');

describe('selectWindow — the shape every reference system uses', () => {
  it('keeps everything when the whole conversation fits', async () => {
    const messages = [SYSTEM, ...conversation(3)];
    const selection = await selectWindow(messages, {
      contextTokens: 4096,
      maxNewTokens: 512,
      countTokens: wordCounter,
    });

    expect(selection.messages).toEqual(messages);
    expect(selection.windowStartIndex).toBe(1);
    expect(selection.fits).toBe(true);
    expect(selection.countedWithTokenizer).toBe(true);
  });

  it('pins the system turn and evicts the oldest whole turns first', async () => {
    const turns = conversation(30);
    const selection = await selectWindow([SYSTEM, ...turns], {
      contextTokens: 512,
      maxNewTokens: 128,
      countTokens: wordCounter,
    });

    expect(selection.messages[0]).toEqual(SYSTEM);
    expect(selection.messages.length).toBeLessThan(turns.length + 1);
    // The retained conversation is a SUFFIX of the input — only whole messages
    // were dropped, from the front, and none was rewritten.
    const kept = selection.messages.slice(1);
    expect(turns.slice(turns.length - kept.length)).toEqual(kept);
    // …and it ends at the newest turn.
    expect(kept[kept.length - 1]).toEqual(turns[turns.length - 1]);
  });

  it('reports a windowStartIndex that indexes the message it actually sent', async () => {
    const messages = [SYSTEM, ...conversation(30)];
    const selection = await selectWindow(messages, {
      contextTokens: 512,
      maxNewTokens: 128,
      countTokens: wordCounter,
    });

    expect(messages[selection.windowStartIndex]).toEqual(selection.messages[1]);
    expect(selection.windowStartIndex).toBeGreaterThan(1);
  });

  it('opens the window on a user turn, never an orphaned assistant reply', async () => {
    for (const pairs of [8, 12, 20, 30, 45]) {
      const selection = await selectWindow([SYSTEM, ...conversation(pairs)], {
        contextTokens: 700,
        maxNewTokens: 128,
        countTokens: wordCounter,
      });
      expect(selection.messages[1]!.role).toBe('user');
    }
  });

  it('never evicts the final user turn, however small the budget', async () => {
    const turns = conversation(20);
    const selection = await selectWindow([SYSTEM, ...turns], {
      contextTokens: 64,
      maxNewTokens: 32,
      countTokens: wordCounter,
    });

    const finalUser = turns[turns.length - 2]!;
    expect(selection.messages).toContainEqual(finalUser);
    expect(selection.messages[selection.messages.length - 1]).toEqual(turns[turns.length - 1]);
  });

  it('keeps a trailing partial assistant turn (the continue-final-message path)', async () => {
    const partial = msg('assistant', 'the first half of the answer was');
    const messages = [SYSTEM, ...conversation(20), partial];
    const selection = await selectWindow(messages, {
      contextTokens: 300,
      maxNewTokens: 128,
      countTokens: wordCounter,
    });

    expect(selection.messages[selection.messages.length - 1]).toEqual(partial);
    expect(selection.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('reserves maxNewTokens: a larger reply reserve evicts more history', async () => {
    const messages = [SYSTEM, ...conversation(40)];
    const small = await selectWindow(messages, {
      contextTokens: 1024,
      maxNewTokens: 128,
      countTokens: wordCounter,
    });
    const large = await selectWindow(messages, {
      contextTokens: 1024,
      maxNewTokens: 768,
      countTokens: wordCounter,
    });

    expect(large.messages.length).toBeLessThan(small.messages.length);
    expect(large.windowStartIndex).toBeGreaterThan(small.windowStartIndex);
  });
});

describe('selectWindow — the refusal', () => {
  it('does not fit when the final user turn alone exceeds the history budget', async () => {
    const huge = msg('user', 'word '.repeat(5000).trim());
    const selection = await selectWindow([SYSTEM, huge], {
      contextTokens: 1024,
      maxNewTokens: 256,
      countTokens: wordCounter,
    });

    expect(selection.fits).toBe(false);
  });

  it('fits when a long conversation ends in a turn that does fit', async () => {
    const messages = [SYSTEM, ...conversation(80)];
    const selection = await selectWindow(messages, {
      contextTokens: 1024,
      maxNewTokens: 256,
      countTokens: wordCounter,
    });

    expect(selection.fits).toBe(true);
    expect(selection.messages.length).toBeLessThan(messages.length);
  });
});

describe('selectWindow — the counter', () => {
  it('uses the real counter, not a length heuristic', async () => {
    // Same characters, wildly different token counts: a counter-driven selector
    // must follow the counter. `chars/4` could not tell these apart.
    const messages = [SYSTEM, ...conversation(20)];
    const cheap = await selectWindow(messages, {
      contextTokens: 1024,
      maxNewTokens: 128,
      countTokens: async () => 1,
    });
    const dear = await selectWindow(messages, {
      contextTokens: 1024,
      maxNewTokens: 128,
      countTokens: async () => 200,
    });

    expect(cheap.messages).toEqual(messages);
    expect(dear.messages.length).toBeLessThan(messages.length);
  });

  it('counts every message exactly once', async () => {
    const counter = vi.fn(wordCounter);
    const messages = [SYSTEM, ...conversation(5)];
    await selectWindow(messages, {
      contextTokens: 4096,
      maxNewTokens: 512,
      countTokens: counter,
    });

    expect(counter).toHaveBeenCalledTimes(messages.length);
  });

  it('falls back to the sound one-token-per-character bound with no counter', async () => {
    const messages = [SYSTEM, ...conversation(20)];
    const selection = await selectWindow(messages, {
      contextTokens: 1024,
      maxNewTokens: 128,
    });

    expect(selection.countedWithTokenizer).toBe(false);
    // The bound can never under-count, so it never overflows: the retained
    // characters fit inside the token budget outright.
    const retainedChars = selection.messages
      .slice(1)
      .reduce((sum, m) => sum + m.content.length, 0);
    expect(retainedChars).toBeLessThanOrEqual(selection.historyBudgetTokens);
  });

  it('never refuses on the bound — it over-counts by design', async () => {
    // A 20-turn chat on the smallest shipping window. Under the bound the
    // window shrinks hard, but the turn must still RUN: a refusal is a
    // terminal answer to the user and must never rest on an over-count.
    const selection = await selectWindow([SYSTEM, ...conversation(10, 40)], {
      contextTokens: 2048,
      maxNewTokens: 1024,
    });

    expect(selection.countedWithTokenizer).toBe(false);
    expect(selection.fits).toBe(true);
  });

  it('falls back when the adapter cannot count this model (LiteRT returns null)', async () => {
    const selection = await selectWindow([SYSTEM, ...conversation(20)], {
      contextTokens: 1024,
      maxNewTokens: 128,
      countTokens: async () => null,
    });

    expect(selection.countedWithTokenizer).toBe(false);
  });

  it('falls back when the counter throws rather than refusing the turn', async () => {
    const selection = await selectWindow([SYSTEM, ...conversation(4)], {
      contextTokens: 4096,
      maxNewTokens: 128,
      countTokens: async () => {
        throw new Error('worker gone');
      },
    });

    expect(selection.countedWithTokenizer).toBe(false);
    expect(selection.messages.length).toBeGreaterThan(1);
  });
});

describe('selectWindow — the eviction quantum', () => {
  it('holds the window start still across turns that would otherwise slide it', async () => {
    // The KV-reuse gate is a strict-prefix check: a start that moves every turn
    // reprefills every turn. Quantized eviction is what buys the stability.
    const budget = { contextTokens: 1024, maxNewTokens: 128, countTokens: wordCounter };
    const starts: number[] = [];
    for (let pairs = 22; pairs <= 27; pairs++) {
      const selection = await selectWindow([SYSTEM, ...conversation(pairs)], budget);
      starts.push(selection.windowStartIndex);
    }

    // Some turns share a start; the start never moves backward.
    expect(new Set(starts).size).toBeLessThan(starts.length);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]!).toBeGreaterThanOrEqual(starts[i - 1]!);
    }
  });

  it('is an eighth of the history budget', () => {
    expect(EVICTION_QUANTUM_FRACTION).toBe(1 / 8);
  });
});

describe('selectWindow — degenerate inputs', () => {
  it('handles an empty list', async () => {
    const selection = await selectWindow([], { contextTokens: 4096, maxNewTokens: 512 });
    expect(selection).toMatchObject({ messages: [], windowStartIndex: 0, fits: true });
  });

  it('handles a system turn with no conversation', async () => {
    const selection = await selectWindow([SYSTEM], {
      contextTokens: 4096,
      maxNewTokens: 512,
      countTokens: wordCounter,
    });
    expect(selection.messages).toEqual([SYSTEM]);
    expect(selection.windowStartIndex).toBe(1);
  });

  it('handles a list with no system turn', async () => {
    const turns = conversation(2);
    const selection = await selectWindow(turns, {
      contextTokens: 4096,
      maxNewTokens: 512,
      countTokens: wordCounter,
    });
    expect(selection.messages).toEqual(turns);
    expect(selection.windowStartIndex).toBe(0);
  });
});
