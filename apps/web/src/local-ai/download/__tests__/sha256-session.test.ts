// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  BATCH_BYTES,
  MAX_IN_FLIGHT_BYTES,
  createSha256Session,
  setSha256WorkerFactory,
  type Sha256Worker,
} from '../sha256-session';
import { createSha256State } from '../sha256-state';
import { FakeSha256Worker } from './fake-sha256-worker';

function bytes(n: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const hex = (b: Uint8Array) => bytesToHex(sha256(b));

function installFake(): FakeSha256Worker {
  const worker = new FakeSha256Worker();
  setSha256WorkerFactory(() => worker as unknown as Sha256Worker);
  return worker;
}

/** Let the fake's asynchronous replies arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => setSha256WorkerFactory(null));

describe('createSha256State', () => {
  it('rolls back to the last commit and digests without ending the hash', () => {
    const a = bytes(100, 1);
    const b = bytes(70, 2);
    const c = bytes(50, 3);
    const state = createSha256State();
    state.update(a);
    state.commit();
    state.update(b);
    state.rollback();
    state.update(c);
    expect(state.digest()).toBe(hex(concat(a, c)));
    state.update(b);
    expect(state.digest()).toBe(hex(concat(a, c, b)));
  });
});

describe('createSha256Session — in the page (no worker factory)', () => {
  it('hashes, commits and rolls back like the state it wraps', async () => {
    const session = createSha256Session();
    const a = bytes(10, 1);
    const b = bytes(10, 2);
    await session.update(a);
    session.commit();
    await session.update(b);
    session.rollback();
    await session.update(b);
    expect(await session.digest()).toBe(hex(concat(a, b)));
  });

  it('falls back to the page when the worker cannot start', async () => {
    setSha256WorkerFactory(() => {
      throw new Error('blocked');
    });
    const session = createSha256Session();
    await session.update(bytes(5));
    expect(await session.digest()).toBe(hex(bytes(5)));
  });
});

describe('createSha256Session — through a worker', () => {
  it('batches odd-sized pieces into messages of at most BATCH_BYTES and digests them all', async () => {
    const worker = installFake();
    const session = createSha256Session();
    const pieces = [bytes(65_537, 1), bytes(1_500_000, 2), bytes(3, 3), bytes(2_200_000, 4)];
    for (const piece of pieces) await session.update(piece);
    expect(await session.digest()).toBe(hex(concat(...pieces)));
    expect(Math.max(...worker.updateSizes)).toBeLessThanOrEqual(BATCH_BYTES);
    expect(worker.updateSizes.reduce((n, s) => n + s, 0)).toBe(
      pieces.reduce((n, p) => n + p.byteLength, 0),
    );
  });

  it('copies the caller\'s bytes — the caller\'s buffer still holds them after update', async () => {
    installFake();
    const session = createSha256Session();
    const piece = bytes(BATCH_BYTES + 10);
    const before = hex(piece);
    await session.update(piece);
    expect(piece.byteLength).toBe(BATCH_BYTES + 10);
    expect(hex(piece)).toBe(before);
  });

  it('a rollback forgets both the staged bytes and the bytes already sent since the last commit', async () => {
    installFake();
    const session = createSha256Session();
    const kept = bytes(BATCH_BYTES + 5, 1);
    const sentThenDropped = bytes(BATCH_BYTES * 2 + 7, 2); // two batches sent, 7 bytes staged
    const retried = bytes(BATCH_BYTES * 2 + 7, 3);
    await session.update(kept);
    session.commit();
    await session.update(sentThenDropped);
    session.rollback();
    await session.update(retried);
    session.commit();
    expect(await session.digest()).toBe(hex(concat(kept, retried)));
  });

  it('holds the stream back while more than MAX_IN_FLIGHT_BYTES wait in the worker', async () => {
    const worker = installFake();
    worker.holdAcks = true;
    const session = createSha256Session();
    let resolved = false;
    const pending = session.update(bytes(MAX_IN_FLIGHT_BYTES + BATCH_BYTES)).then(() => {
      resolved = true;
    });
    await settle();
    expect(resolved).toBe(false);
    worker.releaseAcks();
    await pending;
    expect(resolved).toBe(true);
  });

  it('a dead worker never fails the stream: updates go on, the digest rejects', async () => {
    const worker = installFake();
    worker.failAtUpdate = 1;
    const session = createSha256Session();
    await session.update(bytes(BATCH_BYTES * 3));
    await settle();
    await expect(session.update(bytes(BATCH_BYTES))).resolves.toBeUndefined();
    await expect(session.digest()).rejects.toThrow(/worker failed/);
  });

  it('dispose terminates the worker and releases a held update', async () => {
    const worker = installFake();
    worker.holdAcks = true;
    const session = createSha256Session();
    const pending = session.update(bytes(MAX_IN_FLIGHT_BYTES + BATCH_BYTES));
    await settle();
    session.dispose();
    await expect(pending).resolves.toBeUndefined();
    expect(worker.terminated).toBe(true);
  });
});
