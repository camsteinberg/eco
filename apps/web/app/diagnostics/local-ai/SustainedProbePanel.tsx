// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@eco/ui';
import type {
  SustainedProbeContextMode,
  SustainedProbeLevers,
  SustainedProbeRecord,
  SustainedProbeTurn,
} from '../../../src/local-ai/diagnostics/sustained-probe';
import type { SustainedProbeProgress } from '../../../src/local-ai/diagnostics/sustained-probe-runner';

// ─── Weights-download attempt log (devtools-less death-point diagnostics) ─────
//
// A compatibility-declined device (iPhone) has no devtools, and the WebKit tab
// is killed MID-DOWNLOAD of large weights — so the download's own progress is
// lost with the tab. We persist a single per-attempt record to localStorage as
// the download advances; if the tab dies, the next mount reads a `done:false`
// record and reports exactly where it stopped. The record is left in place
// (never cleared on read) until a later attempt overwrites it.

const WEIGHTS_ATTEMPT_KEY = 'eco-probe-weights-attempt-v1';

type WeightsAttempt = {
  modelId: string;
  startedAt: string;
  lastLoaded: number;
  total: number;
  done: boolean;
};

function readWeightsAttempt(): WeightsAttempt | null {
  try {
    const raw = localStorage.getItem(WEIGHTS_ATTEMPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WeightsAttempt>;
    if (typeof parsed?.modelId !== 'string' || typeof parsed.done !== 'boolean') return null;
    return {
      modelId: parsed.modelId,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      lastLoaded: typeof parsed.lastLoaded === 'number' ? parsed.lastLoaded : 0,
      total: typeof parsed.total === 'number' ? parsed.total : 0,
      done: parsed.done,
    };
  } catch {
    return null;
  }
}

function writeWeightsAttempt(attempt: WeightsAttempt): void {
  try {
    localStorage.setItem(WEIGHTS_ATTEMPT_KEY, JSON.stringify(attempt));
  } catch {
    // Best-effort diagnostics — a storage hiccup must never break the download.
  }
}

// ─── Static metadata (heavy imports are dynamic, inside handlers/effects) ─────

type PickerModel = { id: string; friendlyName: string };

const OUTCOME_STYLE: Record<SustainedProbeRecord['outcome'], { label: string; fg: string; bg: string }> = {
  completed: { label: 'Completed', fg: 'var(--eco-success, #2d5a3d)', bg: 'var(--eco-success-soft, rgba(45, 90, 61, 0.1))' },
  error: { label: 'Errored', fg: 'var(--eco-error, #c75c4a)', bg: 'var(--eco-error-soft, rgba(199, 92, 74, 0.12))' },
  killed: { label: 'Tab killed', fg: 'var(--eco-error, #c75c4a)', bg: 'var(--eco-error-soft, rgba(199, 92, 74, 0.12))' },
};

const CARD: CSSProperties = {
  border: '1px solid var(--eco-border-muted)',
  background: 'var(--eco-surface-elevated)',
};

const LABEL: CSSProperties = { color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' };
const MONO: CSSProperties = { fontFamily: 'var(--eco-font-mono)', color: 'var(--eco-text)' };

// ─── Component ────────────────────────────────────────────────────────────────

export function SustainedProbePanel() {
  const [pickerModels, setPickerModels] = useState<PickerModel[]>([]);
  const [modelId, setModelId] = useState('');
  // Turns and Tokens/turn hold free-typed text while the field is focused so a
  // partial value ("6" on the way to "64") is never clamped out from under the
  // user, and the field can be cleared. They are normalized on blur and clamped
  // again at run() so the probe always consumes an in-range number.
  const [turnsInput, setTurnsInput] = useState('6');
  const [contextMode, setContextMode] = useState<SustainedProbeContextMode>('growing');
  const [tokensInput, setTokensInput] = useState('200');
  const [running, setRunning] = useState(false);
  const [levers, setLevers] = useState<SustainedProbeLevers | null>(null);
  const [liveLine, setLiveLine] = useState<string | null>(null);
  const [liveTurns, setLiveTurns] = useState<SustainedProbeTurn[]>([]);
  const [records, setRecords] = useState<SustainedProbeRecord[]>([]);
  const [killedNote, setKilledNote] = useState<string | null>(null);
  // Weights staging: null = checking/unknown, false = missing, true = cached.
  // The probe run never downloads weights, and on compatibility-declined
  // devices (WebKit-mobile) the normal chat journey can't stage them either —
  // this panel's download affordance is the only on-ramp for those retests.
  const [weightsReady, setWeightsReady] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadLine, setDownloadLine] = useState<string | null>(null);
  // Set from a persisted `done:false` weights-download record — the on-device
  // report of where a previous (tab-killed) download stopped for the picked model.
  const [deathNote, setDeathNote] = useState<string | null>(null);
  // Live storage diagnosis line (quota/usage + per-model enumeration) — see
  // refreshStorageInfo.
  const [storageNote, setStorageNote] = useState<string | null>(null);
  // True after an insufficient-storage download failure: offer to free the
  // model's stranded bytes (parts from dead attempts) and retry — the
  // guaranteed unblock when the quota is half-full of unusable state.
  const [offerClearRetry, setOfferClearRetry] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  // The in-flight (or last) attempt record, mirrored here so the throttled
  // progress writer and the success/stop transitions extend the same row.
  const attemptRef = useRef<WeightsAttempt | null>(null);

  // Catalog models and eval-lane candidates resolve from different sets; the
  // probe and the weights download both need the same lookup.
  const resolveModel = useCallback(async (id: string) => {
    const { getModel } = await import('../../../src/local-ai/catalog/catalog');
    const { getEvalCandidateModel } = await import('../../../src/local-ai/eval/eval-candidates');
    return getModel(id) ?? getEvalCandidateModel(id);
  }, []);

  // Mount: recover an orphaned marker (tab-kill evidence), load levers + records,
  // and default the picker to the ready-slot model when one exists.
  useEffect(() => {
    void (async () => {
      const probe = await import('../../../src/local-ai/diagnostics/sustained-probe');
      const recovered = probe.recoverOrphanedMarker();
      if (recovered) {
        setKilledNote(
          `${recovered.error ?? `Previous sustained probe was killed at turn ${recovered.turnsCompleted}/${recovered.turnsRequested}.`} Recorded for the shared dump.`,
        );
      }
      setLevers(probe.readActiveLevers());
      setRecords(probe.loadSustainedProbes());

      try {
        const { getCatalog } = await import('../../../src/local-ai/catalog/catalog');
        const models = getCatalog()
          .filter((m) => m.artifact)
          .map((m) => ({ id: m.id, friendlyName: m.friendlyName }));

        // In the validation harness (dev-only), also offer the eval-lane
        // candidates so A-3 measurement cells (e.g. the q4 load-peak build) are
        // pickable. They are marked " (eval)" so they read as non-catalog; the
        // model config itself is never mutated.
        const { isValidationHarnessEnabled } = await import('../../../src/lib/validation-harness');
        if (isValidationHarnessEnabled()) {
          const { getEvalCandidateModels } = await import('../../../src/local-ai/eval/eval-candidates');
          const candidates = getEvalCandidateModels()
            .filter((m) => m.artifact)
            .map((m) => ({ id: m.id, friendlyName: `${m.friendlyName} (eval)` }));
          models.push(...candidates);
        }
        setPickerModels(models);

        const { SLOTS, getSlot } = await import('../../../src/local-ai/lifecycle/slots');
        const readySlot = SLOTS.map(getSlot).find((s) => s.status === 'ready' && s.modelId);
        setModelId(readySlot?.modelId ?? models[0]?.id ?? '');
      } catch {
        // Catalog unavailable — the picker just stays empty.
      }
    })();
  }, []);

  const onProgress = useCallback((progress: SustainedProbeProgress) => {
    switch (progress.phase) {
      case 'loading':
        setLiveLine('Loading model…');
        break;
      case 'turn-start':
        setLiveLine(`Turn ${progress.turn + 1}/${progress.turnsRequested} — generating…`);
        break;
      case 'turn-complete':
        setLiveTurns((prev) => [...prev, progress.record]);
        break;
      case 'done':
        setLiveLine(null);
        break;
      default:
        break;
    }
  }, []);

  // Weights state for the picked model, re-checked on every pick (and after a
  // download completes, which sets it directly).
  useEffect(() => {
    if (!modelId) {
      setWeightsReady(null);
      return;
    }
    let cancelled = false;
    setWeightsReady(null);
    void (async () => {
      try {
        const { bootstrapLocalAi } = await import('../../../src/local-ai/bootstrap');
        await bootstrapLocalAi();
        const model = await resolveModel(modelId);
        if (!model) {
          if (!cancelled) setWeightsReady(false);
          return;
        }
        const { areProbeWeightsCached } = await import('../../../src/local-ai/diagnostics/sustained-probe-runner');
        const ready = await areProbeWeightsCached(model);
        if (!cancelled) setWeightsReady(ready);
      } catch {
        if (!cancelled) setWeightsReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelId, resolveModel]);

  // Death-point report: surface a persisted `done:false` attempt for THIS model
  // — where a previous download stopped (most usefully after a WebKit tab-kill,
  // which leaves the record behind because the tab died before it could be
  // marked done). A death note is only meaningful while the weights are
  // genuinely missing, so it is gated on the resolved cache state: if the
  // weights are present (staged via any path), the note is suppressed AND the
  // stale record is resolved so it can never resurrect the banner.
  useEffect(() => {
    // Until the cache check resolves, say nothing — and clear any prior model's
    // note so it can't linger across a pick change.
    if (weightsReady === null) {
      setDeathNote(null);
      return;
    }
    const attempt = readWeightsAttempt();
    const matches = attempt !== null && !attempt.done && attempt.modelId === modelId;
    if (weightsReady === false && matches) {
      const mb = (n: number) => Math.round(n / (1024 * 1024));
      setDeathNote(
        `Previous weights download died at ${mb(attempt.lastLoaded)} of ${mb(attempt.total)} MB`
        + ' — resume continues from persisted chunks.',
      );
      return;
    }
    // Weights are present: resolve a stale death record so a non-probe download
    // path can't leave it to resurrect the banner forever.
    if (weightsReady === true && matches) {
      writeWeightsAttempt({ ...attempt, done: true });
    }
    setDeathNote(null);
  }, [modelId, weightsReady]);

  // Storage readout: quota/usage plus what enumeration actually sees for the
  // picked model. On a devtools-less device this line IS the diagnosis — a
  // quota half-full of parts that enumeration reports as zero entries is how
  // a broken cache.keys() (or evicted parts) shows itself after a tab kill.
  const refreshStorageInfo = useCallback(async (id: string) => {
    try {
      const mb = (n: number) => Math.round(n / (1024 * 1024));
      let quotaLine = 'estimate unavailable';
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        const { usage, quota } = await navigator.storage.estimate();
        if (typeof usage === 'number' && typeof quota === 'number') {
          quotaLine = `${mb(usage)} MB used of ${mb(quota)} MB site quota`;
        }
      }
      const { pickStorage } = await import('../../../src/local-ai/download/storage');
      const entries = await pickStorage().listForModel(id);
      const parts = entries.filter((e) => e.url.includes('.ecopart.'));
      const partBytes = parts.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0);
      setStorageNote(
        `Storage: ${quotaLine} · this model: ${entries.length} entries`
        + (parts.length > 0 ? ` (${parts.length} parts, ${mb(partBytes)} MB)` : ''),
      );
    } catch (err) {
      setStorageNote(`Storage: enumeration failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => {
    if (modelId) void refreshStorageInfo(modelId);
  }, [modelId, refreshStorageInfo]);

  const downloadWeights = useCallback(async () => {
    if (!modelId || downloading) return;
    setDownloading(true);
    setDownloadLine('Preparing download…');
    setDeathNote(null); // A fresh attempt supersedes any prior death report.
    setOfferClearRetry(false);
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    // Open a `done:false` attempt row up front: if the tab is killed before
    // completion, this is the record the next mount reports the death point from.
    const started: WeightsAttempt = {
      modelId,
      startedAt: new Date().toISOString(),
      lastLoaded: 0,
      total: 0,
      done: false,
    };
    attemptRef.current = started;
    writeWeightsAttempt(started);
    try {
      const { bootstrapLocalAi } = await import('../../../src/local-ai/bootstrap');
      await bootstrapLocalAi();
      const model = await resolveModel(modelId);
      if (!model) {
        setDownloadLine(`Model ${modelId} not found.`);
        return;
      }
      const { downloadModel } = await import('../../../src/local-ai/download/download');
      const { ProgressTracker } = await import('../../../src/local-ai/download/progress');
      const tracker = new ProgressTracker();
      const megabytes = (n: number) => Math.round(n / (1024 * 1024));
      const ONE_MB = 1024 * 1024;
      const unsubscribe = tracker.subscribe((event) => {
        if (event.kind === 'progress' && event.phase === 'downloading') {
          setDownloadLine(
            `Downloading… ${Math.round(event.percent * 100)}% (${megabytes(event.loaded)}/${megabytes(event.total)} MB)`,
          );
          // Throttle to ~1MB steps: localStorage writes are synchronous, and a
          // per-chunk write would churn the main thread on a 500MB+ download.
          const prev = attemptRef.current;
          if (prev && (event.loaded - prev.lastLoaded >= ONE_MB || event.loaded >= event.total)) {
            const next = { ...prev, lastLoaded: event.loaded, total: event.total };
            attemptRef.current = next;
            writeWeightsAttempt(next);
          }
        }
      });
      try {
        await downloadModel(model, { tracker, signal: controller.signal });
      } finally {
        unsubscribe();
      }
      setWeightsReady(true);
      setDownloadLine('Weights ready — run the probe.');
      // Completed cleanly — mark the row done so it is never reported as a death.
      const prev = attemptRef.current;
      if (prev) {
        const done = { ...prev, done: true };
        attemptRef.current = done;
        writeWeightsAttempt(done);
      }
    } catch (err) {
      // A genuine error (or abort) leaves the row `done:false` on purpose — only
      // an uninterrupted success or an explicit stop resolves it.
      setDownloadLine(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
      // Insufficient storage has a guaranteed unblock on this panel: stranded
      // bytes from dead attempts occupy quota the preflight can't always
      // credit — offer to free the model's storage and retry from clean.
      if (err instanceof Error && err.name === 'InsufficientStorageError') {
        setOfferClearRetry(true);
      }
    } finally {
      setDownloading(false);
      downloadAbortRef.current = null;
      if (modelId) void refreshStorageInfo(modelId);
    }
  }, [modelId, downloading, resolveModel, refreshStorageInfo]);

  // Free every byte the picked model holds (parts, manifests, whole files) and
  // start a fresh download. The nuclear-but-safe option when the quota is
  // occupied by state a dead attempt left behind: a fresh parts-native download
  // needs only 1× the file, so clean + retry always fits where resume can't.
  const clearAndRetry = useCallback(async () => {
    if (!modelId || downloading) return;
    setOfferClearRetry(false);
    setDownloadLine('Freeing this model’s storage…');
    try {
      const { pickStorage } = await import('../../../src/local-ai/download/storage');
      await pickStorage().clearModel(modelId);
      await refreshStorageInfo(modelId);
    } catch (err) {
      setDownloadLine(`Could not free storage: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await downloadWeights();
  }, [modelId, downloading, refreshStorageInfo, downloadWeights]);

  const stopDownload = useCallback(() => {
    downloadAbortRef.current?.abort();
    setDownloadLine('Stopping download…');
    // An explicit stop is a user choice, not a death — resolve the row so the
    // next mount doesn't misreport it as a tab-kill.
    const prev = attemptRef.current ?? readWeightsAttempt();
    if (prev) writeWeightsAttempt({ ...prev, done: true });
  }, []);

  const run = useCallback(async () => {
    if (!modelId) return;
    // Clamp the free-typed fields at run time (they may hold a partial or
    // out-of-range value the user never blurred out of) and commit the
    // normalized text back so the probe and the field agree.
    const turns = clampTurns(turnsInput);
    const tokensPerTurn = clampTokens(tokensInput);
    setTurnsInput(String(turns));
    setTokensInput(String(tokensPerTurn));
    setRunning(true);
    setLiveTurns([]);
    setKilledNote(null);
    setLiveLine('Preparing…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { bootstrapLocalAi } = await import('../../../src/local-ai/bootstrap');
      await bootstrapLocalAi();
      // Eval-lane candidates (harness-only picker entries, e.g. the A-3 q4 cell)
      // are not in the catalog; resolveModel checks the candidate lane too, so
      // the probe can actually load and measure them. loadModel takes a
      // ModelConfig directly.
      const model = await resolveModel(modelId);
      if (!model) {
        setLiveLine(`Model ${modelId} not found.`);
        return;
      }
      const { runSustainedProbe } = await import('../../../src/local-ai/diagnostics/sustained-probe-runner');
      await runSustainedProbe(
        { model, turns, targetTokensPerTurn: tokensPerTurn, contextMode },
        { onProgress, signal: controller.signal },
      );
      const probe = await import('../../../src/local-ai/diagnostics/sustained-probe');
      setRecords(probe.loadSustainedProbes());
    } catch (err) {
      setLiveLine(`Probe failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [modelId, turnsInput, tokensInput, contextMode, onProgress, resolveModel]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setLiveLine('Stopping after the current turn…');
  }, []);

  const clearRecords = useCallback(async () => {
    const probe = await import('../../../src/local-ai/diagnostics/sustained-probe');
    probe.clearSustainedProbes();
    setRecords([]);
  }, []);

  const leverHint = useMemo(() => describeLevers(levers), [levers]);

  return (
    <section className="mb-8 rounded-xl p-5" style={CARD} aria-label="Sustained memory probe">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide" style={LABEL}>
          Sustained probe
        </h2>
        <span className="text-xs" style={{ ...LABEL, fontFamily: 'var(--eco-font-mono)' }}>
          {leverHint}
        </span>
      </div>
      <p className="mb-4 text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
        Runs several sequential turns whose prompts build on each reply, sampling memory throughout, to
        reproduce the pressure the one-shot smoke misses. Results ride the Share JSON above.
      </p>

      {killedNote && (
        <div
          className="mb-4 rounded-lg px-3 py-2 text-sm"
          style={{ background: 'var(--eco-error-soft, rgba(199, 92, 74, 0.12))', color: 'var(--eco-error, #c75c4a)' }}
          role="status"
        >
          {killedNote}
        </div>
      )}

      {deathNote && (
        <div
          className="mb-4 rounded-lg px-3 py-2 text-sm"
          style={{ background: 'var(--eco-error-soft, rgba(199, 92, 74, 0.12))', color: 'var(--eco-error, #c75c4a)' }}
          role="status"
        >
          {deathNote}
        </div>
      )}

      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm" style={LABEL}>
          Model
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={running}
            className="rounded-lg px-2.5 py-1.5 text-sm"
            style={{ ...MONO, border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
          >
            {pickerModels.length === 0 && <option value="">No models</option>}
            {pickerModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.friendlyName}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm" style={LABEL}>
          Turns
          <input
            type="number"
            min={1}
            max={30}
            value={turnsInput}
            onChange={(e) => setTurnsInput(e.target.value)}
            onBlur={() => setTurnsInput(String(clampTurns(turnsInput)))}
            disabled={running}
            className="w-20 rounded-lg px-2.5 py-1.5 text-sm"
            style={{ ...MONO, border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm" style={LABEL}>
          Context
          <select
            value={contextMode}
            onChange={(e) => setContextMode(e.target.value as SustainedProbeContextMode)}
            disabled={running}
            className="rounded-lg px-2.5 py-1.5 text-sm"
            style={{ ...MONO, border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
          >
            <option value="growing">Growing (real chat)</option>
            <option value="fresh">Fresh each turn</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm" style={LABEL}>
          Tokens/turn
          <input
            type="number"
            min={16}
            max={512}
            value={tokensInput}
            onChange={(e) => setTokensInput(e.target.value)}
            onBlur={() => setTokensInput(String(clampTokens(tokensInput)))}
            disabled={running}
            className="w-24 rounded-lg px-2.5 py-1.5 text-sm"
            style={{ ...MONO, border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
          />
        </label>

        <div className="flex gap-2">
          <Button onClick={run} variant="primary" disabled={running || downloading || !modelId}>
            {running ? 'Running…' : 'Run probe'}
          </Button>
          {running && (
            <Button onClick={stop} variant="secondary">
              Stop
            </Button>
          )}
          {records.length > 0 && !running && (
            <Button onClick={clearRecords} variant="secondary">
              Clear results
            </Button>
          )}
        </div>
      </div>

      {/* Weights staging — the probe run itself never downloads weights, so a
          device the normal journey declines (WebKit-mobile) stages them here. */}
      {modelId && weightsReady === false && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm" style={LABEL} role="status">
            Weights for this model are not on this device.
          </span>
          {!downloading && (
            <Button onClick={downloadWeights} variant="secondary">
              Download weights
            </Button>
          )}
          {downloading && (
            <Button onClick={stopDownload} variant="secondary">
              Stop download
            </Button>
          )}
        </div>
      )}
      {downloadLine && (
        <p className="mb-4 text-sm" style={MONO} role="status">
          {downloadLine}
        </p>
      )}
      {offerClearRetry && !downloading && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm" style={LABEL}>
            Stranded bytes from an earlier attempt may be occupying the site quota.
          </span>
          <Button onClick={clearAndRetry} variant="secondary">
            Free this model’s storage and retry
          </Button>
        </div>
      )}
      {storageNote && (
        <p className="mb-4 text-xs" style={{ ...MONO, color: 'var(--eco-text-secondary)' }}>
          {storageNote}
        </p>
      )}
      {liveLine && (
        <p className="mb-4 text-sm" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)' }}>
          {liveLine}
        </p>
      )}

      {/* Live turn table for the in-flight run */}
      {liveTurns.length > 0 && running && (
        <TurnTable turns={liveTurns} caption="Live run" />
      )}

      {/* Completed / recovered records */}
      {records.length === 0 && !running ? (
        <p className="text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
          No probes yet. Pick a model, download its weights if this device doesn’t have them, then run.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {[...records].reverse().map((record, i) => (
            <RecordCard key={`${record.recordedAt}-${i}`} record={record} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Sub-views ────────────────────────────────────────────────────────────────

function RecordCard({ record }: { record: SustainedProbeRecord }) {
  const style = OUTCOME_STYLE[record.outcome];
  return (
    <div className="rounded-lg p-4" style={{ border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm" style={MONO}>
          {record.modelId}
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium"
          style={{ color: style.fg, background: style.bg }}
        >
          {style.label} · {record.turnsCompleted}/{record.turnsRequested}
        </span>
      </div>
      <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1 text-xs">
        <dt style={LABEL}>Backend</dt>
        <dd style={MONO}>{record.backend ?? '—'}</dd>
        <dt style={LABEL}>Context</dt>
        <dd style={MONO}>{record.contextMode ?? 'growing'}</dd>
        <dt style={LABEL}>Peak JS heap</dt>
        <dd style={MONO}>{record.peakUsedJSHeapMB != null ? `${record.peakUsedJSHeapMB} MB` : 'no heap API'}</dd>
        <dt style={LABEL}>Levers</dt>
        <dd style={MONO}>{describeLevers(record.levers)}</dd>
        <dt style={LABEL}>Isolated</dt>
        <dd style={MONO}>{String(record.crossOriginIsolated)}</dd>
        {record.error && (
          <>
            <dt style={LABEL}>Note</dt>
            <dd style={{ ...MONO, color: 'var(--eco-error, #c75c4a)' }}>{record.error}</dd>
          </>
        )}
      </dl>
      {record.turns.length > 0 && <TurnTable turns={record.turns} caption="Per turn" />}
    </div>
  );
}

function TurnTable({ turns, caption }: { turns: SustainedProbeTurn[]; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs" style={{ borderCollapse: 'collapse' }}>
        <caption className="mb-1 text-left text-xs" style={LABEL}>
          {caption}
        </caption>
        <thead>
          <tr style={{ color: 'var(--eco-text-secondary)' }}>
            {['#', 'Context', 'Out', 'tok/s', 'TTFT', 'Error'].map((h) => (
              <th key={h} className="py-1 pr-4 font-medium" style={{ fontFamily: 'var(--eco-font-body)' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={MONO}>
          {turns.map((t) => (
            <tr key={t.turn} style={{ borderTop: '1px solid var(--eco-border-muted)' }}>
              <td className="py-1 pr-4">{t.turn + 1}</td>
              <td className="py-1 pr-4">{t.cumulativeContextTokens ?? '—'}</td>
              <td className="py-1 pr-4">{t.completionTokens ?? '—'}</td>
              <td className="py-1 pr-4">{t.tokensPerSecond ?? '—'}</td>
              <td className="py-1 pr-4">{t.ttftMs != null ? `${t.ttftMs}ms` : '—'}</td>
              <td className="py-1 pr-4" style={{ color: t.error ? 'var(--eco-error, #c75c4a)' : undefined }}>
                {t.error ? 'yes' : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function describeLevers(levers: SustainedProbeLevers | null): string {
  if (!levers) return '';
  const parts: string[] = [];
  parts.push(`artifact=${levers.ortArtifact ?? 'default'}`);
  parts.push(`threads=${levers.numThreads ?? 'default'}`);
  if (levers.forceWasm) parts.push('wasm');
  // Session-option levers appear only when set — absence IS the signal
  // (stock ORT), and these are rare A-3 matrix knobs.
  if (levers.ortArena != null) parts.push(`arena=${levers.ortArena ? 'on' : 'off'}`);
  if (levers.ortMemPattern != null) parts.push(`mem-pattern=${levers.ortMemPattern ? 'on' : 'off'}`);
  if (levers.ortGraphOpt != null) parts.push(`graph-opt=${levers.ortGraphOpt}`);
  return parts.join(' · ');
}

function clampTurns(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(30, Math.floor(n)));
}

function clampTokens(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 200;
  return Math.max(16, Math.min(512, Math.floor(n)));
}
