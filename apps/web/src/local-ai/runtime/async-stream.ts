// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Async streams without native async generators.
 *
 * Safari 27's JavaScriptCore crashes the tab (a null code block during JIT
 * tier-up) when native async generators resume one another on the page's main
 * thread — the shape the reply path had (stream → lifecycle → adapter). A
 * standalone page reproduces it in minutes with a fake engine; the same layers
 * written as SYNC generators driven by promises — the shape WebLLM's own stream
 * already uses — did not crash.
 *
 * `asyncStream(function* () { ... })` behaves like an `async function*`:
 * requests queue, `return()` runs the body's `finally` at the paused point, and
 * a rejected wait throws inside the body. The one difference in the body:
 * write `yield* wait(p)` where an async generator would write `await p`. A
 * plain `yield value` emits `value` as-is (it is not awaited).
 */

class Pending {
  constructor(readonly promise: Promise<unknown>) {}
}

export type StreamBody<T> = Generator<T | Pending, void, unknown>;

export type EventStream<T> = AsyncIterableIterator<T> & {
  return(value?: unknown): Promise<IteratorResult<T, void>>;
  throw(error: unknown): Promise<IteratorResult<T, void>>;
};

/** `yield* wait(p)` inside an `asyncStream` body, where an async generator would `await p`. */
export function* wait<V>(value: V | PromiseLike<V>): Generator<Pending, V, unknown> {
  return (yield new Pending(Promise.resolve(value))) as V;
}

type Verb = 'next' | 'throw' | 'return';
type Request<T> = {
  verb: Verb;
  arg: unknown;
  resolve: (result: IteratorResult<T, void>) => void;
  reject: (error: unknown) => void;
};

export function asyncStream<T>(body: () => StreamBody<T>): EventStream<T> {
  // Creating the generator does not run the body; the first next() does.
  const gen = body();
  const queue: Array<Request<T>> = [];

  function resume(verb: Verb, arg: unknown): void {
    let step: IteratorResult<T | Pending, void>;
    try {
      step = verb === 'next' ? gen.next(arg) : verb === 'throw' ? gen.throw(arg) : gen.return(undefined);
    } catch (error) {
      settle((request) => request.reject(error));
      return;
    }
    if (step.done) {
      settle((request) => request.resolve({ done: true, value: undefined }));
      return;
    }
    const value = step.value;
    if (value instanceof Pending) {
      value.promise.then(
        (resolved) => resume('next', resolved),
        (error: unknown) => resume('throw', error),
      );
      return;
    }
    settle((request) => request.resolve({ done: false, value }));
  }

  // Answer the request at the head of the queue, then start the next one.
  function settle(answer: (request: Request<T>) => void): void {
    const head = queue.shift();
    if (head) answer(head);
    const following = queue[0];
    if (following) resume(following.verb, following.arg);
  }

  function request(verb: Verb, arg: unknown): Promise<IteratorResult<T, void>> {
    return new Promise((resolve, reject) => {
      if (queue.push({ verb, arg, resolve, reject }) === 1) resume(verb, arg);
    });
  }

  const stream: EventStream<T> = {
    next: (...args: [] | [unknown]) => request('next', args[0]),
    return: (value?: unknown) => request('return', value),
    throw: (error: unknown) => request('throw', error),
    [Symbol.asyncIterator]: () => stream,
  };
  return stream;
}
