// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@eco/ui';
import type {
  BackendCrossCheckRecord,
  CrossCheckSimilarity,
  RunVerdict,
} from '../../../src/local-ai/diagnostics/backend-crosscheck';
import type {
  BackendCrossCheckProgress,
  CrossCheckArm,
} from '../../../src/local-ai/diagnostics/backend-crosscheck-runner';

type PickerModel = { id: string; friendlyName: string };

const CARD: CSSProperties = {
  border: '1px solid var(--eco-border-muted)',
  background: 'var(--eco-surface-elevated)',
};
const LABEL: CSSProperties = { color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' };
const MONO: CSSProperties = { fontFamily: 'var(--eco-font-mono)', color: 'var(--eco-text)' };

/**
 * Each verdict gets a plain-language headline. The panel's job is to answer one
 * question — "is WebGPU quietly producing garbage for this model?" — so the
 * verdict says the answer in words and the numbers sit underneath as evidence.
 */
const VERDICT_STYLE: Record<RunVerdict, { label: string; fg: string; bg: string }> = {
  consistent: {
    label: 'Backends agree',
    fg: 'var(--eco-success)',
    bg: 'var(--eco-success-soft)',
  },
  divergent: {
    label: 'Outputs differ — read both',
    fg: 'var(--eco-warning)',
    bg: 'var(--eco-warning-soft)',
  },
  'backend-garbage': {
    label: 'WebGPU output is garbage',
    fg: 'var(--eco-error)',
    bg: 'var(--eco-error-soft)',
  },
  'reference-degenerate': {
    label: 'WASM reference unusable',
    fg: 'var(--eco-warning)',
    bg: 'var(--eco-warning-soft)',
  },
  inconclusive: {
    label: 'Inconclusive',
    fg: 'var(--eco-text-secondary)',
    bg: 'var(--eco-surface)',
  },
};

const ARM_LABEL: Record<CrossCheckArm, string> = {
  webgpu: 'WebGPU',
  'webgpu-repeat': 'WebGPU (repeat)',
  wasm: 'WASM',
};

function fmt(value: number): string {
  return value.toFixed(3);
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function BackendCrossCheckPanel() {
  const [pickerModels, setPickerModels] = useState<PickerModel[]>([]);
  const [modelId, setModelId] = useState('');
  const [running, setRunning] = useState(false);
  const [liveLine, setLiveLine] = useState<string | null>(null);
  const [records, setRecords] = useState<BackendCrossCheckRecord[]>([]);
  // Armed by ?eco-crosscheck-autorun=1 — fires run() once, so the whole cell can
  // be described in a URL for a scripted browser session.
  const [autorunArmed, setAutorunArmed] = useState(false);
  const autorunFiredRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Mount: load prior records and offer only the models this check can serve.
  useEffect(() => {
    void (async () => {
      const store = await import('../../../src/local-ai/diagnostics/backend-crosscheck');
      setRecords(store.loadBackendCrossChecks());

      try {
        const { getCatalog } = await import('../../../src/local-ai/catalog/catalog');
        // Transformers.js only: it is the one runtime that can serve the same
        // weights on both backends. Offering a LiteRT or WebLLM model here would
        // only ever produce a refusal.
        const models = getCatalog()
          .filter((m) => m.artifact && m.runtime === 'transformers')
          .map((m) => ({ id: m.id, friendlyName: m.friendlyName }));
        setPickerModels(models);
        setModelId(models[0]?.id ?? '');

        if (typeof window !== 'undefined') {
          const params = new URLSearchParams(window.location.search);
          const wanted = params.get('eco-crosscheck-model');
          if (wanted && models.some((m) => m.id === wanted)) setModelId(wanted);
          if (params.get('eco-crosscheck-autorun') === '1') setAutorunArmed(true);
        }
      } catch {
        // Catalog unavailable — the picker just stays empty.
      }
    })();
  }, []);

  const onProgress = useCallback((progress: BackendCrossCheckProgress) => {
    switch (progress.phase) {
      case 'loading':
        setLiveLine(`Loading the model on ${ARM_LABEL[progress.arm]}…`);
        break;
      case 'generating':
        setLiveLine(`Generating on ${ARM_LABEL[progress.arm]}… (the WASM arm takes minutes)`);
        break;
      case 'arm-complete':
        setLiveLine(`${ARM_LABEL[progress.arm]} finished on ${progress.backend ?? 'unknown'} in ${fmtMs(progress.ms)}.`);
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
    setLiveLine('Preparing…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { bootstrapLocalAi } = await import('../../../src/local-ai/bootstrap');
      await bootstrapLocalAi();
      const { getModel } = await import('../../../src/local-ai/catalog/catalog');
      const model = getModel(modelId);
      if (!model) {
        setLiveLine(`Model ${modelId} not found.`);
        return;
      }
      const { runBackendCrossCheck } = await import(
        '../../../src/local-ai/diagnostics/backend-crosscheck-runner'
      );
      await runBackendCrossCheck({ model }, { onProgress, signal: controller.signal });
      const store = await import('../../../src/local-ai/diagnostics/backend-crosscheck');
      setRecords(store.loadBackendCrossChecks());
    } catch (err) {
      setLiveLine(`Cross-check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [modelId, onProgress]);

  useEffect(() => {
    if (autorunArmed && modelId && !running && !autorunFiredRef.current) {
      autorunFiredRef.current = true;
      void run();
    }
  }, [autorunArmed, modelId, running, run]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setLiveLine('Stopping after the current arm…');
  }, []);

  const clearRecords = useCallback(async () => {
    const store = await import('../../../src/local-ai/diagnostics/backend-crosscheck');
    store.clearBackendCrossChecks();
    setRecords([]);
  }, []);

  return (
    <section className="mb-8 rounded-xl p-5" style={CARD} aria-label="Backend cross-check">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide" style={LABEL}>
        Backend cross-check
      </h2>
      <p className="mb-4 text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
        Generates the same fixed prompt on WebGPU and on WASM and compares the two, to catch a
        quantized model that decodes into garbage on WebGPU while the identical files decode fine on
        WASM. The smoke check only times generation, so it cannot see this. Transformers.js models
        only, weights must already be downloaded, and the WASM arm takes minutes — this is a
        diagnostics tool, not something users ever wait on.
      </p>

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

        <div className="flex gap-2">
          <Button onClick={run} disabled={running || !modelId}>
            {running ? 'Running…' : 'Run cross-check'}
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
        <p className="mb-4 text-sm" style={{ ...MONO, color: 'var(--eco-text-secondary)' }} role="status">
          {liveLine}
        </p>
      )}

      {records.length === 0 && !running ? (
        <p className="text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
          No cross-checks yet. Pick a model whose weights are already downloaded, then run.
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

// ─── Sub-views ───────────────────────────────────────────────────────────────

function RecordCard({ record }: { record: BackendCrossCheckRecord }) {
  const style = record.verdict ? VERDICT_STYLE[record.verdict] : null;
  return (
    <div
      className="rounded-lg p-4"
      style={{ border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm" style={MONO}>
          {record.modelId}
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
        <dt style={LABEL}>Backends</dt>
        <dd style={MONO}>
          {record.webgpuBackend ?? '—'} vs {record.wasmBackend ?? '—'}
        </dd>
        <dt style={LABEL}>Generation time</dt>
        <dd style={MONO}>
          WebGPU {fmtMs(record.timings.webgpuMs)} · repeat {fmtMs(record.timings.webgpuRepeatMs)} · WASM{' '}
          {fmtMs(record.timings.wasmMs)}
        </dd>
        <dt style={LABEL}>Prompt</dt>
        <dd style={MONO}>{record.prompt}</dd>
      </dl>

      {record.noiseFloor && record.cross && (
        <SimilarityTable noiseFloor={record.noiseFloor} cross={record.cross.similarity} />
      )}

      {record.outcome === 'completed' && (
        <div className="mt-3 flex flex-col gap-2">
          <OutputBlock label="WebGPU" text={record.outputs.webgpu} />
          <OutputBlock label="WebGPU (repeat)" text={record.outputs.webgpuRepeat} />
          <OutputBlock label="WASM (reference)" text={record.outputs.wasm} />
        </div>
      )}
    </div>
  );
}

/**
 * The two pairs share one table on purpose: the same-backend column is the
 * control that makes the cross-backend column mean anything, and putting them
 * side by side is the whole argument the panel makes.
 */
function SimilarityTable({
  noiseFloor,
  cross,
}: {
  noiseFloor: CrossCheckSimilarity;
  cross: CrossCheckSimilarity;
}) {
  const rows: [string, number, number][] = [
    ['Token overlap', noiseFloor.tokenOverlap, cross.tokenOverlap],
    ['Length ratio', noiseFloor.lengthRatio, cross.lengthRatio],
    ['Shared prefix (tokens)', noiseFloor.sharedPrefixTokens, cross.sharedPrefixTokens],
    ['Longest shared run', noiseFloor.longestCommonSpan, cross.longestCommonSpan],
  ];
  return (
    <table className="w-full text-xs">
      <caption className="mb-1 text-left text-xs" style={LABEL}>
        Same backend twice (the noise floor) against WebGPU vs WASM
      </caption>
      <thead>
        <tr>
          <th className="py-1 text-left font-normal" style={LABEL} scope="col">
            Measure
          </th>
          <th className="py-1 text-right font-normal" style={LABEL} scope="col">
            WebGPU vs WebGPU
          </th>
          <th className="py-1 text-right font-normal" style={LABEL} scope="col">
            WebGPU vs WASM
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, floor, crossValue]) => (
          <tr key={label} style={{ borderTop: '1px solid var(--eco-border-muted)' }}>
            <th className="py-1 text-left font-normal" style={LABEL} scope="row">
              {label}
            </th>
            <td className="py-1 text-right" style={MONO}>
              {Number.isInteger(floor) ? floor : fmt(floor)}
            </td>
            <td className="py-1 text-right" style={MONO}>
              {Number.isInteger(crossValue) ? crossValue : fmt(crossValue)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OutputBlock({ label, text }: { label: string; text: string }) {
  return (
    <details>
      <summary className="cursor-pointer text-xs" style={LABEL}>
        {label} — {text.trim().split(/\s+/).filter(Boolean).length} tokens
      </summary>
      <pre
        className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-2 text-xs"
        style={{ ...MONO, background: 'var(--eco-surface-elevated)', border: '1px solid var(--eco-border-muted)' }}
      >
        {text || '(empty)'}
      </pre>
    </details>
  );
}
