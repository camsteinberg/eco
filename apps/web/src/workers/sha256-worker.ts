// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Hash worker: SHA-256 of a model file as the page downloads it, so the
 * integrity check never blocks the page. One worker per file; the page
 * terminates it when the file is done. Protocol: `sha256-state.ts`.
 */

import {
  createSha256State,
  handleSha256WorkerRequest,
  type Sha256WorkerRequest,
  type Sha256WorkerResponse,
} from '../local-ai/download/sha256-state';

type WorkerSelf = {
  postMessage(message: Sha256WorkerResponse): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<Sha256WorkerRequest>) => void,
  ): void;
};

declare const self: WorkerSelf;

const state = createSha256State();

self.addEventListener('message', (event) => {
  const reply = handleSha256WorkerRequest(state, event.data);
  if (reply) self.postMessage(reply);
});
