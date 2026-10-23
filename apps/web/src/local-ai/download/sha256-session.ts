// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * SHA-256 of a download as it arrives, off the page's main thread.
 *
 * Hashing a model file is pure CPU work (~60 MB/s in JavaScript): done on the
 * main thread after the download, a 0.8–1.9 GB model held the page in
 * back-to-back ~600 ms tasks for 15–36 s, so every click and keystroke waited.
 * A session copies each piece of the download to a hash worker as it streams
 * past, so the hash runs beside the download and the page stays free.
 *
 * Memory: at most `MAX_IN_FLIGHT_BYTES` wait in the worker; `update` holds the
 * stream back beyond that, so a link faster than the hash slows to the hash
 * instead of queueing the file in memory.
 *
 * Failure: a session whose worker dies keeps accepting bytes (dropping them)
 * so the download is never failed by the hasher; its `digest` then rejects and
 * the caller re-hashes the stored bytes in the page.
 */

import {
  createSha256State,
  type Sha256WorkerRequest,
  type Sha256WorkerResponse,
} from './sha256-state';

export type Sha256Session = {
  /** Hash these bytes (copied; the caller keeps its buffer). Resolves when the worker has room. */
  update(bytes: Uint8Array): Promise<void>;
  /** Keep everything so far: a chunk was persisted. */
  commit(): void;
  /** Forget everything since the last commit: the chunk will be fetched again. */
  rollback(): void;
  digest(): Promise<string>;
  /** Stop the worker. Always call when the file is done, failed or aborted. */
  dispose(): void;
};

/** The part of a Worker a session uses (a test seam). */
export type Sha256Worker = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener'>;

/** Bytes per message to the worker: few messages, little copying overhead. */
export const BATCH_BYTES = 1 << 20;
/** Bytes allowed to wait in the worker before `update` holds the stream back. */
export const MAX_IN_FLIGHT_BYTES = 8 << 20;

let workerFactory: (() => Sha256Worker) | null = null;

/** Installed at boot (`bootstrap.ts`); without one, sessions hash in the page. */
export function setSha256WorkerFactory(factory: (() => Sha256Worker) | null): void {
  workerFactory = factory;
}

export function hasSha256WorkerFactory(): boolean {
  return workerFactory !== null;
}

export function createSha256Session(): Sha256Session {
  if (workerFactory) {
    try {
      return createWorkerSession(workerFactory());
    } catch {
      // A worker that can't start (blocked by policy, unsupported) — hash in the page.
    }
  }
  return createInPageSession();
}

function createInPageSession(): Sha256Session {
  const state = createSha256State();
  return {
    update: async (bytes) => state.update(bytes),
    commit: () => state.commit(),
    rollback: () => state.rollback(),
    digest: async () => state.digest(),
    dispose: () => undefined,
  };
}

function createWorkerSession(worker: Sha256Worker): Sha256Session {
  let staged = new Uint8Array(BATCH_BYTES);
  let stagedBytes = 0;
  let inFlightBytes = 0;
  let failure: Error | null = null;
  let roomWaiters: Array<() => void> = [];
  let pendingDigest: { resolve: (hex: string) => void; reject: (err: Error) => void } | null = null;

  const post = (request: Sha256WorkerRequest, transfer: Transferable[] = []) => {
    if (failure) return;
    try {
      worker.postMessage(request, transfer);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  };
  const wakeRoomWaiters = () => {
    const waiters = roomWaiters;
    roomWaiters = [];
    for (const wake of waiters) wake();
  };
  const fail = (err: Error) => {
    if (failure) return;
    failure = err;
    wakeRoomWaiters();
    pendingDigest?.reject(err);
    pendingDigest = null;
  };
  const flush = () => {
    if (stagedBytes === 0 || failure) return;
    const bytes = staged.subarray(0, stagedBytes);
    inFlightBytes += stagedBytes;
    staged = new Uint8Array(BATCH_BYTES);
    stagedBytes = 0;
    post({ type: 'update', bytes }, [bytes.buffer]);
  };

  worker.addEventListener('message', (event: MessageEvent<Sha256WorkerResponse>) => {
    const reply = event.data;
    if (reply.type === 'ack') {
      inFlightBytes -= reply.bytes;
      if (inFlightBytes <= MAX_IN_FLIGHT_BYTES) wakeRoomWaiters();
    } else {
      pendingDigest?.resolve(reply.hex);
      pendingDigest = null;
    }
  });
  worker.addEventListener('error', () => fail(new Error('SHA-256 worker failed')));
  worker.addEventListener('messageerror', () => fail(new Error('SHA-256 worker message failed')));

  return {
    async update(bytes) {
      let offset = 0;
      while (offset < bytes.byteLength && !failure) {
        const n = Math.min(bytes.byteLength - offset, BATCH_BYTES - stagedBytes);
        staged.set(bytes.subarray(offset, offset + n), stagedBytes);
        stagedBytes += n;
        offset += n;
        if (stagedBytes === BATCH_BYTES) flush();
      }
      while (inFlightBytes > MAX_IN_FLIGHT_BYTES && !failure) {
        await new Promise<void>((resolve) => roomWaiters.push(resolve));
      }
    },
    commit() {
      flush();
      post({ type: 'commit' });
    },
    rollback() {
      stagedBytes = 0;
      post({ type: 'rollback' });
    },
    digest() {
      flush();
      if (failure) return Promise.reject(failure);
      return new Promise<string>((resolve, reject) => {
        pendingDigest = { resolve, reject };
        post({ type: 'digest' });
      });
    },
    dispose() {
      fail(new Error('SHA-256 session disposed'));
      worker.terminate();
    },
  };
}
