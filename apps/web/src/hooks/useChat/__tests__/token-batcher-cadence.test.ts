// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * #4 Phase 6 Task A — metered char-cadence drain.
 *
 * These tests drive `requestAnimationFrame` deterministically: the batcher's
 * RAF callback receives a `DOMHighResTimeStamp`, and the drain meters its
 * release off the delta between successive timestamps. By controlling both the
 * queue AND the timestamps we hand each callback, the metered slice is exact
 * and reproducible without a real clock.
 *
 * The contract under test (vs. the old whole-buffer-per-frame flush):
 *   1. metered release — a large backlog drips out over several ticks;
 *   2. catch-up bound — an oversized backlog is pulled back within the cap;
 *   3. immediate first paint — the first emission for a fresh msgId is not metered;
 *   4. flushSync drains the entire remaining backlog in one synchronous call;
 *   5. reduced-motion bypass — restores the old whole-buffer-per-frame behavior;
 *   6. seq monotonicity + genId tagging preserved across metered releases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  VISUAL_CHARS_PER_SECOND,
  MAX_BACKLOG_CHARS,
  createTokenBatcher,
} from "../token-batcher";

type Append = ReturnType<typeof vi.fn>;
type Batch = {
  id: string;
  token: string;
  genId?: string;
  seq?: number;
  tokenDelta?: number;
};

/**
 * Controllable RAF queue: callbacks are NOT auto-fired; the test pumps them
 * with an explicit timestamp so the metering delta is deterministic.
 */
function installControllableRaf() {
  const queue: FrameRequestCallback[] = [];
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    queue.push(cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (): void => {
    // The batcher cancels its single pending frame on flushSync; dropping the
    // queue prevents a stale callback from double-firing.
    queue.length = 0;
  });
  /** Fire exactly one queued frame at the given timestamp (ms). */
  function tick(now: number): void {
    const cb = queue.shift();
    if (!cb) throw new Error("no RAF callback queued");
    cb(now);
  }
  return { queue, tick };
}

function recordingAppend(): { append: Append; batches: Batch[] } {
  const batches: Batch[] = [];
  const append = vi.fn(
    (id: string, token: string, genId?: string, seq?: number, tokenDelta?: number) => {
      batches.push({ id, token, genId, seq, tokenDelta });
    },
  );
  return { append, batches };
}

const joined = (batches: Batch[]) => batches.map((b) => b.token).join("");
const totalDelta = (batches: Batch[]) =>
  batches.reduce((sum, b) => sum + (b.tokenDelta ?? 0), 0);

describe("token batcher — metered char-cadence drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("exposes the rate + cap as named constants in a sane range", () => {
    expect(VISUAL_CHARS_PER_SECOND).toBeGreaterThanOrEqual(120);
    expect(VISUAL_CHARS_PER_SECOND).toBeLessThanOrEqual(220);
    expect(MAX_BACKLOG_CHARS).toBeGreaterThan(0);
  });

  it("immediate first paint: the first emission for a fresh msgId flushes whole, unmetered", () => {
    installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append);

    // A large FIRST token must paint immediately and in full — TTFT must not
    // be taxed by metering. No RAF needed for the first paint.
    const first = "x".repeat(80);
    batcher.append("m1", first);

    expect(append).toHaveBeenCalledTimes(1);
    expect(batches[0]).toEqual({
      id: "m1",
      token: first,
      genId: undefined,
      seq: 1,
      tokenDelta: 1,
    });
  });

  it("metered release: a large backlog after first paint drips over multiple ticks", () => {
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append);

    // First token paints immediately (consumes the first-paint allowance).
    batcher.append("m1", "Hi ");
    expect(append).toHaveBeenCalledTimes(1);

    // A big burst arrives next — this one is metered, not dumped.
    const burst = "y".repeat(60);
    batcher.append("m1", burst);

    // The burst did NOT all appear synchronously.
    expect(joined(batches)).toBe("Hi ");

    // First metered tick: one frame's worth (~1/60s) of chars at the target
    // rate. Far less than the whole 60-char burst.
    raf.tick(1000);
    const afterFirstTick = joined(batches).length;
    expect(afterFirstTick).toBeGreaterThan("Hi ".length); // released something
    expect(afterFirstTick).toBeLessThan("Hi ".length + burst.length); // not everything

    // The drain self-reschedules while backlog remains — drive it to drain.
    let t = 1000;
    let guard = 0;
    while (joined(batches) !== "Hi " + burst) {
      t += 1000 / 60;
      raf.tick(t);
      if (++guard > 1000) throw new Error("drain never completed");
    }

    // Everything came out, in order, across multiple metered ticks.
    expect(joined(batches)).toBe("Hi " + burst);
    expect(batches.length).toBeGreaterThan(2); // first paint + several metered releases
  });

  it("self-reschedules while backlog remains even with no new append", () => {
    const raf = installControllableRaf();
    const { batches } = recordingAppend();
    const append = vi.fn(
      (id: string, token: string, genId?: string, seq?: number) =>
        batches.push({ id, token, genId, seq }),
    );
    const batcher = createTokenBatcher(append);

    batcher.append("m1", "a"); // first paint
    batcher.append("m1", "b".repeat(40)); // metered backlog

    // Pump frames with NO further appends — the backlog must keep draining
    // purely from self-rescheduled frames.
    let t = 0;
    let guard = 0;
    while (raf.queue.length > 0) {
      t += 1000 / 60;
      raf.tick(t);
      if (++guard > 1000) throw new Error("self-reschedule never terminated");
    }
    expect(joined(batches)).toBe("a" + "b".repeat(40));
  });

  it("catch-up bound: an oversized backlog is pulled within the cap in one tick", () => {
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append);

    batcher.append("m1", "."); // first paint
    // A backlog far larger than the cap (e.g. a huge paste / fast burst).
    const huge = "z".repeat(MAX_BACKLOG_CHARS * 4);
    batcher.append("m1", huge);

    // One tick at a normal frame delta. The metered slice alone is tiny, but
    // the catch-up rule must release enough to bring the remaining backlog to
    // <= cap so the user never waits meaningfully longer than ungated.
    raf.tick(1000 / 60);

    const releasedNonFirst = joined(batches).length - ".".length;
    const remaining = huge.length - releasedNonFirst;
    expect(remaining).toBeLessThanOrEqual(MAX_BACKLOG_CHARS);
    expect(remaining).toBeGreaterThan(0); // it did NOT just dump everything
  });

  it("flushSync drains the entire remaining backlog in one synchronous call", () => {
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append);

    batcher.append("m1", "start "); // first paint
    batcher.append("m1", "w".repeat(50)); // metered backlog
    raf.tick(1000 / 60); // release one metered slice, backlog still remains

    const callsBefore = append.mock.calls.length;
    batcher.flushSync();
    const callsAfter = append.mock.calls.length;

    // Exactly one more append (the whole remaining backlog in one frame)...
    expect(callsAfter).toBe(callsBefore + 1);
    // ...and NOTHING survives the flushSync.
    expect(joined(batches)).toBe("start " + "w".repeat(50));

    // A subsequent flushSync is a no-op (no trailing backlog).
    batcher.flushSync();
    expect(append.mock.calls.length).toBe(callsAfter);
  });

  it("seq is strictly monotonic and genId is tagged across every metered release", () => {
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append);
    batcher.setGenerationId("gen-77");
    batcher.resetSeq();

    batcher.append("m1", "go "); // first paint → seq 1
    batcher.append("m1", "q".repeat(45));

    let t = 0;
    let guard = 0;
    while (raf.queue.length > 0) {
      t += 1000 / 60;
      raf.tick(t);
      if (++guard > 1000) throw new Error("drain never completed");
    }

    // Every emission carries the genId.
    expect(batches.every((b) => b.genId === "gen-77")).toBe(true);
    // Seq is strictly increasing, starts at 1, one per emission.
    const seqs = batches.map((b) => b.seq);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBe(seqs[i - 1]! + 1);
    }
    expect(joined(batches)).toBe("go " + "q".repeat(45));
  });

  it("reduced-motion bypass: whole buffer flushes per frame, no metering, no sync first paint", () => {
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append, () => true); // reduced motion ON

    // Under reduced motion the OLD behavior holds: even the first token is
    // queued for a frame (not painted synchronously), and a frame flushes the
    // ENTIRE accumulated buffer in one append.
    batcher.append("m1", "Hello");
    batcher.append("m1", " world"); // accumulates into the same buffer
    expect(append).not.toHaveBeenCalled(); // nothing synchronous

    raf.tick(1000); // one frame → whole buffer
    expect(append).toHaveBeenCalledTimes(1);
    // The whole-buffer flush carried BOTH appended tokens (delta 2).
    expect(batches[0]).toEqual({
      id: "m1",
      token: "Hello world",
      genId: undefined,
      seq: 1,
      tokenDelta: 2,
    });

    // No backlog left → no self-reschedule.
    expect(raf.queue).toHaveLength(0);

    // A second burst flushes whole on its own frame with the next seq.
    batcher.append("m1", "!".repeat(100));
    raf.tick(2000);
    expect(append).toHaveBeenCalledTimes(2);
    expect(batches[1]).toEqual({
      id: "m1",
      token: "!".repeat(100),
      genId: undefined,
      seq: 2,
      tokenDelta: 1,
    });
  });

  it("reduced-motion seam is read lazily (not frozen at construction)", () => {
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    let reduced = true;
    const batcher = createTokenBatcher(append, () => reduced);

    // While reduced: whole-buffer, queued (no sync first paint).
    batcher.append("m1", "A".repeat(50));
    expect(append).not.toHaveBeenCalled();
    raf.tick(1000);
    expect(joined(batches)).toBe("A".repeat(50));

    // Flip the seam off mid-stream → metered behavior + immediate first paint
    // for the next fresh message.
    reduced = false;
    batcher.append("m2", "B".repeat(40)); // first paint for m2 → immediate
    expect(joined(batches)).toBe("A".repeat(50) + "B".repeat(40).slice(0, 0) + "B".repeat(40));
    // (the m2 first token painted immediately and in full)
    const m2Batch = batches.find((b) => b.id === "m2");
    expect(m2Batch?.token).toBe("B".repeat(40));
  });

  it("defaults to a working SSR/jsdom-safe reduced-motion probe (no window.matchMedia)", () => {
    // jsdom has no real matchMedia by default in this suite; the default probe
    // must not throw and must resolve to metered (not reduced) behavior.
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append); // no seam → default probe

    expect(() => batcher.append("m1", "first")).not.toThrow();
    // First paint happened synchronously → metered path is active (default
    // probe returned false), not the reduced whole-buffer-on-frame path. No
    // frame is queued because the first paint drained the backlog in full.
    expect(joined(batches)).toBe("first");
    expect(raf.queue).toHaveLength(0);
  });
});

describe("token batcher — token-delta passthrough (tokenCount stays exact)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sums tokenDelta to the true token count across a multi-frame metered drain, not the frame count", () => {
    const raf = installControllableRaf();
    const { batches } = recordingAppend();
    const append = vi.fn(
      (id: string, token: string, genId?: string, seq?: number, tokenDelta?: number) =>
        batches.push({ id, token, genId, seq, tokenDelta }),
    );
    const batcher = createTokenBatcher(append);

    // 10 stream tokens, each appended once (as run-generation.ts does). The
    // first paints immediately; the remaining 9 buffer and drain over several
    // frames — emitting MORE append() calls than tokens.
    const tokens = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    for (const t of tokens) batcher.append("m1", t.repeat(4)); // 4 chars each → 40-char backlog

    let t = 0;
    let guard = 0;
    while (raf.queue.length > 0) {
      t += 1000 / 60;
      raf.tick(t);
      if (++guard > 1000) throw new Error("drain never completed");
    }

    // The drain emitted several frames (more append calls than tokens)...
    expect(batches.length).toBeGreaterThan(tokens.length);
    // ...yet the summed tokenDelta equals the TRUE token count (10), not frames.
    expect(totalDelta(batches)).toBe(tokens.length);
  });

  it("first-paint emit carries the exact delta of the tokens it released", () => {
    installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append);

    // Two tokens arrive before any frame; the first append paints immediately,
    // so the first paint carries delta 1 (only the first token had arrived).
    batcher.append("m1", "one");
    expect(append).toHaveBeenCalledTimes(1);
    expect(batches[0]!.tokenDelta).toBe(1);
  });

  it("resets the token-delta counter on msgId change (no carry-over between messages)", () => {
    installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append);

    // Buffer several tokens for m1 WITHOUT draining them (jsdom has no rAF, so
    // post-first-paint tokens stay pending). m1's first paint takes delta 1;
    // tokens 2 and 3 accrue into `tokensSinceEmit` but are never emitted.
    batcher.append("m1", "a"); // m1 first paint, delta 1
    batcher.append("m1", "b"); // pending for m1
    batcher.append("m1", "c"); // pending for m1

    // Switch to a fresh message. The msgId change must reset the per-message
    // drain state — including `tokensSinceEmit` — so m1's undrained tokens do
    // NOT leak into m2's first-paint delta.
    batcher.append("m2", "Z"); // m2 first paint

    const m2First = batches.find((b) => b.id === "m2");
    expect(m2First?.tokenDelta).toBe(1); // exactly its own one token, not 1+2 carried over
  });

  it("a pure-drain frame (no new token that frame) passes tokenDelta 0", () => {
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append);

    batcher.append("m1", "x"); // first paint, delta 1
    batcher.append("m1", "y".repeat(40)); // ONE token, big char backlog

    // Drain across many frames with NO further appends. After the frame that
    // carries the second token's delta (1), subsequent pure-drain frames must
    // carry delta 0 so the total never exceeds the true token count.
    let t = 0;
    let guard = 0;
    while (raf.queue.length > 0) {
      t += 1000 / 60;
      raf.tick(t);
      if (++guard > 1000) throw new Error("drain never completed");
    }

    // Exactly 2 tokens streamed → total delta 2, regardless of frame count.
    expect(totalDelta(batches)).toBe(2);
    // At least one pure-drain frame carried delta 0.
    expect(batches.some((b) => b.tokenDelta === 0)).toBe(true);
  });

  it("reduced-motion path also sums to the true token count", () => {
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append, () => true); // reduced motion ON

    // 5 tokens accumulate into one buffer; one frame flushes the whole buffer.
    for (let i = 0; i < 5; i++) batcher.append("m1", `t${i} `);
    raf.tick(1000);

    expect(append).toHaveBeenCalledTimes(1);
    expect(totalDelta(batches)).toBe(5); // whole-buffer flush carried all 5
  });

  it("flushSync's final emit carries the remaining buffered tokens' delta", () => {
    const raf = installControllableRaf();
    const { append, batches } = recordingAppend();
    const batcher = createTokenBatcher(append);

    batcher.append("m1", "a"); // first paint, delta 1
    batcher.append("m1", "b"); // buffered, delta pending
    batcher.append("m1", "c"); // buffered, delta pending
    raf.tick(1000 / 60); // metered frame may release some chars/tokens
    batcher.flushSync(); // drains the remainder

    // 3 tokens total streamed → exact.
    expect(totalDelta(batches)).toBe(3);
  });
});
