// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Per-generation state for the on-device chat stream.
 *
 * #4 Phase 3 Task 2. Replaces the three module-scoped refs
 * (`activeAbortRef` / `activeReaderRef` / `activeGenerationRef`) that the old
 * `useChat.streamResponse` mutated directly. Each in-flight generation now owns
 * its OWN `AbortController`, current reader, and token batcher, so a newer
 * generation can never clobber an older one's abort/reader/seq state.
 *
 * A single module-level pointer (`activeGeneration`) records the
 * currently-active generation purely so `stopGeneration` /
 * `interruptActiveGeneration` can reach the in-flight one. Each generation
 * clears that pointer in its own teardown ONLY if it still points at itself —
 * the identity check is part of the generation's own lifecycle, not a band-aid
 * bolted onto `streamResponse`.
 */

import { useChatStore } from "../../stores/chatStore";
import { useConversationStore } from "../../stores/conversationStore";
import { persistConversationMessagesSnapshot } from "../../lib/chat-persistence";
import { createTokenBatcher, type TokenBatcher } from "./token-batcher";
import type { TokenStream } from "../../local-ai/runtime/stream";

/** Append signature the batcher writes through (the chat store's appendToMessage). */
type AppendToMessage = (
  id: string,
  token: string,
  generationId?: string,
  toSeq?: number,
  tokenDelta?: number,
) => void;

/**
 * Owns every piece of mutable state for a single on-device generation.
 *
 * The stream is mutable because a generation can re-stream within itself (the
 * hard-constraint repair loop swapped the primary stream for the repair one).
 * `interruptActiveGeneration` always cancels whichever stream is current.
 */
export type Generation = {
  /** Unique id; tags token batches so the store can drop stale/duplicate frames. */
  readonly id: string;
  /** Aborts this generation's in-flight stream (used by stopGeneration). */
  readonly abortController: AbortController;
  /** Conversation this generation belongs to, captured at creation. */
  readonly conversationId: string | null;
  /** This generation's token batcher (id + monotonic seq already set). */
  readonly batcher: TokenBatcher;
  /** The stream currently being drained. Swapped during the repair loop. */
  currentStream: TokenStream | null;
};

function newGenerationId(): string {
  return `gen-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

/**
 * Build a fresh generation: its own abort controller + a batcher pre-tagged
 * with a unique generation id and a reset seq counter.
 */
export function createGeneration(append: AppendToMessage): Generation {
  const id = newGenerationId();
  const batcher = createTokenBatcher(append);
  batcher.setGenerationId(id);
  batcher.resetSeq();
  return {
    id,
    abortController: new AbortController(),
    conversationId: useConversationStore.getState().activeConversationId,
    batcher,
    currentStream: null,
  };
}

// ─── Active-generation pointer ───────────────────────────────────────────────
// Module-scoped so stopGeneration / interruptActiveGeneration can reach the
// in-flight generation. Only ONE generation is ever active at a time in the UI;
// the pointer plus per-generation ownership means a stale generation tearing
// down can't null out a newer one's pointer (see `clearActiveGeneration`).

let activeGeneration: Generation | null = null;

export function setActiveGeneration(generation: Generation): void {
  activeGeneration = generation;
}

export function getActiveGeneration(): Generation | null {
  return activeGeneration;
}

/**
 * Whether the currently-active generation has been aborted (user-stop). Used by
 * the hook's caller-level catch blocks to avoid treating a user-stop as a
 * stream error. Returns false when no generation is active.
 */
export function isActiveGenerationAborted(): boolean {
  return activeGeneration?.abortController.signal.aborted ?? false;
}

/**
 * Clear the active pointer only if it still references `generation`. A newer
 * generation may have already taken ownership; in that case the older
 * generation's teardown must NOT clobber it.
 */
export function clearActiveGeneration(generation: Generation): void {
  if (activeGeneration === generation) {
    activeGeneration = null;
  }
}

/** @internal Test seam: directly set/clear the active-generation pointer. */
export function setActiveGenerationForTesting(generation: Generation | null): void {
  activeGeneration = generation;
}

function persistConversationSnapshot(conversationId: string | null): void {
  persistConversationMessagesSnapshot({
    conversationId,
    messages: useChatStore.getState().messages,
    conversationStore: useConversationStore.getState(),
  });
}

/**
 * Stop the currently-active generation: flush its pending tokens, abort it,
 * cancel its stream, mark the streaming message interrupted, persist a
 * snapshot, and return the stream phase to idle.
 *
 * This is the load-bearing user-stop path. It writes `{status:"complete",
 * streamInterrupted:true}` DIRECTLY here so "user-stop ⇒ interrupted" is an
 * explicit invariant — not an accident of how the read loop later unwinds. The
 * chat store's `appendToMessage` drops any tokens that arrive after this write,
 * and the generation's own completion handler skips re-finalizing once the
 * abort signal is set (see `runGeneration` callers).
 */
export function interruptActiveGeneration(options?: {
  flushPendingTokens?: boolean;
}): void {
  const generation = activeGeneration;
  if (options?.flushPendingTokens !== false) {
    generation?.batcher.flushSync();
  }
  activeGeneration = null;

  // Abort the in-flight generation, if any.
  generation?.abortController.abort();

  // Cancel the current stream to stop local token delivery. Synchronous and
  // idempotent, and a cancelled TokenStream resolves `done` immediately, so the
  // read loop unwinds without waiting for the runtime to notice its abort.
  const currentStream = generation?.currentStream ?? null;
  if (generation) {
    generation.currentStream = null;
  }
  currentStream?.cancel();

  const chatState = useChatStore.getState();
  const streamingMessage = [...chatState.messages]
    .reverse()
    .find((message) => message.status === "streaming");

  if (streamingMessage) {
    chatState.updateMessage(streamingMessage.id, {
      status: "complete",
      streamInterrupted: true,
      interruptedReason: "user-stop",
    });
  }

  persistConversationSnapshot(
    generation?.conversationId ?? useConversationStore.getState().activeConversationId,
  );
  chatState.setStreamPhase("idle");
}
