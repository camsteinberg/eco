// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { ProgressTracker, type ProgressEvent } from '../progress';

// ─── Manual clock + timer harness ──────────────────────────────────────────
// We inject our own clock/setTimer/clearTimer so tests can assert exact
// stall timings without coupling to Vitest's fake timers (which also
// affects Promise microtask scheduling and complicates the assertions).

type TimerEntry = { id: number; due: number; callback: () => void };

function createTimerHarness() {
  let nowMs = 0;
  let nextId = 1;
  const entries = new Map<number, TimerEntry>();

  return {
    now: () => nowMs,
    setTimer: (callback: () => void, ms: number): number => {
      const id = nextId++;
      entries.set(id, { id, due: nowMs + ms, callback });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      entries.delete(handle as number);
    },
    advance(ms: number) {
      const target = nowMs + ms;
      // Fire timers in due order.
      while (true) {
        let earliest: TimerEntry | null = null;
        for (const entry of entries.values()) {
          if (entry.due > target) continue;
          if (!earliest || entry.due < earliest.due) earliest = entry;
        }
        if (!earliest) break;
        entries.delete(earliest.id);
        nowMs = earliest.due;
        earliest.callback();
      }
      nowMs = target;
    },
    pending: () => entries.size,
  };
}

function makeTracker(overrides?: Partial<ConstructorParameters<typeof ProgressTracker>[0]>) {
  const harness = createTimerHarness();
  const events: ProgressEvent[] = [];
  const tracker = new ProgressTracker({
    now: harness.now,
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
    ...overrides,
  });
  tracker.subscribe((event) => events.push(event));
  return { tracker, events, harness };
}

// ─── Basic emission ────────────────────────────────────────────────────────

describe('ProgressTracker — basic emission', () => {
  it('emits a downloading progress event on report', () => {
    const { tracker, events } = makeTracker();
    tracker.reportDownloadProgress(50, 100);
    const last = events[events.length - 1]!;
    expect(last.kind).toBe('progress');
    if (last.kind !== 'progress' || last.phase !== 'downloading') throw new Error('unexpected event');
    expect(last.loaded).toBe(50);
    expect(last.total).toBe(100);
    expect(last.percent).toBeCloseTo(0.5);
  });

  it('transitions to smoke phase with a phase event', () => {
    const { tracker, events } = makeTracker();
    tracker.startSmoke();
    const phaseEvent = events.find((e) => e.kind === 'phase');
    expect(phaseEvent).toBeDefined();
    if (phaseEvent?.kind === 'phase') expect(phaseEvent.phase).toBe('smoke');
  });

  it('emits a phase=done event on complete', () => {
    const { tracker, events } = makeTracker();
    tracker.complete();
    const done = events.find((e) => e.kind === 'phase' && e.phase === 'done');
    expect(done).toBeDefined();
  });

  it('emits a phase=error event with the reason on error', () => {
    const { tracker, events } = makeTracker();
    tracker.error('something broke');
    const errorEvent = events.find((e) => e.kind === 'phase' && e.phase === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.kind === 'phase') expect(errorEvent.reason).toBe('something broke');
  });

  it('snapshot reflects the latest state', () => {
    const { tracker } = makeTracker();
    tracker.reportDownloadProgress(40, 100);
    expect(tracker.snapshot().percent).toBeCloseTo(0.4);
    expect(tracker.snapshot().phase).toBe('downloading');
  });

  it('unsubscribe stops further events', () => {
    const { tracker } = makeTracker();
    const received: ProgressEvent[] = [];
    const unsub = tracker.subscribe((e) => received.push(e));
    tracker.reportDownloadProgress(10, 100);
    unsub();
    tracker.reportDownloadProgress(50, 100);
    expect(received).toHaveLength(1);
  });
});

// ─── Stall detection — downloading <99% ────────────────────────────────────

describe('ProgressTracker — early-stall (download <99%)', () => {
  it('fires after 30s of no progress', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.reportDownloadProgress(50, 100);
    harness.advance(30_000);

    const stall = events.find((e) => e.kind === 'stall');
    expect(stall).toBeDefined();
    if (stall?.kind === 'stall') {
      expect(stall.phase).toBe('downloading');
      expect(stall.stall).toBe('early-stall');
      expect(stall.lastPercent).toBeCloseTo(0.5);
    }
    void tracker;
  });

  it('does not fire if forward progress occurs', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.reportDownloadProgress(50, 100);
    harness.advance(15_000);
    tracker.reportDownloadProgress(70, 100);
    harness.advance(15_000);
    // 30s elapsed since first event, but only 15s since second.
    const stall = events.find((e) => e.kind === 'stall');
    expect(stall).toBeUndefined();
    void tracker;
  });

  it('does not fire after completion', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.reportDownloadProgress(50, 100);
    tracker.complete();
    harness.advance(60_000);
    const stall = events.find((e) => e.kind === 'stall');
    expect(stall).toBeUndefined();
    void tracker;
  });
});

// ─── Stall detection — downloading ≥99% ────────────────────────────────────

describe('ProgressTracker — finalize-stall (download ≥99%)', () => {
  it('fires after 60s of no completion', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.reportDownloadProgress(99, 100);
    harness.advance(60_000);

    const stall = events.find((e) => e.kind === 'stall');
    expect(stall).toBeDefined();
    if (stall?.kind === 'stall') {
      expect(stall.phase).toBe('downloading');
      expect(stall.stall).toBe('finalize-stall');
    }
    void tracker;
  });

  it('does not fire at 30s (only 60s window)', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.reportDownloadProgress(99, 100);
    harness.advance(30_000);
    const stall = events.find((e) => e.kind === 'stall');
    expect(stall).toBeUndefined();
    void tracker;
  });
});

// ─── Stall detection — smoke phase ─────────────────────────────────────────

describe('ProgressTracker — smoke-timeout', () => {
  it('fires after 30s of no smoke ping', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.startSmoke();
    harness.advance(30_000);

    const stall = events.find((e) => e.kind === 'stall');
    expect(stall).toBeDefined();
    if (stall?.kind === 'stall') {
      expect(stall.phase).toBe('smoke');
      expect(stall.stall).toBe('smoke-timeout');
    }
    void tracker;
  });

  it('re-arms on running ping', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.startSmoke();
    harness.advance(15_000);
    tracker.reportSmokeStage('running');
    harness.advance(15_000);
    const stall = events.find((e) => e.kind === 'stall');
    expect(stall).toBeUndefined();
    void tracker;
  });

  it('done stage clears the stall timer and emits phase=done', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.startSmoke();
    tracker.reportSmokeStage('done');
    harness.advance(60_000);
    const stall = events.find((e) => e.kind === 'stall');
    expect(stall).toBeUndefined();
    const done = events.find((e) => e.kind === 'phase' && e.phase === 'done');
    expect(done).toBeDefined();
    void tracker;
  });

  it('timeout stage emits phase=error with reason', () => {
    const { tracker, events } = makeTracker();
    tracker.startSmoke();
    tracker.reportSmokeStage('timeout');
    const errorEvent = events.find((e) => e.kind === 'phase' && e.phase === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.kind === 'phase') expect(errorEvent.reason).toMatch(/timed? out/i);
    void tracker;
  });
});

// ─── Phase transition: stall window swaps on percent threshold ─────────────

describe('ProgressTracker — phase-window switching', () => {
  it('switches from 30s window to 60s when crossing 99%', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.reportDownloadProgress(50, 100); // 30s window arms
    harness.advance(20_000);
    tracker.reportDownloadProgress(99, 100); // re-arms with 60s window
    harness.advance(30_000);                  // would fire under 30s rule
    expect(events.find((e) => e.kind === 'stall')).toBeUndefined();
    harness.advance(30_000);                  // total 60s since last advance
    expect(events.find((e) => e.kind === 'stall')).toBeDefined();
    void tracker;
  });
});

// ─── Speed + ETA ───────────────────────────────────────────────────────────

describe('ProgressTracker — speed + ETA', () => {
  it('computes a positive speed after two progress events spaced in time', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.reportDownloadProgress(0, 1_000_000);
    harness.advance(1_000);
    tracker.reportDownloadProgress(100_000, 1_000_000);
    const last = events[events.length - 1]!;
    if (last.kind !== 'progress' || last.phase !== 'downloading') throw new Error('unexpected');
    expect(last.speedBytesPerSec).toBeGreaterThan(0);
    expect(last.etaSeconds).toBeGreaterThan(0);
    void tracker;
  });
});

// ─── destroy ───────────────────────────────────────────────────────────────

describe('ProgressTracker — destroy', () => {
  it('clears timers and drops subscribers', () => {
    const { tracker, events, harness } = makeTracker();
    tracker.reportDownloadProgress(50, 100);
    tracker.destroy();
    harness.advance(60_000);
    expect(events.find((e) => e.kind === 'stall')).toBeUndefined();
  });

  it('is idempotent', () => {
    const { tracker } = makeTracker();
    tracker.destroy();
    expect(() => tracker.destroy()).not.toThrow();
  });
});
