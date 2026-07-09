// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Concurrency / abort proofs for the per-generation pipeline. #4 Phase 3 Task 3.
 *
 * The WHOLE POINT of the per-generation-object refactor was to fix a concurrency
 * race: the old module-scoped `activeAbortRef` / `activeReaderRef` /
 * `activeGenerationRef` let a NEWER generation clobber an OLDER one's
 * abort/reader/seq state (and vice-versa). These tests prove the fix holds:
 *
 *   1. Two overlapping generations don't clobber — A's teardown can't cancel B's
 *      reader, abort B's signal, or null B's active pointer (and vice-versa).
 *   2. Rapid stop→resend — interrupting gen A leaves a freshly-created gen B
 *      completely unaffected (not aborted, reader live).
 *   3. Stale-token rejection across generations — tokens tagged with gen A's id
 *      are dropped once the message's currentGenerationId is gen B's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  createGeneration,
  setActiveGeneration,
  getActiveGeneration,
  clearActiveGeneration,
  interruptActiveGeneration,
  isActiveGenerationAborted,
  setActiveGenerationForTesting,
  type Generation,
} from "../generation";
import { runGeneration } from "../run-generation";
import { useChatStore, type StreamPhase } from "../../../stores/chatStore";
import { useConversationStore } from "../../../stores/conversationStore";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGeneration(): Generation {
  return createGeneration((id, token, generationId, toSeq) => {
    useChatStore.getState().appendToMessage(id, token, generationId, toSeq);
  });
}

/** A reader that records whether it was cancelled, attached to a hanging stream. */
function attachLiveReader(generation: Generation): { cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue("token");
    },
    cancel() {
      cancelled = true;
    },
  });
  generation.currentReader = stream.getReader();
  return { cancelled: () => cancelled };
}

function makePhaseShim() {
  let phase: StreamPhase = "thinking";
  return {
    setStreamPhase: vi.fn((p: StreamPhase) => {
      phase = p;
    }),
    getStreamPhase: vi.fn((): StreamPhase => phase),
  };
}

const getMessageContent = (assistantId: string): string =>
  useChatStore.getState().messages.find((m) => m.id === assistantId)?.content ??
  "";

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
// 1. Two overlapping generations don't clobber — THE anti-clobber proof
// ═══════════════════════════════════════════════════════════════════════════

describe("two overlapping generations do not clobber each other", () => {
  it("A's teardown cannot cancel B's reader, abort B's signal, or null B's pointer", async () => {
    const genA = makeGeneration();
    const genB = makeGeneration();

    // Both generations hold a live reader.
    const aReader = attachLiveReader(genA);
    const bReader = attachLiveReader(genB);

    // A starts active; then B takes over while A is still 'in flight'.
    setActiveGeneration(genA);
    setActiveGeneration(genB);
    expect(getActiveGeneration()).toBe(genB);

    // === A tears itself down. With the OLD module-scoped refs this would have
    // cancelled B's reader / aborted B's controller / nulled the active pointer.
    // With the per-generation object it can only touch its OWN state. ===
    genA.abortController.abort();
    await genA.currentReader?.cancel();
    clearActiveGeneration(genA);

    // --- Key assertions: B is completely intact. ---
    expect(getActiveGeneration()).toBe(genB); // pointer still B
    expect(genB.abortController.signal.aborted).toBe(false); // B not aborted
    expect(bReader.cancelled()).toBe(false); // B's reader live
    expect(isActiveGenerationAborted()).toBe(false); // active (B) not aborted

    // A's own state DID tear down (proving the teardown ran, just scoped to A).
    expect(genA.abortController.signal.aborted).toBe(true);
    expect(aReader.cancelled()).toBe(true);
  });

  it("symmetric: B tearing down cannot touch an earlier-active A", async () => {
    const genA = makeGeneration();
    const genB = makeGeneration();
    const aReader = attachLiveReader(genA);
    const bReader = attachLiveReader(genB);

    // Pretend A is the active one (the older, still-active generation).
    setActiveGeneration(genA);

    // B tears down on its own (e.g. it errored or was abandoned).
    genB.abortController.abort();
    await genB.currentReader?.cancel();
    clearActiveGeneration(genB); // identity guard: must NOT null A's pointer

    expect(getActiveGeneration()).toBe(genA);
    expect(genA.abortController.signal.aborted).toBe(false);
    expect(aReader.cancelled()).toBe(false);
    expect(bReader.cancelled()).toBe(true);
  });

  it("interruptActiveGeneration only aborts the ACTIVE generation, never the other", () => {
    const genA = makeGeneration();
    const genB = makeGeneration();

    setActiveGeneration(genA);
    setActiveGeneration(genB); // B is active

    // Seed a streaming message so the interrupt has something to mark.
    const id = useChatStore.getState().addMessage({
      role: "assistant",
      content: "streaming",
    });
    useChatStore.getState().updateMessage(id, { status: "streaming" });

    interruptActiveGeneration();

    // The active gen (B) was aborted; the inactive gen (A) was NOT.
    expect(genB.abortController.signal.aborted).toBe(true);
    expect(genA.abortController.signal.aborted).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Rapid stop → resend — interrupting A leaves a fresh B untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("rapid stop -> resend", () => {
  it("interrupting gen A then immediately creating + activating gen B leaves B unaffected", () => {
    // Gen A is mid-stream.
    const genA = makeGeneration();
    const aReader = attachLiveReader(genA);
    setActiveGeneration(genA);

    const aMsgId = useChatStore.getState().addMessage({
      role: "assistant",
      content: "A so far",
    });
    useChatStore.getState().updateMessage(aMsgId, {
      status: "streaming",
      currentGenerationId: genA.id,
    });

    // STOP: interrupt A.
    interruptActiveGeneration();
    expect(genA.abortController.signal.aborted).toBe(true);
    expect(getActiveGeneration()).toBeNull();

    // RESEND: immediately create + activate gen B for a new message.
    const genB = makeGeneration();
    const bReader = attachLiveReader(genB);
    setActiveGeneration(genB);

    // B is the fresh generation — A's interrupt did not touch it.
    expect(genB.abortController.signal.aborted).toBe(false);
    expect(isActiveGenerationAborted()).toBe(false);
    expect(bReader.cancelled()).toBe(false);
    expect(getActiveGeneration()).toBe(genB);

    // A's interrupt cancelled A's reader (its own state), not B's.
    expect(aReader.cancelled()).toBe(true);
    void aReader; // keep referenced
  });

  it("a late clearActiveGeneration(A) after B is active does not strand B", () => {
    const genA = makeGeneration();
    setActiveGeneration(genA);
    interruptActiveGeneration(); // clears pointer, aborts A

    const genB = makeGeneration();
    setActiveGeneration(genB);

    // A late, out-of-order teardown of A (e.g. its loop unwinds after B started).
    clearActiveGeneration(genA);

    expect(getActiveGeneration()).toBe(genB);
    expect(genB.abortController.signal.aborted).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Stale-token rejection across generations (driven at the store level)
// ═══════════════════════════════════════════════════════════════════════════

describe("stale-token rejection across generations", () => {
  it("drops tokens tagged with gen A's id once the message's currentGenerationId is gen B's", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const genA = makeGeneration();
    const genB = makeGeneration();

    const id = useChatStore.getState().addMessage({
      role: "assistant",
      content: "",
    });
    useChatStore.getState().updateMessage(id, {
      status: "streaming",
      currentGenerationId: genA.id,
    });

    // Gen A streams a token (accepted).
    useChatStore.getState().appendToMessage(id, "from A", genA.id, 1);
    expect(getMessageContent(id)).toBe("from A");

    // The message switches to gen B (regeneration into the same message id).
    // Production resets lastSeq to 0 alongside currentGenerationId (useChat.ts
    // :792-798) because gen B's fresh batcher also restarts its seq at 1.
    useChatStore
      .getState()
      .updateMessage(id, { currentGenerationId: genB.id, lastSeq: 0 });

    // A LATE token from gen A's worker arrives — it must be DROPPED on the
    // generationId mismatch (independent of seq).
    useChatStore.getState().appendToMessage(id, " late from A", genA.id, 2);
    expect(getMessageContent(id)).toBe("from A");
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]![0]).toContain("stale generation");

    // Gen B's first token (seq 1) is accepted against the reset lastSeq.
    useChatStore.getState().appendToMessage(id, " from B", genB.id, 1);
    expect(getMessageContent(id)).toBe("from A from B");

    warnSpy.mockRestore();
  });

  it("end-to-end: two runGeneration drains into the SAME message keep B's content, drop A's late tokens", async () => {
    // A real anti-clobber scenario at the runGeneration level: gen A is stopped
    // mid-stream (its late tokens must be rejected) and gen B re-streams into the
    // same assistant message.
    const id = useChatStore.getState().addMessage({
      role: "assistant",
      content: "",
    });
    useChatStore.getState().updateMessage(id, { status: "streaming" });

    const genA = makeGeneration();
    useChatStore.getState().updateMessage(id, { currentGenerationId: genA.id });

    // Gen A: a stream we can pump and then strand.
    let aController!: ReadableStreamDefaultController<string>;
    const aStream = new ReadableStream<string>({
      start(controller) {
        aController = controller;
        controller.enqueue("A1 ");
      },
    });
    const phase = makePhaseShim();
    const aRun = runGeneration({
      generation: genA,
      stream: aStream,
      assistantId: id,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });
    setActiveGeneration(genA);
    await Promise.resolve();
    await Promise.resolve();
    genA.batcher.flushSync(); // land "A1 "
    expect(getMessageContent(id)).toBe("A1 ");

    // STOP A: abort + cancel its reader. Switch the message to gen B.
    genA.abortController.abort();
    await genA.currentReader?.cancel();
    await aRun;
    void aController; // its remaining enqueues are now irrelevant

    // Switching the message to gen B resets BOTH the message's currentGenerationId
    // and its lastSeq to 0 — the exact production pattern (useChat.ts:792-798),
    // since gen B's fresh batcher also restarts its seq at 1.
    const genB = makeGeneration();
    useChatStore
      .getState()
      .updateMessage(id, { currentGenerationId: genB.id, lastSeq: 0 });
    setActiveGeneration(genB);

    // A LATE token from gen A's batcher (worker still emitting) — must be dropped
    // because the message now belongs to gen B.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    genA.batcher.append(id, "A-LATE ");
    genA.batcher.flushSync();
    expect(getMessageContent(id)).toBe("A1 ");
    warnSpy.mockRestore();

    // Gen B streams successfully into the same message.
    const bRun = await runGeneration({
      generation: genB,
      stream: new ReadableStream<string>({
        start(controller) {
          controller.enqueue("B-ok");
          controller.close();
        },
      }),
      assistantId: id,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(bRun.status).toBe("completed");
    // The message holds A's surviving prefix + B's content, never A's late token.
    expect(getMessageContent(id)).toBe("A1 B-ok");
  });
});
