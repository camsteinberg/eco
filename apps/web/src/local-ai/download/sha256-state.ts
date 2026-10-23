// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * An incremental SHA-256 with one checkpoint, for hashing a download as its
 * bytes arrive.
 *
 * `commit()` marks the bytes so far as kept (a chunk was persisted);
 * `rollback()` forgets everything since the last commit (a chunk's request
 * failed mid-stream and will be fetched again from its start). The same state
 * runs inside the hash worker and, where no worker is available, in the page.
 */
export type Sha256State = {
  update(bytes: Uint8Array): void;
  commit(): void;
  rollback(): void;
  /** Hex digest of everything committed or updated since the last rollback. */
  digest(): string;
};

export function createSha256State(): Sha256State {
  let current = sha256.create();
  let checkpoint = current.clone();
  return {
    update(bytes) {
      current.update(bytes);
    },
    commit() {
      checkpoint = current.clone();
    },
    rollback() {
      current = checkpoint.clone();
    },
    digest() {
      return bytesToHex(current.clone().digest());
    },
  };
}

/** Messages the page sends the hash worker, in order. */
export type Sha256WorkerRequest =
  | { type: 'update'; bytes: Uint8Array }
  | { type: 'commit' }
  | { type: 'rollback' }
  | { type: 'digest' };

/** Messages the hash worker sends back. */
export type Sha256WorkerResponse =
  /** One `update` was hashed; `bytes` is its length (the page's backpressure count). */
  | { type: 'ack'; bytes: number }
  | { type: 'digest'; hex: string };

/**
 * The worker's message handler, outside the worker file so it can be tested
 * without a Worker. Returns the reply to post, if any.
 */
export function handleSha256WorkerRequest(
  state: Sha256State,
  request: Sha256WorkerRequest,
): Sha256WorkerResponse | null {
  switch (request.type) {
    case 'update':
      state.update(request.bytes);
      return { type: 'ack', bytes: request.bytes.byteLength };
    case 'commit':
      state.commit();
      return null;
    case 'rollback':
      state.rollback();
      return null;
    case 'digest':
      return { type: 'digest', hex: state.digest() };
  }
}
