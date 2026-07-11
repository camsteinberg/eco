// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for the per-generation object (`generation.ts`). #4 Phase 3 Task 3.
 *
 * The per-generation object replaced three module-scoped refs whose mutation let
 * a newer generation clobber an older one's abort/reader/seq state. These tests
 * pin the units directly:
 *   - `createGeneration` produces a fresh id + AbortController + pre-tagged
 *     batcher + captured conversationId.
 *   - the active-pointer identity guard (`clearActiveGeneration` only nulls the
 *     pointer when it still references the clearing generation).
 *   - `isActiveGenerationAborted` reflects the active gen's signal.
 *   - `interruptActiveGeneration` flushes, aborts, cancels the reader, marks the
 *     streaming message interrupted, sets phase idle, and no-throws when idle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  createGeneration,
  setActiveGeneration,
  getActiveGeneration,
  clearActiveGeneration,
  isActiveGenerationAborted,
  interruptActiveGeneration,
  setActiveGenerationForTesting,
  type Generation,
} from "../generation";
import { useChatStore } from "../../../stores/chatStore";
import { useConversationStore } from "../../../stores/conversationStore";

function makeGeneration(append = vi.fn()): Generation {
  return createGeneration(append);
}

beforeEach(() => {
  setActiveGenerationForTesting(null);
  useChatStore.setState({
    messages: [],
    composerDraft: "",
    streamPhase: "idle",
    isStreaming: false,
    error: null,
    selectedModel: "auto",
  });
  useConversationStore.setState({ activeConversationId: null });
});

afterEach(() => {
  setActiveGenerationForTesting(null);
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. createGeneration
// ═══════════════════════════════════════════════════════════════════════════

describe("createGeneration", () => {
  it("produces a unique id on each call", () => {
    const a = makeGeneration();
    const b = makeGeneration();
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThan(0);
  });

  it("gives each generation its own fresh, un-aborted AbortController", () => {
    const a = makeGeneration();
    const b = makeGeneration();
    expect(a.abortController).not.toBe(b.abortController);
    expect(a.abortController.signal.aborted).toBe(false);
    expect(b.abortController.signal.aborted).toBe(false);

    // Aborting one does not touch the other.
    a.abortController.abort();
    expect(a.abortController.signal.aborted).toBe(true);
    expect(b.abortController.signal.aborted).toBe(false);
  });

  it("pre-tags the batcher with the generation id and a reset seq", () => {
    const calls: { genId?: string; seq?: number }[] = [];
    const generation = createGeneration((_id, _token, genId, seq) => {
      calls.push({ genId, seq });
    });

    // The batcher is already tagged with the gen id; seq starts at 1 on the
    // first flushed batch (resetSeq was called at creation).
    generation.batcher.append("m1", "hello");
    generation.batcher.flushSync();

    expect(calls).toEqual([{ genId: generation.id, seq: 1 }]);
  });

  it("captures the active conversationId at creation time", () => {
    useConversationStore.setState({ activeConversationId: "conv-42" });
    const generation = makeGeneration();
    expect(generation.conversationId).toBe("conv-42");

    // A later conversation switch does not retroactively change the captured id.
    useConversationStore.setState({ activeConversationId: "conv-99" });
    expect(generation.conversationId).toBe("conv-42");
  });

  it("starts with no current reader", () => {
    expect(makeGeneration().currentReader).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The identity guard — the core anti-clobber property
// ═══════════════════════════════════════════════════════════════════════════

describe("clearActiveGeneration — identity guard", () => {
  it("DOES null the pointer when the clearing generation is still active", () => {
    const genA = makeGeneration();
    setActiveGeneration(genA);
    expect(getActiveGeneration()).toBe(genA);

    clearActiveGeneration(genA);
    expect(getActiveGeneration()).toBeNull();
  });

  it("does NOT null the pointer when a newer generation has taken over", () => {
    const genA = makeGeneration();
    const genB = makeGeneration();

    setActiveGeneration(genA);
    // genB becomes active while genA is still 'in flight'.
    setActiveGeneration(genB);
    expect(getActiveGeneration()).toBe(genB);

    // genA's teardown must NOT clobber genB's pointer.
    clearActiveGeneration(genA);
    expect(getActiveGeneration()).toBe(genB);
  });

  it("is a no-op when nothing is active", () => {
    const genA = makeGeneration();
    expect(getActiveGeneration()).toBeNull();
    clearActiveGeneration(genA);
    expect(getActiveGeneration()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. isActiveGenerationAborted
// ═══════════════════════════════════════════════════════════════════════════

describe("isActiveGenerationAborted", () => {
  it("returns false when no generation is active", () => {
    expect(getActiveGeneration()).toBeNull();
    expect(isActiveGenerationAborted()).toBe(false);
  });

  it("reflects the active generation's abort signal", () => {
    const generation = makeGeneration();
    setActiveGeneration(generation);
    expect(isActiveGenerationAborted()).toBe(false);

    generation.abortController.abort();
    expect(isActiveGenerationAborted()).toBe(true);
  });

  it("tracks the CURRENTLY-active gen, not a previously-active one", () => {
    const genA = makeGeneration();
    const genB = makeGeneration();

    setActiveGeneration(genA);
    genA.abortController.abort();
    expect(isActiveGenerationAborted()).toBe(true);

    // genB takes over and is not aborted → the predicate flips back to false.
    setActiveGeneration(genB);
    expect(isActiveGenerationAborted()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. interruptActiveGeneration
// ═══════════════════════════════════════════════════════════════════════════

describe("interruptActiveGeneration", () => {
  /** Seed a streaming assistant message so the interrupt has something to mark. */
  function seedStreamingMessage(content = "partial"): string {
    const id = useChatStore.getState().addMessage({
      role: "assistant",
      content,
    });
    useChatStore.getState().updateMessage(id, { status: "streaming" });
    return id;
  }

  it("flushes pending tokens, aborts, marks the streaming message interrupted, and idles the phase", () => {
    const id = seedStreamingMessage("so far");
    // A generation whose batcher writes through to the store, with a buffered
    // pending token (not yet flushed) to prove flushPendingTokens runs.
    const generation = createGeneration((mid, token, genId, seq) => {
      useChatStore.getState().appendToMessage(mid, token, genId, seq);
    });
    useChatStore.getState().updateMessage(id, {
      currentGenerationId: generation.id,
    });
    setActiveGeneration(generation);
    useChatStore.getState().setStreamPhase("generating");

    // Buffer a token WITHOUT flushing (jsdom has no rAF → stays buffered).
    generation.batcher.append(id, " pending");

    interruptActiveGeneration();

    const msg = useChatStore.getState().messages.find((m) => m.id === id)!;
    // flushPendingTokens default true → the buffered token landed first.
    expect(msg.content).toBe("so far pending");
    expect(msg.status).toBe("complete");
    expect(msg.streamInterrupted).toBe(true);
    // The stop was the user's — record that so the marker copy can say so.
    expect(msg.interruptedReason).toBe("user-stop");
    expect(generation.abortController.signal.aborted).toBe(true);
    expect(useChatStore.getState().streamPhase).toBe("idle");
    // The active pointer is cleared.
    expect(getActiveGeneration()).toBeNull();
  });

  it("does NOT flush pending tokens when flushPendingTokens:false", () => {
    const id = seedStreamingMessage("kept");
    const generation = createGeneration((mid, token, genId, seq) => {
      useChatStore.getState().appendToMessage(mid, token, genId, seq);
    });
    useChatStore.getState().updateMessage(id, {
      currentGenerationId: generation.id,
    });
    setActiveGeneration(generation);

    // First token paints immediately (immediate-first-paint) → visible. The
    // second is buffered behind the metered drain (jsdom has no rAF) and stays
    // pending.
    generation.batcher.append(id, " painted");
    generation.batcher.append(id, " dropped");
    interruptActiveGeneration({ flushPendingTokens: false });

    const msg = useChatStore.getState().messages.find((m) => m.id === id)!;
    // The still-buffered " dropped" was NOT flushed; only the already-painted
    // first token survives.
    expect(msg.content).toBe("kept painted");
    expect(msg.status).toBe("complete");
    expect(msg.streamInterrupted).toBe(true);
    expect(generation.abortController.signal.aborted).toBe(true);
  });

  it("cancels the active generation's current reader", async () => {
    const id = seedStreamingMessage();
    const generation = makeGeneration();
    setActiveGeneration(generation);
    useChatStore.getState().updateMessage(id, {
      currentGenerationId: generation.id,
    });

    let cancelled = false;
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("x");
      },
      cancel() {
        cancelled = true;
      },
    });
    generation.currentReader = stream.getReader();

    interruptActiveGeneration();
    // cancel() is fire-and-forget inside interrupt; let its microtask settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(cancelled).toBe(true);
    // The reader slot is nulled out.
    expect(generation.currentReader).toBeNull();
  });

  it("does not throw when nothing is active", () => {
    expect(getActiveGeneration()).toBeNull();
    expect(() => {
      interruptActiveGeneration();
    }).not.toThrow();
    expect(useChatStore.getState().streamPhase).toBe("idle");
  });

  it("marks the LATEST streaming message when several messages exist", () => {
    // An older complete assistant message + a newer streaming one.
    const olderId = useChatStore.getState().addMessage({
      role: "assistant",
      content: "done earlier",
    });
    useChatStore.getState().updateMessage(olderId, { status: "complete" });
    const streamingId = seedStreamingMessage("streaming now");

    const generation = makeGeneration();
    setActiveGeneration(generation);

    interruptActiveGeneration();

    const older = useChatStore.getState().messages.find((m) => m.id === olderId)!;
    const streaming = useChatStore
      .getState()
      .messages.find((m) => m.id === streamingId)!;
    // Only the streaming message is marked interrupted.
    expect(older.streamInterrupted).toBeUndefined();
    expect(streaming.status).toBe("complete");
    expect(streaming.streamInterrupted).toBe(true);
  });
});
