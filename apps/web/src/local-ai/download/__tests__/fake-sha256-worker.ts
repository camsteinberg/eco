// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import {
  createSha256State,
  handleSha256WorkerRequest,
  type Sha256WorkerRequest,
  type Sha256WorkerResponse,
} from '../sha256-state';
import type { Sha256Worker } from '../sha256-session';

type Listener = (event: MessageEvent<Sha256WorkerResponse> | Event) => void;

/**
 * An in-process stand-in for the hash worker: the real handler and state, with
 * the worker's semantics that matter to the page — messages are structured-
 * cloned with their transfer list (a transferred buffer is detached on the
 * sender's side) and replies arrive asynchronously.
 */
export class FakeSha256Worker implements Sha256Worker {
  readonly requests: Sha256WorkerRequest['type'][] = [];
  readonly updateSizes: number[] = [];
  terminated = false;
  /** When set, acks wait in `heldAcks` until `releaseAcks()`. */
  holdAcks = false;
  /** Fire an `error` event instead of handling the Nth update (1-based). */
  failAtUpdate: number | null = null;
  private readonly heldAcks: Sha256WorkerResponse[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  private readonly state = createSha256State();
  private failed = false;

  postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
    const options = Array.isArray(transfer) ? { transfer } : transfer;
    const request = structuredClone(message, options) as Sha256WorkerRequest;
    if (this.terminated || this.failed) return;
    this.requests.push(request.type);
    if (request.type === 'update') {
      this.updateSizes.push(request.bytes.byteLength);
      if (this.failAtUpdate === this.updateSizes.length) {
        this.failed = true;
        setTimeout(() => this.emit('error', new Event('error')), 0);
        return;
      }
    }
    const reply = handleSha256WorkerRequest(this.state, request);
    if (!reply) return;
    if (reply.type === 'ack' && this.holdAcks) {
      this.heldAcks.push(reply);
      return;
    }
    setTimeout(() => this.reply(reply), 0);
  }

  releaseAcks(): void {
    for (const reply of this.heldAcks.splice(0)) this.reply(reply);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private reply(reply: Sha256WorkerResponse): void {
    if (this.terminated) return;
    this.emit('message', new MessageEvent('message', { data: reply }));
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
