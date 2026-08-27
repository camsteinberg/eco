// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Direct tests for the REAL default `runAttempt` seam (`defaultRunAttempt`),
 * reached via `DEFAULT_SEAMS.runAttempt`.
 *
 * The `executeSetup` / `runSetupCascade` tests inject a *fake* `runAttempt`, so
 * the actual download-vs-load/smoke phase classification — the seam that drives
 * the cascade's retry-vs-demote policy — is never exercised there. These tests
 * pin it.
 *
 * Why the phase split matters (see `setup-cascade.ts`):
 *   - phase 'download'      → cascade retries the SAME model once (treated as a
 *                             transient network blip), NOT recorded to the ledger.
 *   - phase 'load-or-smoke' → cascade demotes immediately (deterministic for
 *                             this model×device) and records a smoke-fail so the
 *                             model is excluded on the next pick.
 * Misclassifying either way is a real first-run regression — wasted re-downloads
 * of a deterministically broken model, or premature demotion on a network blip —
 * so it is worth locking behind direct tests.
 *
 * The `finally { unsubscribe() }` block is covered separately: the attempt must
 * release its progress listener on every exit path, including when a collaborator
 * throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressTracker } from '../../download/progress';
import type { ProgressEvent, ProgressPhase } from '../../download/progress';
import type { ModelConfig, Slot } from '../../types';
import type { SmokeResult } from '../smoke';

// Real error hierarchy (signatures mirror the module, and DownloadIntegrityError
// really does extend DownloadFailedError) so setup-runner's `instanceof` checks
// resolve and the type-checker accepts the constructors. Declared inside the
// factory because vi.mock is hoisted above every top-level binding.
vi.mock('../../download/download', () => {
  class DownloadFailedError extends Error {
    readonly status?: number;
    readonly url: string;
    constructor(message: string, opts: { url: string; status?: number }) {
      super(message);
      this.name = 'DownloadFailedError';
      this.url = opts.url;
      this.status = opts.status;
    }
  }
  return {
    downloadModel: vi.fn(),
    InsufficientStorageError: class InsufficientStorageError extends Error {
      constructor(public requiredBytes: number, public availableBytes?: number) {
        super('not enough free space');
        this.name = 'InsufficientStorageError';
      }
    },
    DownloadFailedError,
    DownloadIntegrityError: class DownloadIntegrityError extends DownloadFailedError {
      constructor(message: string, opts: { url: string }) {
        super(message, opts);
        this.name = 'DownloadIntegrityError';
      }
    },
    DownloadAbortedError: class DownloadAbortedError extends Error {
      constructor(modelId: string) {
        super(`Download aborted for ${modelId}`);
        this.name = 'DownloadAbortedError';
      }
    },
  };
});
vi.mock('../smoke', () => ({ runSmoke: vi.fn() }));

import { DEFAULT_SEAMS, defaultRunAttempt, acquireDownloadLeaseFailOpen } from '../setup-runner';
import {
  DownloadAbortedError,
  DownloadFailedError,
  DownloadIntegrityError,
  downloadModel,
  InsufficientStorageError,
} from '../../download/download';
import { runSmoke } from '../smoke';
import type { LocalHeavyWorkAcquireResult, LocalHeavyWorkKind } from '../../../lib/local-heavy-work-owner';

const SLOT: Slot = 'eco-fast';
const MODEL = { id: 'lfm2.5-1.2b' } as ModelConfig;

const passSmoke = (): SmokeResult => ({ passed: true, firstTokenMs: 12, durationMs: 80, tokensReceived: 6 });
const failSmoke = (reason: string): SmokeResult => ({ passed: false, reason, durationMs: 40 });

/** `defaultRunAttempt` ignores the resolved DownloadResult — only the absence of a throw matters. */
const downloadOk = () =>
  vi.mocked(downloadModel).mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof downloadModel>>);

const eventsOf = (spy: ReturnType<typeof vi.fn>): ProgressEvent[] =>
  spy.mock.calls.map((c) => c[0] as ProgressEvent);

const phaseEvent = (events: ProgressEvent[], phase: ProgressPhase) =>
  events.find((e): e is Extract<ProgressEvent, { kind: 'phase' }> => e.kind === 'phase' && e.phase === phase);

const enteredSmoke = (events: ProgressEvent[]): boolean =>
  events.some((e) => e.kind === 'progress' && e.phase === 'smoke' && e.stage === 'starting');

describe('DEFAULT_SEAMS.runAttempt — download vs load/smoke phase classification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('classifies a download rejection as phase "download" (cascade retries the same model once)', async () => {
    vi.mocked(downloadModel).mockRejectedValue(new Error('network down'));
    const onProgress = vi.fn();

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, onProgress);

    expect(result).toEqual({ ok: false, phase: 'download', reason: 'network down' });
    expect(runSmoke).not.toHaveBeenCalled();
    const events = eventsOf(onProgress);
    expect(enteredSmoke(events)).toBe(false);
    expect(phaseEvent(events, 'error')?.reason).toBe('network down');
  });

  it('falls back to a generic reason when the download rejects with a non-Error', async () => {
    vi.mocked(downloadModel).mockRejectedValue('socket hung up');

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());

    expect(result).toEqual({ ok: false, phase: 'download', reason: 'Download failed.' });
  });

  it('tags an insufficient-storage rejection so the cascade skips the retry', async () => {
    vi.mocked(downloadModel).mockRejectedValue(
      new InsufficientStorageError(2_000_000_000, 300_000_000),
    );

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());

    expect(result).toEqual({
      ok: false,
      phase: 'download',
      reason: 'not enough free space',
      reasonCode: 'insufficient-storage',
      // The figure lets exhaustion quote the smallest requirement tried.
      requiredBytes: 2_000_000_000,
    });
    expect(runSmoke).not.toHaveBeenCalled();
  });

  // The reason code is the only cause signal that survives ladder exhaustion —
  // the cascade replaces the failure text with its own copy — so what gets a code
  // here decides whether the error surface can name the host or has to stay
  // generic. See `downloadFailureReasonCode` in setup-runner.ts.
  it('tags a host/transport failure so the error surface can name the host', async () => {
    vi.mocked(downloadModel).mockRejectedValue(
      new DownloadFailedError('HTTP 500 fetching model weights', {
        url: 'https://models.example/weights',
        status: 500,
      }),
    );

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());

    expect(result).toMatchObject({
      ok: false,
      phase: 'download',
      reasonCode: 'network-or-host',
    });
  });

  it('tags an aborted (stalled) download as network-or-host too', async () => {
    vi.mocked(downloadModel).mockRejectedValue(new DownloadAbortedError('lfm2.5-1.2b'));

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());

    expect(result).toMatchObject({ ok: false, phase: 'download', reasonCode: 'network-or-host' });
  });

  it('does NOT call an integrity failure a connectivity problem', async () => {
    // DownloadIntegrityError extends DownloadFailedError, but "the bytes did not
    // match the manifest" is not "we could not reach the host" — telling someone
    // to check their connection would send them after the wrong thing.
    vi.mocked(downloadModel).mockRejectedValue(
      new DownloadIntegrityError('checksum mismatch', { url: 'https://models.example/weights' }),
    );

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());

    expect(result).toEqual({ ok: false, phase: 'download', reason: 'checksum mismatch' });
  });

  it('leaves a cache/OPFS write failure uncoded rather than guessing', async () => {
    vi.mocked(downloadModel).mockRejectedValue(
      new Error("Couldn't write the model file to the browser cache."),
    );

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());

    expect(result).toEqual({
      ok: false,
      phase: 'download',
      reason: "Couldn't write the model file to the browser cache.",
    });
  });

  it('reports the smoke "running" stage when the smoke runner says the model load finished', async () => {
    downloadOk();
    vi.mocked(runSmoke).mockImplementation(async (_slot, _model, options) => {
      options?.onLoadComplete?.();
      return passSmoke();
    });
    const onProgress = vi.fn();

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, onProgress);

    expect(result).toEqual({ ok: true });
    const events = eventsOf(onProgress);
    expect(events.some((e) => e.kind === 'progress' && e.phase === 'smoke' && e.stage === 'running')).toBe(true);
  });

  it('classifies a smoke rejection as phase "load-or-smoke" (cascade demotes immediately)', async () => {
    downloadOk();
    vi.mocked(runSmoke).mockRejectedValue(new Error('WebGPU device lost'));
    const onProgress = vi.fn();

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, onProgress);

    expect(result).toEqual({ ok: false, phase: 'load-or-smoke', reason: 'WebGPU device lost' });
    expect(downloadModel).toHaveBeenCalledTimes(1);
    const events = eventsOf(onProgress);
    expect(enteredSmoke(events)).toBe(true);
    expect(phaseEvent(events, 'error')?.reason).toBe('WebGPU device lost');
  });

  it('falls back to a generic reason when smoke rejects with a non-Error', async () => {
    downloadOk();
    vi.mocked(runSmoke).mockRejectedValue('opaque');

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());

    expect(result).toEqual({ ok: false, phase: 'load-or-smoke', reason: 'Smoke check failed.' });
  });

  it('classifies a smoke check that returns passed:false as phase "load-or-smoke"', async () => {
    downloadOk();
    vi.mocked(runSmoke).mockResolvedValue(failSmoke('no tokens before timeout'));
    const onProgress = vi.fn();

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, onProgress);

    expect(result).toEqual({ ok: false, phase: 'load-or-smoke', reason: 'no tokens before timeout' });
    expect(phaseEvent(eventsOf(onProgress), 'error')?.reason).toBe('no tokens before timeout');
  });

  it('returns { ok: true } and completes when download and smoke both pass', async () => {
    downloadOk();
    vi.mocked(runSmoke).mockResolvedValue(passSmoke());
    const onProgress = vi.fn();

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, onProgress);

    expect(result).toEqual({ ok: true });
    const events = eventsOf(onProgress);
    expect(phaseEvent(events, 'done')).toBeDefined();
    expect(phaseEvent(events, 'error')).toBeUndefined();
  });
});

// ─── Stall / TTFB watchdog (RT-4) ────────────────────────────────────────────
//
// Before RT-4 a wedged first-run download hung setup forever: no abort signal
// was passed, the stall timer only armed after the first byte, and the stall
// event was swallowed. These pin that a stall now aborts the fetch and the
// cascade sees a retryable 'download' phase. On pre-fix code the mocked download
// never receives a signal to abort, so runAttempt never settles — the test
// times out (RED); with the fix it resolves to phase 'download' (GREEN).

describe('DEFAULT_SEAMS.runAttempt — stall / TTFB watchdog (RT-4)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A download that never resolves on its own and only settles when its abort
  // signal fires. `report` optionally emits one progress chunk (mid-stream case).
  const hangingDownloadUntilAbort = (report?: (tracker: ProgressTracker) => void) =>
    vi.mocked(downloadModel).mockImplementation(((_model: ModelConfig, opts?: { tracker?: ProgressTracker; signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        if (report && opts?.tracker) report(opts.tracker);
        opts?.signal?.addEventListener('abort', () => reject(new Error('download aborted')), { once: true });
      })) as unknown as typeof downloadModel);

  it('aborts a TTFB hang (no bytes ever) and classifies it as phase "download"', async () => {
    vi.useFakeTimers();
    hangingDownloadUntilAbort(); // never reports progress at all

    const resultPromise = DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());
    // Advance past the 30s early-stall window; startDownload armed the timer.
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await resultPromise;

    expect(result).toMatchObject({ ok: false, phase: 'download' });
    expect(runSmoke).not.toHaveBeenCalled();
  });

  it('aborts a mid-stream wedge (bytes then silence) and classifies it as phase "download"', async () => {
    vi.useFakeTimers();
    hangingDownloadUntilAbort((tracker) => tracker.reportDownloadProgress(50_000, 1_000_000));

    const resultPromise = DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await resultPromise;

    expect(result).toMatchObject({ ok: false, phase: 'download' });
    expect(runSmoke).not.toHaveBeenCalled();
  });
});

describe('DEFAULT_SEAMS.runAttempt — progress-listener cleanup (finally semantics)', () => {
  let unsubscribeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    unsubscribeSpy = vi.fn();
    // Spy on subscribe but call through, so events still reach onProgressEvent
    // while we observe that the returned unsubscribe is invoked. We deliberately
    // capture the prototype method to re-invoke it with an explicit receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called via .call(this, …) below
    const realSubscribe = ProgressTracker.prototype.subscribe;
    vi.spyOn(ProgressTracker.prototype, 'subscribe').mockImplementation(function (
      this: ProgressTracker,
      handler,
    ) {
      const realUnsub = realSubscribe.call(this, handler);
      return () => {
        unsubscribeSpy();
        realUnsub();
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['download failure', () => {
      vi.mocked(downloadModel).mockRejectedValue(new Error('x'));
    }],
    ['smoke rejection', () => {
      downloadOk();
      vi.mocked(runSmoke).mockRejectedValue(new Error('x'));
    }],
    ['smoke not-passed', () => {
      downloadOk();
      vi.mocked(runSmoke).mockResolvedValue(failSmoke('x'));
    }],
    ['success', () => {
      downloadOk();
      vi.mocked(runSmoke).mockResolvedValue(passSmoke());
    }],
  ])('unsubscribes the progress listener on the %s path', async (_label, arrange) => {
    arrange();

    await DEFAULT_SEAMS.runAttempt(SLOT, MODEL, vi.fn());

    // Two listeners now: the RT-4 stall→abort subscriber and the progress
    // forwarder. Both must be released on every exit path.
    expect(unsubscribeSpy).toHaveBeenCalledTimes(2);
  });

  it('still unsubscribes if a progress handler throws (this is why it is a finally)', async () => {
    vi.mocked(downloadModel).mockRejectedValue(new Error('download boom'));
    const throwingHandler = vi.fn(() => {
      throw new Error('handler boom');
    });

    await expect(DEFAULT_SEAMS.runAttempt(SLOT, MODEL, throwingHandler)).rejects.toThrow('handler boom');
    // Both listeners (stall→abort + progress) released even when a handler throws.
    expect(unsubscribeSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── C5: cross-tab first-run download coordination (fail-open) ───────────────
//
// First-run historically took NO lease, so two tabs onboarding at once each
// pulled the same ~2GB weights. defaultRunAttempt now acquires the shared
// 'download' lease around the transfer — but it must FAIL OPEN: onboarding can
// never dead-end waiting on a lease, so a stuck/foreign holder just means we
// proceed unleased (worst case: today's rare double download).

const leaseHeldByOtherTab = (): LocalHeavyWorkAcquireResult => ({
  ok: false,
  active: { ownerId: 'other-tab', kind: 'download', startedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER },
  reason: 'busy',
});
const leaseGranted = (release: () => void): LocalHeavyWorkAcquireResult => ({
  ok: true,
  lease: { ownerId: 'me', kind: 'download', startedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER },
  release,
});

describe('acquireDownloadLeaseFailOpen — fail-open download coordination', () => {
  it('acquires immediately when the lease is free and hands back its release', async () => {
    const release = vi.fn();
    const acquire = vi.fn((_k: LocalHeavyWorkKind) => leaseGranted(release));

    const held = await acquireDownloadLeaseFailOpen(acquire);

    expect(acquire).toHaveBeenCalledWith('download');
    held.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits for a busy lease, then acquires it when it frees (the second tab cache-hits)', async () => {
    const release = vi.fn();
    let calls = 0;
    const acquire = vi.fn((_k: LocalHeavyWorkKind) =>
      ++calls < 3 ? leaseHeldByOtherTab() : leaseGranted(release),
    );

    const held = await acquireDownloadLeaseFailOpen(acquire, { waitMs: 1_000, pollMs: 1 });

    expect(calls).toBeGreaterThanOrEqual(3);
    held.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('FAILS OPEN with a no-op release when the lease stays busy past the budget', async () => {
    const acquire = vi.fn((_k: LocalHeavyWorkKind) => leaseHeldByOtherTab());

    const held = await acquireDownloadLeaseFailOpen(acquire, { waitMs: 20, pollMs: 5 });

    // Resolved (no hang) and its release is a safe no-op — first-run proceeds unleased.
    expect(acquire.mock.calls.length).toBeGreaterThan(1);
    expect(() => held.release()).not.toThrow();
  });

  it('fails open immediately, without acquiring, when the signal is already aborted', async () => {
    const acquire = vi.fn((_k: LocalHeavyWorkKind) => leaseGranted(vi.fn()));
    const controller = new AbortController();
    controller.abort();

    const held = await acquireDownloadLeaseFailOpen(acquire, { signal: controller.signal });

    expect(acquire).not.toHaveBeenCalled();
    expect(() => held.release()).not.toThrow();
  });

  it('fails open when the signal aborts mid-wait', async () => {
    const acquire = vi.fn((_k: LocalHeavyWorkKind) => leaseHeldByOtherTab());
    const controller = new AbortController();

    const promise = acquireDownloadLeaseFailOpen(acquire, {
      signal: controller.signal,
      waitMs: 10_000,
      pollMs: 20,
    });
    controller.abort();
    const held = await promise;

    expect(() => held.release()).not.toThrow();
  });
});

describe('defaultRunAttempt — download-lease integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('acquires the "download" lease, downloads once, and releases it on success', async () => {
    downloadOk();
    vi.mocked(runSmoke).mockResolvedValue(passSmoke());
    const release = vi.fn();
    const acquire = vi.fn((_k: LocalHeavyWorkKind) => leaseGranted(release));

    const result = await defaultRunAttempt(SLOT, MODEL, vi.fn(), acquire);

    expect(result).toEqual({ ok: true });
    expect(acquire).toHaveBeenCalledWith('download');
    expect(downloadModel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the download lease even when the download fails', async () => {
    vi.mocked(downloadModel).mockRejectedValue(new Error('network down'));
    const release = vi.fn();
    const acquire = vi.fn((_k: LocalHeavyWorkKind) => leaseGranted(release));

    const result = await defaultRunAttempt(SLOT, MODEL, vi.fn(), acquire);

    expect(result).toMatchObject({ ok: false, phase: 'download' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails open and still downloads exactly once when the lease is busy then frees', async () => {
    downloadOk();
    vi.mocked(runSmoke).mockResolvedValue(passSmoke());
    let calls = 0;
    const release = vi.fn();
    const acquire = vi.fn((_k: LocalHeavyWorkKind) =>
      ++calls < 2 ? leaseHeldByOtherTab() : leaseGranted(release),
    );

    const result = await defaultRunAttempt(SLOT, MODEL, vi.fn(), acquire);

    expect(result).toEqual({ ok: true });
    expect(downloadModel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
