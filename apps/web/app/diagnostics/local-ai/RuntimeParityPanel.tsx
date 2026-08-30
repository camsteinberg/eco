// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@eco/ui';
import type {
  ParityVerdict,
  PromptComparison,
  RuntimeParityRecord,
} from '../../../src/local-ai/diagnostics/runtime-parity';
import type {
  ParityArm,
  RuntimeParityProgress,
} from '../../../src/local-ai/diagnostics/runtime-parity-runner';

type PickerModel = { id: string; friendlyName: string; runtime: string };

const CARD: CSSProperties = {
  border: '1px solid var(--eco-border-muted)',
  background: 'var(--eco-surface-elevated)',
};
const LABEL: CSSProperties = { color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' };
const MONO: CSSProperties = { fontFamily: 'var(--eco-font-mono)', color: 'var(--eco-text)' };

const VERDICT_STYLE: Record<ParityVerdict, { label: string; fg: string; bg: string }> = {
  consistent: {
    label: 'Runtimes agree',
    fg: 'var(--eco-success)',
    bg: 'var(--eco-success-soft)',
  },
  divergent: {
    label: 'Outputs diverge',
    fg: 'var(--eco-warning)',
    bg: 'var(--eco-warning-soft)',
  },
  degenerate: {
    label: 'Degenerate output detected',
    fg: 'var(--eco-error)',
    bg: 'var(--eco-error-soft)',
  },
};

const ARM_LABEL: Record<ParityArm, string> = {
  'runtime-a': 'Runtime A',
  'runtime-b': 'Runtime B',
  'wasm-baseline': 'WASM baseline',
};

function fmt(value: number): string {
  return value.toFixed(3);
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function RuntimeParityPanel() {
  const [pickerModels, setPickerModels] = useState<PickerModel[]>([]);
  const [modelIdA, setModelIdA] = useState('');
  const [modelIdB, setModelIdB] = useState('');
  const [includeWasm, setIncludeWasm] = useState(false);
  const [running, setRunning] = useState(false);
  const [liveLine, setLiveLine] = useState<string | null>(null);
  const [records, setRecords] = useState<RuntimeParityRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Mount: load prior records and populate the model picker.
  useEffect(() => {
    void (async () => {
      const store = await import('../../../src/local-ai/diagnostics/runtime-parity');
      setRecords(store.loadRuntimeParityRecords());

      try {
        const { getCatalog } = await import('../../../src/local-ai/catalog/catalog');
        const { getEvalCandidateModels } = await import(
          '../../../src/local-ai/eval/eval-candidates'
        );
        // Accept all runtimes — the whole point of this lane is cross-runtime.
        const models = [...getCatalog(), ...getEvalCandidateModels()]
          .filter((m) => m.artifact)
          .map((m) => ({ id: m.id, friendlyName: m.friendlyName, runtime: m.runtime }));
        // Deduplicate by id.
        const seen = new Set<string>();
        const deduped = models.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        setPickerModels(deduped);
        if (deduped.length >= 2) {
          setModelIdA(deduped[0]!.id);
          setModelIdB(deduped[1]!.id);
        } else if (deduped.length === 1) {
          setModelIdA(deduped[0]!.id);
        }
      } catch {
        // Catalog unavailable — the picker stays empty.
      }
    })();
  }, []);

  const onProgress = useCallback((progress: RuntimeParityProgress) => {
    switch (progress.phase) {
      case 'loading':
        setLiveLine(`Loading ${ARM_LABEL[progress.arm]}…`);
        break;
      case 'generating':
        setLiveLine(
          `${ARM_LABEL[progress.arm]}: generating prompt ${progress.promptIndex + 1}/${progress.promptCount}…`,
        );
        break;
      case 'prompt-complete':
        setLiveLine(
          `${ARM_LABEL[progress.arm]}: prompt ${progress.promptIndex + 1}/${progress.promptCount} done (${fmtMs(progress.ms)})`,
        );
        break;
      case 'arm-complete':
        setLiveLine(`${ARM_LABEL[progress.arm]} finished in ${fmtMs(progress.totalMs)}.`);
        break;
      case 'done':
        setLiveLine(null);
        break;
      default:
        break;
    }
  }, []);

  const run = useCallback(async () => {
    if (!modelIdA || !modelIdB) return;
    setRunning(true);
    setLiveLine('Preparing…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { bootstrapLocalAi } = await import('../../../src/local-ai/bootstrap');
      await bootstrapLocalAi();
      const { getCatalog } = await import('../../../src/local-ai/catalog/catalog');
      const { getEvalCandidateModels } = await import(
        '../../../src/local-ai/eval/eval-candidates'
      );
      // Build a flat list of all known models (catalog + eval candidates).
      const allModels = [...getCatalog(), ...getEvalCandidateModels()];
      const modelA = allModels.find((m) => m.id === modelIdA) ?? null;
      const modelB = allModels.find((m) => m.id === modelIdB) ?? null;
      if (!modelA) {
        setLiveLine(`Model A (${modelIdA}) not found.`);
        return;
      }
      if (!modelB) {
        setLiveLine(`Model B (${modelIdB}) not found.`);
        return;
      }
      const { runRuntimeParity } = await import(
        '../../../src/local-ai/diagnostics/runtime-parity-runner'
      );
      await runRuntimeParity(
        { modelA, modelB, includeWasmBaseline: includeWasm },
        { onProgress, signal: controller.signal },
      );
      const store = await import('../../../src/local-ai/diagnostics/runtime-parity');
      setRecords(store.loadRuntimeParityRecords());
    } catch (err) {
      setLiveLine(`Parity check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [modelIdA, modelIdB, includeWasm, onProgress]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setLiveLine('Stopping after the current prompt…');
  }, []);

  const clearRecords = useCallback(async () => {
    const store = await import('../../../src/local-ai/diagnostics/runtime-parity');
    store.clearRuntimeParityRecords();
    setRecords([]);
  }, []);

  const exportJson = useCallback(async () => {
    const store = await import('../../../src/local-ai/diagnostics/runtime-parity');
    const data = store.exportRuntimeParity();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `runtime-parity-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <section className="mb-8 rounded-xl p-5" style={CARD} aria-label="Runtime parity">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide" style={LABEL}>
        Runtime parity
      </h2>
      <p className="mb-4 text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
        Generates the same 12 fixed prompts on two different runtimes (e.g. Transformers.js and
        WebLLM) and scores whether the outputs are consistent. Unlike the backend cross-check
        (WebGPU vs WASM within one runtime), this compares across entirely different inference
        engines. Weights must already be downloaded for both models.
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm" style={LABEL}>
          Model A
          <select
            value={modelIdA}
            onChange={(e) => setModelIdA(e.target.value)}
            disabled={running}
            className="rounded-lg px-2.5 py-1.5 text-sm"
            style={{ ...MONO, border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
          >
            {pickerModels.length === 0 && <option value="">No models</option>}
            {pickerModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.friendlyName} ({m.runtime})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm" style={LABEL}>
          Model B
          <select
            value={modelIdB}
            onChange={(e) => setModelIdB(e.target.value)}
            disabled={running}
            className="rounded-lg px-2.5 py-1.5 text-sm"
            style={{ ...MONO, border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
          >
            {pickerModels.length === 0 && <option value="">No models</option>}
            {pickerModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.friendlyName} ({m.runtime})
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm" style={LABEL}>
          <input
            type="checkbox"
            checked={includeWasm}
            onChange={(e) => setIncludeWasm(e.target.checked)}
            disabled={running}
          />
          WASM baseline (slow)
        </label>
      </div>

      <div className="mb-4 flex gap-2">
        <Button onClick={run} disabled={running || !modelIdA || !modelIdB}>
          {running ? 'Running…' : 'Run parity check'}
        </Button>
        {running && (
          <Button onClick={stop} variant="secondary">
            Stop
          </Button>
        )}
        {records.length > 0 && !running && (
          <>
            <Button onClick={exportJson} variant="secondary">
              Export JSON
            </Button>
            <Button onClick={clearRecords} variant="secondary">
              Clear results
            </Button>
          </>
        )}
      </div>

      {liveLine && (
        <p className="mb-4 text-sm" style={{ ...MONO, color: 'var(--eco-text-secondary)' }} role="status">
          {liveLine}
        </p>
      )}

      {records.length === 0 && !running ? (
        <p className="text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
          No parity checks yet. Pick two models whose weights are already downloaded, then run.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {[...records].reverse().map((record, i) => (
            <ParityRecordCard key={`${record.recordedAt}-${i}`} record={record} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Sub-views ────────────────────────────────────────────────────────────

function ParityRecordCard({ record }: { record: RuntimeParityRecord }) {
  const style = record.verdict ? VERDICT_STYLE[record.verdict] : null;
  return (
    <div
      className="rounded-lg p-4"
      style={{ border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm" style={MONO}>
          {record.modelIdA} vs {record.modelIdB}
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium"
          style={
            style
              ? { color: style.fg, background: style.bg }
              : { color: 'var(--eco-error)', background: 'var(--eco-error-soft)' }
          }
        >
          {style ? style.label : 'Did not run'}
        </span>
      </div>

      {record.summary && (
        <p className="mb-3 text-sm" style={{ color: 'var(--eco-text)' }}>
          {record.summary}
        </p>
      )}
      {record.error && (
        <p className="mb-3 text-sm" style={{ color: 'var(--eco-error)' }}>
          {record.error}
        </p>
      )}

      <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1 text-xs">
        <dt style={LABEL}>Generation time</dt>
        <dd style={MONO}>
          A: {fmtMs(record.timings.runtimeAMs)} · B: {fmtMs(record.timings.runtimeBMs)}
          {record.includesWasmBaseline && <> · WASM: {fmtMs(record.timings.wasmBaselineMs)}</>}
        </dd>
        {record.result && (
          <>
            <dt style={LABEL}>Mean token overlap</dt>
            <dd style={MONO}>{fmt(record.result.meanTokenOverlap)}</dd>
            <dt style={LABEL}>Degenerate prompts</dt>
            <dd style={MONO}>
              {record.result.degenerateCount} / {record.result.comparisons.length}
            </dd>
          </>
        )}
        {record.wasmBaseline && (
          <>
            <dt style={LABEL}>WASM baseline overlap</dt>
            <dd style={MONO}>{fmt(record.wasmBaseline.meanTokenOverlap)}</dd>
          </>
        )}
      </dl>

      {record.result && (
        <ComparisonTable comparisons={record.result.comparisons} labelA="A" labelB="B" />
      )}
      {record.wasmBaseline && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs" style={LABEL}>
            WASM baseline comparisons
          </summary>
          <div className="mt-2">
            <ComparisonTable
              comparisons={record.wasmBaseline.comparisons}
              labelA="A (WebGPU)"
              labelB="A (WASM)"
            />
          </div>
        </details>
      )}
    </div>
  );
}

function ComparisonTable({
  comparisons,
  labelA,
  labelB,
}: {
  comparisons: readonly PromptComparison[];
  labelA: string;
  labelB: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="py-1 text-left font-normal" style={LABEL} scope="col">Prompt</th>
            <th className="py-1 text-left font-normal" style={LABEL} scope="col">Category</th>
            <th className="py-1 text-right font-normal" style={LABEL} scope="col">Overlap</th>
            <th className="py-1 text-right font-normal" style={LABEL} scope="col">Len ratio</th>
            <th className="py-1 text-center font-normal" style={LABEL} scope="col">Degen</th>
            <th className="py-1 text-left font-normal" style={LABEL} scope="col">{labelA} output</th>
            <th className="py-1 text-left font-normal" style={LABEL} scope="col">{labelB} output</th>
          </tr>
        </thead>
        <tbody>
          {comparisons.map((c) => (
            <tr key={c.promptId} style={{ borderTop: '1px solid var(--eco-border-muted)' }}>
              <td className="py-1" style={MONO}>{c.promptId}</td>
              <td className="py-1" style={MONO}>{c.category}</td>
              <td className="py-1 text-right" style={MONO}>{fmt(c.similarity.tokenOverlap)}</td>
              <td className="py-1 text-right" style={MONO}>{fmt(c.similarity.lengthRatio)}</td>
              <td className="py-1 text-center" style={MONO}>
                {c.anyDegenerate ? (
                  <span style={{ color: 'var(--eco-error)' }}>yes</span>
                ) : (
                  <span style={{ color: 'var(--eco-text-secondary)' }}>no</span>
                )}
              </td>
              <td className="max-w-48 truncate py-1" style={MONO} title={c.outputA}>
                {c.outputA.slice(0, 80) || '(empty)'}
              </td>
              <td className="max-w-48 truncate py-1" style={MONO} title={c.outputB}>
                {c.outputB.slice(0, 80) || '(empty)'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
