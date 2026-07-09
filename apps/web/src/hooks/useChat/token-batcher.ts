// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Token batcher — turns bursty local-model output (tok/s swings between ~5 and
 * ~40) into smooth, metered typing without ever delaying the first paint and
 * without lagging behind the model.
 *
 * #4 Phase 3 Task 2 extracted this primitive verbatim from `useChat.ts`; #4
 * Phase 6 Task A replaced its "flush the whole buffer once per animation frame"
 * behavior with a metered char-level drain (the `smoothStream` technique,
 * hand-rolled — we do NOT pull in the `ai` package). The drain maintains a
 * pending-char backlog and, on each `requestAnimationFrame` tick, releases only
 * a time-metered slice toward a comfortable visual rate, self-rescheduling
 * while a backlog remains so it keeps draining between token arrivals.
 *
 * Invariants preserved exactly (the store rejects stale/duplicate frames by
 * `(genId, seq)` in `chatStore.appendToMessage`):
 *   • each release is ONE `append(msgId, slice, genId, seq)` call with the next
 *     monotonic seq — splitting a buffer into N metered slices yields N strictly
 *     increasing seqs;
 *   • `genId` tagging is carried on every release;
 *   • `flushSync()` releases the ENTIRE remaining backlog in one synchronous
 *     call (done / user-stop / abort rely on no trailing backlog surviving);
 *   • the RAF-absent path (SSR / jsdom) buffers until `flushSync()`, as before.
 *
 * Two carve-outs keep the smoothing honest:
 *   1. Immediate first paint — the first emission for a freshly-started msgId is
 *      written synchronously and in full, so TTFT / first-token latency is
 *      unchanged (in fact slightly better than the old RAF-queued first token).
 *   2. `prefers-reduced-motion: reduce` ⇒ metering is bypassed entirely and the
 *      original whole-buffer-per-frame behavior is restored. The media-query
 *      read goes through an injectable seam for unit testing.
 */

/**
 * Target visual typing rate, in characters per second.
 *
 * 200 cps sits just above the top of sustained local-model output (the fastest
 * models emit ~40 tok/s × ~3–4 chars/token ≈ 120–160 cps), so on average we
 * keep pace with the model while smoothing its bursts; yet it's slow enough to
 * read as deliberate "typing" rather than a chunk-dump. At ~60fps that's ~3
 * chars per frame — fine-grained enough to feel continuous.
 */
export const VISUAL_CHARS_PER_SECOND = 200;

/**
 * Maximum pending-char backlog the metered drain tolerates before it catches
 * up. If the backlog exceeds this, a tick releases enough to bring the
 * remainder back to the cap, bounding the extra latency smoothing can add to
 * `MAX_BACKLOG_CHARS / VISUAL_CHARS_PER_SECOND` ≈ 0.6s of buffered text. The
 * user therefore never waits meaningfully longer than the ungated path.
 */
export const MAX_BACKLOG_CHARS = 120;

/** One frame's worth of time at 60fps, in seconds — the dt used for the first
 * tick of a fresh drain cycle (when there is no prior timestamp to diff). */
const FALLBACK_FRAME_SECONDS = 1 / 60;

export type TokenBatcher = {
  append(id: string, token: string): void;
  flushSync(): void;
  /** Set the generation id for subsequent token batches. */
  setGenerationId(id: string): void;
  /** Reset the monotonic sequence counter (call at the start of each generation). */
  resetSeq(): void;
};

/**
 * SSR/jsdom-safe default probe for `prefers-reduced-motion: reduce`. Returns
 * `false` (metered behavior) when `window.matchMedia` is unavailable.
 */
function defaultPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @internal Exported for unit testing.
 *
 * @param append - writes a released slice through to the store
 *   (`chatStore.appendToMessage`).
 * @param prefersReducedMotion - injectable seam; defaults to a guarded
 *   `matchMedia('(prefers-reduced-motion: reduce)')` read. Evaluated lazily on
 *   each scheduling decision so a runtime preference change is respected.
 */
export function createTokenBatcher(
  append: (
    id: string,
    token: string,
    generationId?: string,
    toSeq?: number,
    tokenDelta?: number,
  ) => void,
  prefersReducedMotion: () => boolean = defaultPrefersReducedMotion,
): TokenBatcher {
  /** Undrained characters waiting to be released. */
  let pending = "";
  let msgId = "";
  let genId: string | undefined;
  let rafId: number | null = null;
  let seqCounter = 0;
  /** Whether the current msgId has had its immediate first paint. */
  let firstPaintDone = false;
  /** Timestamp of the previous metered tick; null at the start of a drain cycle. */
  let lastTickTime: number | null = null;
  /**
   * True stream tokens appended since the last emit. The metered drain splits a
   * token's chars across multiple frames, so `tokenCount` must NOT track frames
   * (= append calls); instead each emit carries the tokens that arrived since
   * the previous emit, and the store sums them. A pure-drain frame carries 0.
   * The sum of all deltas over a stream equals the true token count exactly.
   */
  let tokensSinceEmit = 0;

  /** Emit a slice as one store append with the next monotonic seq, carrying the
   * tokens accumulated since the last emit. No-op if empty or no msgId yet.
   * This is the SOLE place seq increments and the token-delta is flushed. */
  function emit(slice: string): void {
    if (!slice || !msgId) return;
    seqCounter++;
    const tokenDelta = tokensSinceEmit;
    tokensSinceEmit = 0;
    append(msgId, slice, genId, seqCounter, tokenDelta);
  }

  /** Schedule a single frame from an idle state (rafId must be null). Resets
   * the drain clock so the first tick of this cycle uses a one-frame dt rather
   * than diffing against a possibly-stale timestamp from before an idle gap. */
  function scheduleFromIdle(): void {
    if (rafId !== null) return;
    if (typeof requestAnimationFrame !== "function") return; // SSR/jsdom: wait for flushSync
    lastTickTime = null;
    rafId = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    rafId = null;

    // Reduced motion: bypass metering — release the whole pending buffer in one
    // frame, exactly like the original batcher. No self-reschedule (a fresh
    // append schedules the next frame).
    if (prefersReducedMotion()) {
      const whole = pending;
      pending = "";
      emit(whole);
      lastTickTime = null;
      return;
    }

    const dtSeconds =
      lastTickTime === null ? FALLBACK_FRAME_SECONDS : Math.max(0, now - lastTickTime) / 1000;
    lastTickTime = now;

    // Base metered slice toward the target rate. Floor at 1 char so a tiny dt
    // can never stall the drain at zero progress. `release` is always an integer
    // (Math.round of a number; `.length` below is integer), so `slice(0, release)`
    // is exact — a future fractional rate term would need its own rounding.
    let release = Math.max(1, Math.round(VISUAL_CHARS_PER_SECOND * dtSeconds));

    // Catch-up bound: if the backlog overflows the cap, release enough to bring
    // the remainder back within the cap so smoothing never lags the model.
    if (pending.length - release > MAX_BACKLOG_CHARS) {
      release = pending.length - MAX_BACKLOG_CHARS;
    }

    if (release >= pending.length) {
      const whole = pending;
      pending = "";
      emit(whole);
    } else {
      emit(pending.slice(0, release));
      pending = pending.slice(release);
    }

    // Keep draining while a backlog remains, even with no new append. This
    // re-schedule is INTENTIONALLY inline rather than calling scheduleFromIdle():
    // scheduleFromIdle() nulls `lastTickTime` (correct for starting a fresh drain
    // cycle after an idle gap), but a self-reschedule is a continuation of the
    // SAME cycle and must preserve `lastTickTime` so the next tick's dt is the
    // real inter-frame delta. Do not "DRY" these into one helper.
    if (pending.length > 0 && typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(tick);
    }
  }

  return {
    append(id: string, token: string) {
      // A new message resets per-message drain state.
      if (id !== msgId) {
        msgId = id;
        firstPaintDone = false;
        pending = "";
        lastTickTime = null;
        tokensSinceEmit = 0;
      }
      pending += token;
      // One public append() == one stream token (run-generation.ts calls this
      // once per worker token). Count it so the next emit can pass the delta.
      tokensSinceEmit++;

      // Reduced motion: never paint synchronously — queue a frame that flushes
      // the whole buffer (original behavior).
      if (prefersReducedMotion()) {
        scheduleFromIdle();
        return;
      }

      // Immediate first paint: the first emission for a fresh msgId flushes
      // whole and unmetered so TTFT is untouched.
      if (!firstPaintDone) {
        firstPaintDone = true;
        const whole = pending;
        pending = "";
        emit(whole);
        return;
      }

      scheduleFromIdle();
    },
    flushSync() {
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      rafId = null;
      lastTickTime = null;
      // Mark first paint done so a flushSync that delivers the very first chunk
      // (e.g. a generation that finishes before any frame) doesn't double-count.
      firstPaintDone = true;
      const whole = pending;
      pending = "";
      emit(whole);
    },
    setGenerationId(id: string) {
      genId = id;
    },
    resetSeq() {
      seqCounter = 0;
    },
  };
}
