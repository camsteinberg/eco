// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@eco/ui';
import type {
  SustainedProbeLevers,
  SustainedProbeRecord,
  SustainedProbeTurn,
} from '../../../src/local-ai/diagnostics/sustained-probe';
import type { SustainedProbeProgress } from '../../../src/local-ai/diagnostics/sustained-probe-runner';

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
  const [turns, setTurns] = useState(6);
  const [running, setRunning] = useState(false);
  const [levers, setLevers] = useState<SustainedProbeLevers | null>(null);
  const [liveLine, setLiveLine] = useState<string | null>(null);
  const [liveTurns, setLiveTurns] = useState<SustainedProbeTurn[]>([]);
  const [records, setRecords] = useState<SustainedProbeRecord[]>([]);
  const [killedNote, setKilledNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Mount: recover an orphaned marker (tab-kill evidence), load levers + records,
  // and default the picker to the ready-slot model when one exists.
  useEffect(() => {
    void (async () => {
      const probe = await import('../../../src/local-ai/diagnostics/sustained-probe');
      const recovered = probe.recoverOrphanedMarker();
      if (recovered) {
        setKilledNote(
          `Previous sustained probe was killed at turn ${recovered.turnsCompleted}/${recovered.turnsRequested}. Recorded for the shared dump.`,
        );
      }
      setLevers(probe.readActiveLevers());
      setRecords(probe.loadSustainedProbes());

      try {
        const { getCatalog } = await import('../../../src/local-ai/catalog/catalog');
        const models = getCatalog()
          .filter((m) => m.artifact)
          .map((m) => ({ id: m.id, friendlyName: m.friendlyName }));
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

  const run = useCallback(async () => {
    if (!modelId) return;
    setRunning(true);
    setLiveTurns([]);
    setKilledNote(null);
    setLiveLine('Preparing…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { bootstrapLocalAi } = await import('../../../src/local-ai/bootstrap');
      await bootstrapLocalAi();
      const { getModel } = await import('../../../src/local-ai/catalog/catalog');
      const model = getModel(modelId);
      if (!model) {
        setLiveLine(`Model ${modelId} not found in catalog.`);
        return;
      }
      const { runSustainedProbe } = await import('../../../src/local-ai/diagnostics/sustained-probe-runner');
      await runSustainedProbe({ model, turns }, { onProgress, signal: controller.signal });
      const probe = await import('../../../src/local-ai/diagnostics/sustained-probe');
      setRecords(probe.loadSustainedProbes());
    } catch (err) {
      setLiveLine(`Probe failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [modelId, turns, onProgress]);

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
            value={turns}
            onChange={(e) => setTurns(clampTurns(e.target.value))}
            disabled={running}
            className="w-20 rounded-lg px-2.5 py-1.5 text-sm"
            style={{ ...MONO, border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
          />
        </label>

        <div className="flex gap-2">
          <Button onClick={run} variant="primary" disabled={running || !modelId}>
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
          No probes yet. Pick a model that is already downloaded, then run.
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
  return parts.join(' · ');
}

function clampTurns(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(30, Math.floor(n)));
}
