// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * `runGeneration` — the single iterate → batch → flush loop shared by every
 * on-device stream in `useChat`.
 *
 * #4 Phase 3 Task 2. Before this, `streamResponse` carried three near-identical
 * loops (primary, hard-constraint repair, and offline continue-interrupted),
 * each with its own abort/seq handling. They are now one primitive.
 *
 * The primitive owns the loop and the stream registration; it returns a
 * STRUCTURED result (final text + status + the terminating `done` event + the
 * caught error) rather than mutating the store with completion semantics.
 * Callers keep their store writes (complete/usage/receipt/error mapping) —
 * `runGeneration` just hands back what happened.
 *
 * R4b: the stream is an `AsyncIterable<TokenEvent>` from
 * `local-ai/runtime/stream`, not a `ReadableStream<string>`. Usage arrives on
 * the terminating `done` event and is returned to the caller, replacing the
 * module-level usage side channel. Abort stays entirely on the main thread
 * (`TokenStream.cancel()` → the stream's own AbortController); no
 * `AbortSignal` is ever passed across a Worker boundary.
 */

import type { Generation } from "./generation";
import type { StreamPhase } from "../../stores/chatStore";
import { LocalInferenceStreamError } from "../../local-ai/runtime/errors";
import type { DoneEvent, TokenStream } from "../../local-ai/runtime/stream";
import type { TokenEvent } from "../../local-ai/runtime/types";

/**
 * Time-to-first-token deadline. A generation that streams no first token within
 * this window is treated as wedged rather than left to hang unbounded. Only the
 * FIRST token is bounded; once a model is producing tokens the read loop is
 * unbounded again.
 */
const TTFT_DEADLINE_MS = 90_000;

/**
 * Outcome of draining one stream into an assistant message.
 *
 * `finalText` is the assistant message's content as it stands in the store
 * after the loop's terminal `flushSync()` — i.e. what the caller would read
 * back to decide on a repair or completion.
 */
export type RunGenerationResult =
  | { status: "completed"; finalText: string; done: DoneEvent | null }
  | { status: "aborted"; finalText: string; done: DoneEvent | null }
  | { status: "error"; finalText: string; error: unknown; done: DoneEvent | null };

export type RunGenerationParams = {
  /** The generation that owns the abort controller + batcher + reader slot. */
  generation: Generation;
  /** The stream to drain. */
  stream: TokenStream;
  /** Assistant message id the tokens accumulate into. */
  assistantId: string;
  /** Flip the stream phase to "generating" on the first token of this stream. */
  setStreamPhase: (phase: StreamPhase) => void;
  /** Read the current stream phase (so we only flip it once). */
  getStreamPhase: () => StreamPhase;
  /** Read the assistant message's current content for the structured result. */
  getMessageContent: (assistantId: string) => string;
  /**
   * Time-to-first-token deadline in ms. Defaults to {@link TTFT_DEADLINE_MS};
   * overridable so tests can drive the watchdog without waiting real seconds.
   */
  ttftDeadlineMs?: number;
};

/**
 * Await the next event, but bound the wait for the FIRST token by `deadlineMs`.
 *
 * The deadline must WIN the race, not merely signal — a bare `setTimeout →
 * cancel()` can silently never take effect if the underlying iterator never
 * settles against a non-cooperating runtime. So on expiry we BOTH cancel the
 * stream — releasing the runtime cooperatively (`TokenStream.cancel()` → adapter
 * abort → WebLLM `interruptGenerate`), never abandoning it — AND reject, so the
 * loop unwinds even if the vendor stream never responds.
 */
async function readFirstEventWithDeadline(
  iterator: AsyncIterator<TokenEvent>,
  stream: TokenStream,
  deadlineMs: number,
): Promise<IteratorResult<TokenEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject FIRST so the race settles as a timeout, THEN cancel the stream to
      // release the runtime. Cancelling first would resolve the pending next()
      // as `done` and win the race, silently masking the timeout as a clean end.
      reject(
        new LocalInferenceStreamError(
          "TIMEOUT",
          `No first token within ${deadlineMs}ms — treating the generation as timed out.`,
          true,
        ),
      );
      stream.cancel();
    }, deadlineMs);
  });
  try {
    return await Promise.race([iterator.next(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Drain `stream` into the assistant message through the generation's batcher.
 *
 * On the first token, flips the stream phase to "generating" (idempotent — the
 * store only re-renders if the phase actually changes, so callers that already
 * set the phase pay nothing). Always `flushSync()`es at the end so the final
 * content is deterministic regardless of whether the rAF batch path ran.
 */
export async function runGeneration(
  params: RunGenerationParams,
): Promise<RunGenerationResult> {
  const {
    generation,
    stream,
    assistantId,
    setStreamPhase,
    getStreamPhase,
    getMessageContent,
  } = params;
  const ttftDeadlineMs = params.ttftDeadlineMs ?? TTFT_DEADLINE_MS;

  const iterator = stream[Symbol.asyncIterator]();
  generation.currentStream = stream;
  let sawFirstToken = false;
  let done: DoneEvent | null = null;

  try {
    while (true) {
      // Only the wait for the first token is bounded — once tokens flow the read
      // is unbounded again (a slow tail is not a wedge).
      const step = sawFirstToken
        ? await iterator.next()
        : await readFirstEventWithDeadline(iterator, stream, ttftDeadlineMs);
      if (step.done) break;
      const event = step.value;
      if (event.kind === "done") {
        // Usage + tokenizer name for the caller's completion write and receipt.
        done = event;
        continue;
      }
      // `error` events never reach here: `stream()` throws the translated
      // LocalInferenceStreamError instead, so the taxonomy lives in one place.
      if (event.kind !== "token") continue;
      sawFirstToken = true;
      // Transition to generating on the first token (no-op if already there).
      if (getStreamPhase() !== "generating") {
        setStreamPhase("generating");
      }
      generation.batcher.append(assistantId, event.text);
    }
    generation.batcher.flushSync();
    return { status: "completed", finalText: getMessageContent(assistantId), done };
  } catch (error) {
    generation.batcher.flushSync();
    // The abort signal distinguishes a user-stop / load-time abort (the message
    // is already finalized by interruptActiveGeneration) from a genuine runtime
    // failure that the caller must surface via applyLocalGenerationError.
    if (generation.abortController.signal.aborted) {
      return { status: "aborted", finalText: getMessageContent(assistantId), done };
    }
    return { status: "error", finalText: getMessageContent(assistantId), error, done };
  } finally {
    // Release this generation's stream slot if it still points at our stream.
    if (generation.currentStream === stream) {
      generation.currentStream = null;
    }
  }
}
