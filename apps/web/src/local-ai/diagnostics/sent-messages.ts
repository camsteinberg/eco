// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * What the chat handed the runtime — harness-only, read-only.
 *
 * A browser walk can see what the screen shows and what storage holds, but
 * not what the model was actually sent: an edit that shows on screen while the
 * model is generating from the text it replaced passes every check that reads
 * the page. `stream` records the message list it hands the runtime (after the
 * history window is chosen) into a small ring, and this module exposes the ring
 * on `window.__ecoHarnessSent` for an out-of-page reader.
 *
 *   - gated on `isValidationHarnessEnabled()`, like the other validation seams:
 *     nothing is copied, and the global never exists, off the harness — which
 *     is never on a production host;
 *   - message CONTENT, held in this page's memory only and never sent
 *     anywhere. It is a separate global so `window.__ecoPerf` stays free of
 *     message content (see `perf-bridge.ts`);
 *   - bounded to the last `SENT_RING_SIZE` generations, handed out as copies.
 */

import { isValidationHarnessEnabled } from '../../lib/validation-harness';
import type { ChatMessage, ChatRole } from '../runtime/types';

export const SENT_RING_SIZE = 8;

export type SentMessages = {
  /** 1-based count of generations recorded on this page. */
  seq: number;
  modelId: string;
  /** What `stream` handed the runtime: the windowed list, system prompt included. */
  messages: readonly { role: ChatRole; content: string }[];
};

declare global {
  var __ecoHarnessSent: (() => SentMessages[]) | undefined;
}

/** Oldest first; the reader reverses it. */
const ring: SentMessages[] = [];
let seq = 0;

function copy(record: SentMessages): SentMessages {
  return {
    seq: record.seq,
    modelId: record.modelId,
    messages: record.messages.map((m) => ({ role: m.role, content: m.content })),
  };
}

/** Record the list a generation is about to be handed. A no-op off the harness. */
export function recordSentMessages(modelId: string, messages: readonly ChatMessage[]): void {
  if (typeof window === 'undefined' || !isValidationHarnessEnabled()) return;
  seq += 1;
  ring.push(copy({ seq, modelId, messages }));
  if (ring.length > SENT_RING_SIZE) ring.splice(0, ring.length - SENT_RING_SIZE);
  window.__ecoHarnessSent ??= () => ring.map(copy).reverse();
}

/** @internal Test isolation only: empties the ring, resets the count and removes the global. */
export function clearSentMessages(): void {
  ring.length = 0;
  seq = 0;
  if (typeof window !== 'undefined') delete window.__ecoHarnessSent;
}
