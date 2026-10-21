// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * `asyncStream` stands in for `async function*` on the reply path, so each
 * case here is a behaviour the reply path relied on from native async
 * generators: ordered emits, `return()` running `finally` at the paused point,
 * a rejected wait thrown into the body, and requests answered in order.
 */

import { describe, expect, it } from 'vitest';
import { asyncStream, wait, type StreamBody } from '../async-stream';

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

describe('asyncStream', () => {
  it('emits yielded values in order, with waits resolved in between', async () => {
    const stream = asyncStream(function* (): StreamBody<number> {
      yield 1;
      const two = yield* wait(Promise.resolve(2));
      yield two;
      const three = yield* wait(3);
      yield three;
    });
    expect(await drain(stream)).toEqual([1, 2, 3]);
  });

  it('return() while paused at a yield runs finally, including a waiting finally, and resolves done', async () => {
    const log: string[] = [];
    const stream = asyncStream(function* (): StreamBody<number> {
      try {
        yield 1;
        yield 2;
        log.push('after-2');
      } finally {
        log.push('finally-start');
        const value = yield* wait(new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 5)));
        log.push(`finally-${value}`);
      }
    });
    expect(await stream.next()).toEqual({ done: false, value: 1 });
    expect(await stream.return()).toEqual({ done: true, value: undefined });
    expect(log).toEqual(['finally-start', 'finally-waited']);
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it('return() before the first next() never runs the body', async () => {
    let ran = false;
    const stream = asyncStream(function* (): StreamBody<number> {
      ran = true;
      try {
        yield 1;
      } finally {
        ran = true;
      }
    });
    expect(await stream.return()).toEqual({ done: true, value: undefined });
    expect(ran).toBe(false);
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    expect(ran).toBe(false);
  });

  it('a rejected wait throws inside the body, where a catch can recover', async () => {
    const stream = asyncStream(function* (): StreamBody<string> {
      try {
        yield* wait(Promise.reject(new Error('boom')));
        yield 'unreachable';
      } catch (err) {
        yield `caught ${(err as Error).message}`;
      }
      yield 'after';
    });
    expect(await drain(stream)).toEqual(['caught boom', 'after']);
  });

  it('an uncaught body error rejects that next(), and later next()s resolve done', async () => {
    const stream = asyncStream(function* (): StreamBody<number> {
      yield 1;
      yield* wait(Promise.reject(new Error('fault')));
    });
    expect(await stream.next()).toEqual({ done: false, value: 1 });
    await expect(stream.next()).rejects.toThrow('fault');
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it('answers requests made while one is pending in order', async () => {
    let release: (value: number) => void = () => undefined;
    const gate = new Promise<number>((resolve) => {
      release = resolve;
    });
    const log: string[] = [];
    const stream = asyncStream(function* (): StreamBody<number> {
      try {
        const first = yield* wait(gate);
        yield first;
        yield first + 1;
        yield first + 2;
      } finally {
        log.push('finally');
      }
    });
    const first = stream.next();
    const second = stream.next();
    const closed = stream.return();
    const after = stream.next();
    release(10);
    expect(await first).toEqual({ done: false, value: 10 });
    expect(await second).toEqual({ done: false, value: 11 });
    expect(await closed).toEqual({ done: true, value: undefined });
    expect(await after).toEqual({ done: true, value: undefined });
    expect(log).toEqual(['finally']);
  });

  it('throw() raises the error at the paused yield', async () => {
    const caught = asyncStream(function* (): StreamBody<string> {
      try {
        yield 'first';
      } catch (err) {
        yield `caught ${(err as Error).message}`;
      }
    });
    expect(await caught.next()).toEqual({ done: false, value: 'first' });
    expect(await caught.throw(new Error('injected'))).toEqual({ done: false, value: 'caught injected' });
    expect(await caught.next()).toEqual({ done: true, value: undefined });

    const uncaught = asyncStream(function* (): StreamBody<string> {
      yield 'first';
    });
    await uncaught.next();
    await expect(uncaught.throw(new Error('injected'))).rejects.toThrow('injected');
    expect(await uncaught.next()).toEqual({ done: true, value: undefined });
  });
});
