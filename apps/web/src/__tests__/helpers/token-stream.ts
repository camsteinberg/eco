// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Scripted `TokenStream`s for the hook tests.
 *
 * Every suite that mocks `local-ai/runtime/stream` needs the same thing: a REAL
 * async iterable that yields scripted tokens, optionally ends with a `done`
 * event carrying usage, and optionally throws or blocks until cancelled. Before
 * R4b each suite hand-rolled the `ReadableStream` equivalent.
 *
 * Deliberately NOT a copy of production's iterator: this is a plain
 * async-generator stream that COOPERATES with its abort signal (the hang case
 * awaits the abort event; the token loop checks it). Production's `stream()`
 * additionally short-circuits a cancelled `next()` so a NON-cooperating runtime
 * can't hold the UI — that shortcut is tested directly, against a deliberately
 * unresponsive iterable, in `local-ai/runtime/__tests__/stream.test.ts`. Copying
 * it here would let a broken production shortcut hide behind a helper that
 * reimplements it.
 */

import type { DoneEvent, TokenStream } from '../../local-ai/runtime/stream';
import type { TokenEvent } from '../../local-ai/runtime/types';

export type TokenStreamScript = {
  /** Tokens to yield, in order. */
  tokens?: string[];
  /**
   * The terminating `done` payload (usage, tokenizer name). Defaults to a bare
   * `{ kind: 'done' }`; pass `null` for an adapter that ends without one.
   */
  done?: Omit<DoneEvent, 'kind'> | null;
  /** Thrown after the tokens are yielded — the mid-reply failure case. */
  error?: unknown;
  /** Yield the tokens, then block until the consumer cancels. */
  hang?: boolean;
  /** Fires when the consumer cancels the stream. */
  onCancel?: () => void;
};

export function scriptedTokenStream(script: TokenStreamScript = {}): TokenStream {
  const controller = new AbortController();

  async function* run(): AsyncGenerator<TokenEvent> {
    for (const text of script.tokens ?? []) {
      if (controller.signal.aborted) return;
      yield { kind: 'token', text };
    }
    if (script.error !== undefined) throw script.error;
    if (script.hang) {
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
      return;
    }
    if (script.done !== null) yield { kind: 'done', ...(script.done ?? {}) };
  }

  return {
    [Symbol.asyncIterator]: () => run(),
    cancel: () => {
      script.onCancel?.();
      controller.abort();
    },
  };
}
