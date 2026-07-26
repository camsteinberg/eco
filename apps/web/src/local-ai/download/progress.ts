// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Progress — single-channel progress + stall detection.
 *
 * Replaces the ad-hoc download progress in `hooks/useModelDownload.ts`
 * plus the missing smoke-stall coverage that the Layer 3 audit (BLOCKER-02)
 * flagged.
 *
 * Invariant 9 (vision-and-architecture §2.2): the stall detector covers
 * BOTH the download phase AND the smoke phase. A consumer subscribes once
 * and observes:
 *
 *   - `progress` events while bytes flow (downloading) or while the smoke
 *     driver pings (smoke)
 *   - `phase` events on transitions (downloading → smoke → done/error)
 *   - `stall` events when no forward motion has been observed for the
 *     phase's stall window:
 *       • downloading + percent < 0.99 → `early-stall` after 30s
 *       • downloading + percent ≥ 0.99 → `finalize-stall` after 60s
 *       • smoke (any stage) → `smoke-timeout` after 30s
 *
 * The tracker never decides what to do about a stall — consumers may
 * retry, force-complete, or surface an error. Routing decisions live in
 * `lifecycle/self-heal.ts` and the consumer surface.
 *
 * ProgressTracker is the single source of truth for download status
 * within `local-ai/` (Invariant 4). Everything that wants to know whether
 * a download is alive subscribes here; nothing else inside `local-ai/`
 * may export `download-status` / `download-progress` style symbols.
 */

// ─── Event types ────────────────────────────────────────────────────────────

export type ProgressPhase = 'downloading' | 'smoke' | 'done' | 'error';

export type SmokeStage = 'starting' | 'running' | 'done' | 'timeout';

export type StallKind = 'early-stall' | 'finalize-stall' | 'smoke-timeout';

export type ProgressEvent =
  | {
      kind: 'progress';
      phase: 'downloading';
      percent: number;
      loaded: number;
      total: number;
      speedBytesPerSec: number;
      etaSeconds: number;
    }
  | {
      kind: 'progress';
      phase: 'smoke';
      stage: SmokeStage;
    }
  | {
      kind: 'phase';
      phase: ProgressPhase;
      reason?: string;
    }
  | {
      kind: 'stall';
      phase: 'downloading' | 'smoke';
      stall: StallKind;
      lastPercent: number;
    };

export type ProgressHandler = (event: ProgressEvent) => void;

// ─── Tracker options ────────────────────────────────────────────────────────

export type ProgressTrackerOptions = {
  /** Override the monotonic clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Override setTimeout (for fake-timer tests that need direct injection). */
  setTimer?: (callback: () => void, ms: number) => unknown;
  /** Cancel a timer returned by setTimer. */
  clearTimer?: (handle: unknown) => void;
  /** Early-stall window: download <99% with no forward motion. Default 30s. */
  earlyStallMs?: number;
  /** Finalize-stall window: download ≥99% with no flip to done. Default 60s. */
  finalizeStallMs?: number;
  /** Smoke-stall window: no `running` ping in the smoke phase. Default 30s. */
  smokeStallMs?: number;
  /** Percent threshold separating early-stall from finalize-stall. Default 0.99. */
  finalizeThreshold?: number;
  /** Sliding window for speed/ETA computation. Default 10s. */
  speedWindowMs?: number;
};

type ResolvedOptions = Required<ProgressTrackerOptions>;

type SpeedSample = { time: number; loaded: number };

const DEFAULT_OPTIONS: ResolvedOptions = {
  now: () => Date.now(),
  setTimer: ((callback: () => void, ms: number) => setTimeout(callback, ms)) as ResolvedOptions['setTimer'],
  clearTimer: ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)) as ResolvedOptions['clearTimer'],
  earlyStallMs: 30_000,
  finalizeStallMs: 60_000,
  smokeStallMs: 30_000,
  finalizeThreshold: 0.99,
  speedWindowMs: 10_000,
};

// ─── ProgressTracker ────────────────────────────────────────────────────────

export class ProgressTracker {
  private readonly options: ResolvedOptions;
  private readonly subscribers = new Set<ProgressHandler>();
  private currentPhase: ProgressPhase = 'downloading';
  private currentPercent = 0;
  /** High-water mark: the published figure, never allowed to run backwards. */
  private currentLoaded = 0;
  /** Last raw figure reported, for detecting a restart (see the clamp below). */
  private lastReportedLoaded = 0;
  private currentTotal = 0;
  private currentSpeed = 0;
  private currentEta = 0;
  private currentSmokeStage: SmokeStage | null = null;
  private stallTimer: unknown = null;
  private readonly speedSamples: SpeedSample[] = [];
  private destroyed = false;

  constructor(options?: ProgressTrackerOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  }

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(handler: ProgressHandler): () => void {
    if (this.destroyed) {
      return () => undefined;
    }
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Report download progress. Idempotent on `(loaded, total)` repeats — the
   * stall timer only re-arms when `loaded` moves. This matters because
   * fetch ReadableStreams can fire a final zero-delta read at the close of
   * a chunk, which is not real progress.
   *
   * `loaded` is absolute but NOT monotonic at the source: a re-attempted
   * transfer (a transient-retry re-request, or the CDN→proxy fallback
   * re-entering a file) restarts its byte counter at that transfer's base and
   * re-reports figures already seen. The published `loaded` is therefore a
   * high-water mark — a bar that runs backwards reads as breakage, and the
   * negative deltas would otherwise poison the speed window into a negative
   * rate and a garbage ETA. A restart still counts as motion for the stall
   * detector: bytes ARE flowing, just over ground already shown, and treating
   * it as a stall would fire `early-stall` on a download that is recovering.
   *
   * A SHRINKING `total` is the one legitimate reason the published figure may
   * drop. It means the plan's byte count was a heuristic estimate the origin
   * has since corrected downward, so the high-water mark was measured against
   * a fiction: carrying it forward would put `percent` above 1 and could
   * misread an early stall as a finalize-stall. The mark re-baselines to the
   * freshly reported figure, and the published figure is clamped to the total
   * it is measured against so `percent <= 1` holds unconditionally.
   */
  reportDownloadProgress(loaded: number, total: number): void {
    if (this.destroyed) return;
    if (this.currentPhase !== 'downloading') {
      this.setPhase('downloading');
    }

    const safeTotal = Math.max(total, 0);
    const reported = Math.max(0, Math.min(loaded, safeTotal || loaded));

    const moved = reported !== this.lastReportedLoaded;
    this.lastReportedLoaded = reported;
    // An authoritative downward correction of the total discards the mark; any
    // other report only ever raises it.
    const correctedDown = safeTotal > 0 && safeTotal < this.currentTotal;
    const highWater = correctedDown ? reported : Math.max(this.currentLoaded, reported);
    this.currentLoaded = safeTotal > 0 ? Math.min(highWater, safeTotal) : highWater;
    this.currentTotal = safeTotal;
    this.currentPercent = safeTotal > 0 ? this.currentLoaded / safeTotal : 0;

    // Record every sample so the next call can compute a delta — including
    // the initial loaded=0 sample. Samples carry the published figure, which
    // only decreases on a total correction. The `moved` gate is only there to
    // keep the stall timer from churning on idle re-reports.
    this.recordSpeedSample(this.currentLoaded);
    const { speedBytesPerSec, etaSeconds } = this.computeSpeedAndEta(safeTotal);
    this.currentSpeed = speedBytesPerSec;
    this.currentEta = etaSeconds;

    if (moved) {
      this.armDownloadStallTimer();
    }

    this.emit({
      kind: 'progress',
      phase: 'downloading',
      percent: this.currentPercent,
      loaded: this.currentLoaded,
      total: this.currentTotal,
      speedBytesPerSec: this.currentSpeed,
      etaSeconds: this.currentEta,
    });
  }

  /**
   * Transition into the smoke phase. The first call arms the smoke stall
   * timer; subsequent `reportSmokeStage('running')` calls re-arm it.
   */
  startSmoke(): void {
    if (this.destroyed) return;
    this.setPhase('smoke');
    this.currentSmokeStage = 'starting';
    this.emit({ kind: 'progress', phase: 'smoke', stage: 'starting' });
    this.armSmokeStallTimer();
  }

  /**
   * Report a smoke-phase stage. `'running'` re-arms the stall timer.
   * `'done'` and `'timeout'` clear it and emit the appropriate phase event.
   */
  reportSmokeStage(stage: SmokeStage): void {
    if (this.destroyed) return;
    if (this.currentPhase !== 'smoke') {
      this.setPhase('smoke');
    }
    this.currentSmokeStage = stage;
    this.emit({ kind: 'progress', phase: 'smoke', stage });

    if (stage === 'running') {
      this.armSmokeStallTimer();
      return;
    }

    this.cancelStallTimer();

    if (stage === 'done') {
      this.complete();
    } else if (stage === 'timeout') {
      this.error('Smoke test timed out');
    }
  }

  /** Transition to the terminal `done` phase. Clears stall timer. */
  complete(): void {
    if (this.destroyed) return;
    this.cancelStallTimer();
    this.setPhase('done');
  }

  /** Transition to the terminal `error` phase with a reason. Clears stall timer. */
  error(reason: string): void {
    if (this.destroyed) return;
    this.cancelStallTimer();
    this.setPhase('error', reason);
  }

  /** Snapshot of the current state for consumers that want pull semantics. */
  snapshot(): {
    phase: ProgressPhase;
    percent: number;
    loaded: number;
    total: number;
    speedBytesPerSec: number;
    etaSeconds: number;
    smokeStage: SmokeStage | null;
  } {
    return {
      phase: this.currentPhase,
      percent: this.currentPercent,
      loaded: this.currentLoaded,
      total: this.currentTotal,
      speedBytesPerSec: this.currentSpeed,
      etaSeconds: this.currentEta,
      smokeStage: this.currentSmokeStage,
    };
  }

  /** Tear down: clear timers, drop subscribers. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.cancelStallTimer();
    this.subscribers.clear();
    this.destroyed = true;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private setPhase(phase: ProgressPhase, reason?: string): void {
    if (this.currentPhase === phase && phase !== 'error') return;
    this.currentPhase = phase;
    const event: ProgressEvent = reason !== undefined
      ? { kind: 'phase', phase, reason }
      : { kind: 'phase', phase };
    this.emit(event);
  }

  private armDownloadStallTimer(): void {
    this.cancelStallTimer();
    const finalize = this.currentPercent >= this.options.finalizeThreshold;
    const ms = finalize ? this.options.finalizeStallMs : this.options.earlyStallMs;
    const stallKind: StallKind = finalize ? 'finalize-stall' : 'early-stall';
    this.stallTimer = this.options.setTimer(() => {
      this.stallTimer = null;
      if (this.destroyed) return;
      if (this.currentPhase !== 'downloading') return;
      this.emit({
        kind: 'stall',
        phase: 'downloading',
        stall: stallKind,
        lastPercent: this.currentPercent,
      });
    }, ms);
  }

  private armSmokeStallTimer(): void {
    this.cancelStallTimer();
    this.stallTimer = this.options.setTimer(() => {
      this.stallTimer = null;
      if (this.destroyed) return;
      if (this.currentPhase !== 'smoke') return;
      this.emit({
        kind: 'stall',
        phase: 'smoke',
        stall: 'smoke-timeout',
        lastPercent: this.currentPercent,
      });
    }, this.options.smokeStallMs);
  }

  private cancelStallTimer(): void {
    if (this.stallTimer != null) {
      this.options.clearTimer(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private recordSpeedSample(loaded: number): void {
    const time = this.options.now();
    this.speedSamples.push({ time, loaded });
    const cutoff = time - this.options.speedWindowMs;
    while (this.speedSamples.length > 2 && this.speedSamples[0]!.time < cutoff) {
      this.speedSamples.shift();
    }
  }

  private computeSpeedAndEta(total: number): { speedBytesPerSec: number; etaSeconds: number } {
    if (this.speedSamples.length < 2) {
      return { speedBytesPerSec: 0, etaSeconds: 0 };
    }
    const newest = this.speedSamples[this.speedSamples.length - 1]!;
    const cutoff = newest.time - this.options.speedWindowMs;
    let oldest = this.speedSamples[0]!;
    for (const sample of this.speedSamples) {
      if (sample.time >= cutoff) {
        oldest = sample;
        break;
      }
    }
    const dtSeconds = (newest.time - oldest.time) / 1000;
    if (dtSeconds <= 0) return { speedBytesPerSec: 0, etaSeconds: 0 };
    // Samples only ever decrease across a downward total correction, whose
    // re-baseline is not a negative transfer rate — clamp rather than report one.
    const bytesPerSec = Math.max(0, newest.loaded - oldest.loaded) / dtSeconds;
    const remaining = total > 0 ? Math.max(0, total - newest.loaded) : 0;
    const etaSeconds = bytesPerSec > 0 ? remaining / bytesPerSec : 0;
    return { speedBytesPerSec: bytesPerSec, etaSeconds };
  }

  private emit(event: ProgressEvent): void {
    if (this.destroyed) return;
    for (const handler of this.subscribers) {
      handler(event);
    }
  }
}
