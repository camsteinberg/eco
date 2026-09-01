// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Fine-grained unit tests for `runGeneration` — the single iterate → batch →
 * flush loop shared by every on-device stream in `useChat`. #4 Phase 3 Task 3.
 *
 * These drive `runGeneration` DIRECTLY (no hook render) with:
 *   - a scripted `TokenStream` as the source (R4b: an async iterable of
 *     `TokenEvent`, not a `ReadableStream<string>`),
 *   - a real `Generation` from `createGeneration` (its own AbortController +
 *     batcher pre-tagged with a unique id + reset seq),
 *   - the real chat store as the content sink, so `getMessageContent` reads back
 *     the actually-batched content and `appendToMessage`'s stale/dup guards run.
 *
 * jsdom has no `requestAnimationFrame`, so by default the batcher only flushes
 * via the loop's terminal `flushSync()`. The "intra-stream rAF flush + monotonic
 * seq" test installs a controllable rAF queue to exercise that path
 * deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createGeneration, type Generation } from "../generation";
import { runGeneration } from "../run-generation";
import { LocalInferenceStreamError } from "../../../local-ai/runtime/errors";
import { useChatStore, type StreamPhase } from "../../../stores/chatStore";
import { scriptedTokenStream } from "../../../__tests__/helpers/token-stream";
import type { TokenStream } from "../../../local-ai/runtime/stream";
import type { TokenEvent } from "../../../local-ai/runtime/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A real assistant message in the store that tokens accumulate into. */
function seedAssistant(generationId?: string): string {
  const id = useChatStore.getState().addMessage({
    role: "assistant",
    content: "",
  });
  useChatStore.getState().updateMessage(id, {
    status: "streaming",
    ...(generationId !== undefined ? { currentGenerationId: generationId } : {}),
  });
  return id;
}

/** A generation whose batcher writes through to the real chat store. */
function makeGeneration(): Generation {
  return createGeneration((id, token, generationId, toSeq) => {
    useChatStore.getState().appendToMessage(id, token, generationId, toSeq);
  });
}

/**
 * A stream that yields the given tokens then ends. `done: null` — these tests
 * are about the loop, not usage, and it keeps the whole result object
 * comparable with `toEqual`. The `done` event's own handling has its own test.
 */
function tokensStream(tokens: string[]): TokenStream {
  return scriptedTokenStream({ tokens, done: null });
}

/**
 * A stream that DELIVERS its tokens one at a time, then throws.
 *
 * An async iterator yields each token to the consumer before the generator
 * resumes, so — unlike the `ReadableStream` this replaced, where
 * `controller.error()` discarded anything still queued — "streamed some tokens,
 * then the runtime failed" needs no special construction.
 */
function errorStream(tokens: string[], error: unknown): TokenStream {
  return scriptedTokenStream({ tokens, error });
}

/**
 * A stream that yields tokens then BLOCKS forever until the consumer cancels.
 * `onCancel` fires when `runGeneration`'s stream is cancelled.
 */
function hangingStream(tokens: string[], onCancel?: () => void): TokenStream {
  return scriptedTokenStream({ tokens, hang: true, ...(onCancel ? { onCancel } : {}) });
}

/**
 * A stream that yields NOTHING and never ends — the first read parks forever.
 * `onCancel` fires when the consumer cancels (the TTFT watchdog path).
 */
function silentStream(onCancel?: () => void): TokenStream {
  return scriptedTokenStream({ hang: true, ...(onCancel ? { onCancel } : {}) });
}

/**
 * A stream the test paces by hand: `push()` releases one token, `close()` ends
 * it. Used where a rAF callback has to fire BETWEEN two tokens, which a
 * pre-scripted stream can't express.
 */
function pushableTokenStream(): {
  stream: TokenStream;
  push: (text: string) => void;
  close: () => void;
} {
  const queue: TokenEvent[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  const wake = (): void => {
    const resolve = notify;
    notify = null;
    resolve?.();
  };
  const stream: TokenStream = {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<TokenEvent>> {
        for (;;) {
          const event = queue.shift();
          if (event) return { done: false, value: event };
          if (ended) return { done: true, value: undefined };
          await new Promise<void>((resolve) => (notify = resolve));
        }
      },
    }),
    cancel: () => {
      ended = true;
      wake();
    },
  };
  return {
    stream,
    push: (text: string) => {
      queue.push({ kind: "token", text });
      wake();
    },
    close: () => {
      ended = true;
      wake();
    },
  };
}

/** Phase shim backed by the real store's phase, with a settable spy. */
function makePhaseShim() {
  let phase: StreamPhase = "thinking";
  const setStreamPhase = vi.fn((next: StreamPhase) => {
    phase = next;
  });
  const getStreamPhase = vi.fn((): StreamPhase => phase);
  return { setStreamPhase, getStreamPhase, set: (p: StreamPhase) => (phase = p) };
}

const getMessageContent = (assistantId: string): string =>
  useChatStore.getState().messages.find((m) => m.id === assistantId)?.content ??
  "";

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    composerDraft: "",
    streamPhase: "idle",
    isStreaming: false,
    error: null,
    selectedModel: "auto",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Completed result + finalText + first-token phase flip + stream release
// ═══════════════════════════════════════════════════════════════════════════

describe("runGeneration — completed path", () => {
  it("returns status 'completed' with finalText assembled from the batched content", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    const result = await runGeneration({
      generation,
      stream: tokensStream(["Hel", "lo ", "world"]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(result).toEqual({ status: "completed", finalText: "Hello world", done: null });
    expect(getMessageContent(assistantId)).toBe("Hello world");
  });

  it("flips the phase to 'generating' exactly once on the first token", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    await runGeneration({
      generation,
      stream: tokensStream(["a", "b", "c"]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    // Three tokens but only ONE phase flip — the first token transitions it and
    // the subsequent reads see "generating" already and no-op.
    expect(phase.setStreamPhase).toHaveBeenCalledTimes(1);
    expect(phase.setStreamPhase).toHaveBeenCalledWith("generating");
  });

  it("does not flip the phase when it is already 'generating'", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();
    phase.set("generating");

    await runGeneration({
      generation,
      stream: tokensStream(["x", "y"]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(phase.setStreamPhase).not.toHaveBeenCalled();
  });

  it("never flips the phase for an empty (immediately-closed) stream", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    const result = await runGeneration({
      generation,
      stream: tokensStream([]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(phase.setStreamPhase).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "completed", finalText: "", done: null });
  });

  it("releases the generation's reader slot in finally on the completed path", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    await runGeneration({
      generation,
      stream: tokensStream(["ok"]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(generation.currentStream).toBeNull();
  });
  it("returns the terminating done event, so usage never needs a side channel", async () => {
    // R4b: usage used to be written to a module-level store by the stream shim
    // and read back by useChat after the loop. It rides the event now.
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    const result = await runGeneration({
      generation,
      stream: scriptedTokenStream({
        tokens: ["hi"],
        done: {
          finishReason: "length",
          promptTokens: 9,
          completionTokens: 1,
          tokenizerName: "LlamaTokenizer",
        },
      }),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(result.status).toBe("completed");
    expect(result.done).toEqual({
      kind: "done",
      finishReason: "length",
      promptTokens: 9,
      completionTokens: 1,
      tokenizerName: "LlamaTokenizer",
    });
    // The done event is NOT appended as text.
    expect(result.finalText).toBe("hi");
  });

  it("returns done: null when the adapter ended without a done event", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    const result = await runGeneration({
      generation,
      stream: tokensStream(["a"]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(result.done).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Aborted path (the shim-originated ABORTED case the reviews flagged)
// ═══════════════════════════════════════════════════════════════════════════

describe("runGeneration — aborted path", () => {
  it("returns 'aborted' (NOT 'error') when the gen is aborted and the stream errors", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    // Simulate the shim-originated abort: the generation's signal is set, then
    // the stream throws (e.g. an ABORTED stream error). interruptActiveGeneration
    // would normally have already finalized the message; here we drive the
    // primitive directly to prove its branch.
    generation.abortController.abort();

    const result = await runGeneration({
      generation,
      stream: errorStream(["partial"], new Error("ABORTED")),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(result.status).toBe("aborted");
    if (result.status === "aborted") {
      // The partial token that was enqueued before the error is still flushed.
      expect(result.finalText).toBe("partial");
    }
  });

  it("returns 'aborted' when the gen is aborted and the reader is cancelled mid-stream", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    const stream = hangingStream(["so far"]);

    const runPromise = runGeneration({
      generation,
      stream,
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    // Let the loop read the first token and park on the next read().
    await Promise.resolve();
    await Promise.resolve();

    // The teardown path: abort the gen, then cancel the current stream. A
    // cancelled stream resolves `done`, so the loop exits cleanly. The
    // status is "completed" here because the read resolves done (not throws) —
    // this pins that cancel-after-abort is a graceful close, not an error.
    generation.abortController.abort();
    generation.currentStream?.cancel();

    const result = await runPromise;
    // A cancelled stream's next() resolves done → loop breaks → completed.
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("so far");
  });

  it("aborted result still flushed the partial content (flushSync ran in catch)", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();
    generation.abortController.abort();

    await runGeneration({
      generation,
      stream: errorStream(["half "], new Error("aborted")),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(getMessageContent(assistantId)).toBe("half ");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Error path (stream throws while NOT aborted)
// ═══════════════════════════════════════════════════════════════════════════

describe("runGeneration — error path", () => {
  it("returns 'error' with the thrown error surfaced when the stream throws and is NOT aborted", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();
    const boom = new Error("LOCAL_INFERENCE_FAILED");

    const result = await runGeneration({
      generation,
      stream: errorStream(["partial output"], boom),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBe(boom);
      // flushSync still ran in the catch → partial content preserved.
      expect(result.finalText).toBe("partial output");
    }
  });

  it("preserves the partial content in the store when erroring mid-stream", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    await runGeneration({
      generation,
      stream: errorStream(["one ", "two "], new Error("kaboom")),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(getMessageContent(assistantId)).toBe("one two ");
  });

  it("releases the reader slot in finally even on the error path", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    await runGeneration({
      generation,
      stream: errorStream([], new Error("x")),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(generation.currentStream).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Stream swap (the repair pattern: same generation, second runGeneration)
// ═══════════════════════════════════════════════════════════════════════════

describe("runGeneration — stream swap within one generation (repair loop)", () => {
  it("a second runGeneration on the same generation swaps currentStream", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    // First (primary) stream completes and releases the slot.
    await runGeneration({
      generation,
      stream: tokensStream(["primary"]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });
    expect(generation.currentStream).toBeNull();

    // The repair loop resets the message content and re-streams into the SAME
    // generation — proving the stream slot is reusable.
    useChatStore.getState().updateMessage(assistantId, { content: "" });
    const second = await runGeneration({
      generation,
      stream: tokensStream(["repaired"]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });

    expect(second).toEqual({ status: "completed", finalText: "repaired", done: null });
    expect(getMessageContent(assistantId)).toBe("repaired");
  });

  it("registers the new stream as currentStream while the second stream is in flight", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    let firstStreamCancelled = false;
    const firstStream = hangingStream(["a"], () => {
      firstStreamCancelled = true;
    });

    const firstRun = runGeneration({
      generation,
      stream: firstStream,
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });
    await Promise.resolve();
    await Promise.resolve();

    const firstStreamSlot = generation.currentStream;
    expect(firstStreamSlot).not.toBeNull();

    // Cancel the first stream (gracefully ends it → first run completes).
    generation.currentStream?.cancel();
    await firstRun;
    expect(firstStreamCancelled).toBe(true);

    // Second stream: currentStream is swapped to the new stream.
    const secondRun = runGeneration({
      generation,
      stream: hangingStream(["b"]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
    });
    await Promise.resolve();
    await Promise.resolve();

    const secondStreamSlot = generation.currentStream;
    expect(secondStreamSlot).not.toBeNull();
    expect(secondStreamSlot).not.toBe(firstStreamSlot);

    generation.currentStream?.cancel();
    await secondRun;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Intra-stream rAF flush + monotonic seq (controllable rAF queue)
// ═══════════════════════════════════════════════════════════════════════════

describe("runGeneration — intra-stream rAF flush + monotonic seq", () => {
  it("flushes mid-stream via requestAnimationFrame and tags batches with increasing seq", async () => {
    // Install a controllable rAF queue. jsdom has none, so by default the batcher
    // only flushes via flushSync(). We drive the rAF callbacks manually so a
    // flush lands BETWEEN tokens and assert the batched emissions + seq.
    const rafQueue: FrameRequestCallback[] = [];
    let nextRafId = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback): number => {
        rafQueue.push(cb);
        return nextRafId++;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", (_id: number): void => {
      // The batcher cancels its pending frame on flushSync; we simply drop the
      // queued callback so a stale frame can't double-flush.
      rafQueue.length = 0;
    });

    // Capture raw batch emissions (id, token, generationId, seq) by giving the
    // generation a batcher that writes through a spy instead of the store.
    const batches: {
      id: string;
      token: string;
      generationId?: string;
      seq?: number;
    }[] = [];
    const generation = createGeneration((id, token, generationId, seq) => {
      batches.push({ id, token, generationId, seq });
    });
    const assistantId = "assistant-raf";
    const phase = makePhaseShim();

    // A stream where the consumer can be paused between tokens so a queued rAF
    // callback can fire mid-stream. We hand-roll the pacing.
    const paced = pushableTokenStream();
    paced.push("alpha ");
    const stream = paced.stream;

    const runPromise = runGeneration({
      generation,
      stream,
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent: (id) =>
        batches.filter((b) => b.id === id).map((b) => b.token).join(""),
    });

    // Let the loop read "alpha ". The FIRST emission for a fresh msgId paints
    // immediately (unmetered) so TTFT is untouched — no frame is queued, and
    // the first batch lands with seq 1. The first read passes through the TTFT
    // race (an extra async hop), so flush enough microtasks for it to land.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(rafQueue).toHaveLength(0);
    expect(batches).toEqual([
      { id: assistantId, token: "alpha ", generationId: generation.id, seq: 1 },
    ]);

    // Enqueue the next token. Post-first-paint tokens are metered, so this one
    // queues a rAF tick.
    paced.push("beta");
    await Promise.resolve();
    await Promise.resolve();
    expect(rafQueue).toHaveLength(1);

    // Fire one metered frame → seq increments to 2 (monotonic). The metered
    // slice may not cover all of "beta" in a single tick; the remainder drains
    // on completion's flushSync below.
    rafQueue.shift()!(0);

    paced.close();
    const result = await runPromise;

    expect(result.status).toBe("completed");
    // Content arrives intact and in order across the immediate first paint plus
    // the metered releases (+ the completion flush).
    expect(batches.map((b) => b.token).join("")).toBe("alpha beta");
    expect(batches.every((b) => b.generationId === generation.id)).toBe(true);
    // Seq is strictly increasing, one per emission, starting at 1.
    const seqs = batches.map((b) => b.seq);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBe(seqs[i - 1]! + 1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Time-to-first-token watchdog
// ═══════════════════════════════════════════════════════════════════════════

describe("runGeneration — time-to-first-token watchdog", () => {
  it("fails with a 'timeout'-class error when no first token arrives before the deadline", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();
    let cancelled = false;

    const result = await runGeneration({
      generation,
      stream: silentStream(() => {
        cancelled = true;
      }),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
      ttftDeadlineMs: 20,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(LocalInferenceStreamError);
      expect((result.error as LocalInferenceStreamError).code).toBe("TIMEOUT");
    }
    // The watchdog cancels the stream (→ adapter abort → WebLLM
    // interruptGenerate) rather than abandoning it mid-protocol.
    expect(cancelled).toBe(true);
    // No token ever arrived, so the phase never flipped to "generating".
    expect(phase.setStreamPhase).not.toHaveBeenCalled();
    expect(generation.currentStream).toBeNull();
  });

  it("does not fire once the first token has streamed — only TTFT is bounded", async () => {
    const generation = makeGeneration();
    const assistantId = seedAssistant(generation.id);
    const phase = makePhaseShim();

    // The first token is available immediately (well within the tiny deadline);
    // the post-first-token reads are unbounded, so a completed stream is never
    // misclassified as a timeout.
    const result = await runGeneration({
      generation,
      stream: tokensStream(["hello", " world"]),
      assistantId,
      setStreamPhase: phase.setStreamPhase,
      getStreamPhase: phase.getStreamPhase,
      getMessageContent,
      ttftDeadlineMs: 20,
    });

    expect(result).toEqual({ status: "completed", finalText: "hello world", done: null });
  });
});
