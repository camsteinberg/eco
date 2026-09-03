// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ModelScorecard,
  RubricScores,
  Scorecard,
  ScorecardDiff,
} from '../../../src/local-ai/eval/types';

// ─── Presentational scorecard surfaces ───────────────────────────────────────
//
// Pure rendering for the eval-harness panel: the per-run scorecard, the
// before→after diff, and the A/B model compare. State + orchestration live in
// EvalHarnessPanel; this file is data-in, table-out (no eval imports — types
// only). Design tokens throughout.

/** Head-to-head compare result (shape of aggregate.compareModels). */
export type AbResult = {
  a: ModelScorecard;
  b: ModelScorecard;
  dimensionDeltas: Partial<Record<keyof RubricScores, number | null>>;
  compositeDelta: number;
};

/** Short, human labels for the automated rubric dims, in scorecard order. */
const AUTOMATED_DIM_LABELS: { key: keyof RubricScores; label: string }[] = [
  { key: 'correctStop', label: 'Stops' },
  { key: 'noRepetition', label: 'No repeat' },
  { key: 'noThinkLeakage', label: 'No <think>' },
  { key: 'noCjkLeak', label: 'No CJK leak' },
  { key: 'exactness', label: 'Exact' },
  { key: 'answerDepth', label: 'Depth' },
];

/** Dims surfaced in the compact diff / A-B views (decision-relevant + composite-feeding). */
const KEY_DIFF_DIMS: { key: keyof RubricScores; label: string }[] = [
  { key: 'exactness', label: 'Exact' },
  { key: 'answerDepth', label: 'Depth' },
  { key: 'noCjkLeak', label: 'No CJK' },
  { key: 'noThinkLeakage', label: 'No <think>' },
  { key: 'correctStop', label: 'Stops' },
  { key: 'coherence', label: 'Coherence' },
  { key: 'taskFit', label: 'Task fit' },
];

// ─── Shared bits ─────────────────────────────────────────────────────────────

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <p
      className="mt-4 rounded-lg p-5 text-center text-sm"
      style={{ color: 'var(--eco-text-muted)', border: '1px dashed var(--eco-border-muted)' }}
    >
      {children}
    </p>
  );
}

export function ScorecardMeta({ scorecard }: { scorecard: Scorecard }) {
  const topology = scorecard.config?.messageTopology ?? 'legacy-topology';
  const config = scorecard.config
    ? ` · ${topology} · ${scorecard.config.samplingMode} · n=${String(scorecard.config.samplesPerProbe)} · prompts=${String(scorecard.config.promptCount)} · ${scorecard.config.promptSetHash}`
    : '';
  return (
    <p className="mb-3 text-xs" style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)' }}>
      {scorecard.label} · {scorecard.runId} · {scorecard.device.deviceClass} ·{' '}
      {scorecard.device.browserClass} · {scorecard.device.webgpuSupport}
      {config}
    </p>
  );
}

// ─── Scorecard table ─────────────────────────────────────────────────────────

/**
 * Scorecard table.
 *
 * IA: the primary row keeps the at-a-glance metrics legible (composite, the perf
 * trio, the two judge averages). The 11 automated rubric dims would blow the
 * column budget, so they live in an expandable detail row revealed per model —
 * full rubric one click away, default view scannable.
 */
export function ScorecardTable({ scorecard }: { scorecard: Scorecard }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (scorecard.models.length === 0) {
    return <EmptyHint>This run has no model results.</EmptyHint>;
  }

  return (
    <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--eco-border-muted)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--eco-surface)' }}>
            <Th>Model</Th>
            <Th align="right">Composite</Th>
            <Th align="right">TTFT</Th>
            <Th align="right">tok/s</Th>
            <Th align="right">Smoke</Th>
            <Th align="right">Coherence</Th>
            <Th align="right">Task fit</Th>
            <Th align="right">Details</Th>
          </tr>
        </thead>
        <tbody>
          {scorecard.models.map((m, i) => {
            const open = expanded.has(m.modelId);
            return (
              <Fragment key={m.modelId}>
                <tr style={{ borderTop: i > 0 ? '1px solid var(--eco-border-muted)' : undefined }}>
                  <Td>
                    <span className="block" style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.78rem' }}>
                      {m.modelId}
                    </span>
                    <span className="block text-xs" style={{ color: 'var(--eco-text-muted)' }}>
                      {m.runtimeAdapter} · {m.promptCount} results
                    </span>
                  </Td>
                  <Td align="right">
                    <ScoreWithSpread value={m.compositeScore} spread={m.compositeStdDev} />
                  </Td>
                  <Td align="right" mono>{fmtMs(m.perf.medianTtftMs)}</Td>
                  <Td align="right" mono>{fmtNum(m.perf.medianTokensPerSec, 1)}</Td>
                  <Td align="right" mono>{fmtPct(m.perf.smokePassRate)}</Td>
                  <Td align="right" mono>{fmtNum(m.judgeAverages.coherence, 2)}</Td>
                  <Td align="right" mono>{fmtNum(m.judgeAverages.taskFit, 2)}</Td>
                  <Td align="right">
                    <button
                      type="button"
                      onClick={() => { toggle(m.modelId); }}
                      className="text-xs underline-offset-2 hover:underline"
                      style={{ color: 'var(--eco-primary)' }}
                      aria-expanded={open}
                    >
                      {open ? 'Hide rubric' : '11 dims'}
                    </button>
                  </Td>
                </tr>
                {open && (
                  <tr style={{ background: 'var(--eco-surface)' }}>
                    <td colSpan={8} className="px-4 py-3">
                      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 lg:grid-cols-5">
                        {AUTOMATED_DIM_LABELS.map(({ key, label }) => (
                          <div key={key} className="flex items-center justify-between gap-2">
                            <span className="text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
                              {label}
                            </span>
                            <ScoreWithSpread
                              value={m.dimensionAverages[key] ?? null}
                              spread={m.dimensionStdDev[key] ?? null}
                              small
                            />
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Before → after diff ─────────────────────────────────────────────────────

export function DiffTable({ diff }: { diff: ScorecardDiff }) {
  if (diff.models.length === 0) {
    return <EmptyHint>No models are present in both runs.</EmptyHint>;
  }
  return (
    <div className="space-y-3">
      {diff.configWarnings.length > 0 && (
        <div
          className="rounded-xl px-4 py-3 text-xs leading-relaxed"
          style={{
            background: 'var(--eco-amber-soft)',
            border: '1px solid var(--eco-amber)',
            color: 'var(--eco-text-secondary)',
          }}
        >
          <strong style={{ color: 'var(--eco-text)' }}>Exploratory diff —</strong> these runs are not decision-grade comparable:
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {diff.configWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--eco-border-muted)' }}>
        <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--eco-surface)' }}>
            <Th>Model</Th>
            <Th align="right">Composite Δ</Th>
            {KEY_DIFF_DIMS.map((d) => (
              <Th key={d.key} align="right">{d.label} Δ</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {diff.models.map((m, i) => (
            <tr key={m.modelId} style={{ borderTop: i > 0 ? '1px solid var(--eco-border-muted)' : undefined }}>
              <Td>
                <span style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.78rem' }}>
                  {m.modelId}
                </span>
              </Td>
              <Td align="right"><DeltaChip value={m.compositeDelta} /></Td>
              {KEY_DIFF_DIMS.map((d) => (
                <Td key={d.key} align="right">
                  <DeltaChip value={m.dimensionDeltas[d.key] ?? null} />
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
  );
}

// ─── A / B compare ───────────────────────────────────────────────────────────

export function AbCompare({ ab }: { ab: AbResult }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl" style={{ border: '1px solid var(--eco-border-muted)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--eco-surface)' }}>
            <Th>Dimension</Th>
            <Th align="right">A · {ab.a.modelId}</Th>
            <Th align="right">B · {ab.b.modelId}</Th>
            <Th align="right">Δ (B − A)</Th>
          </tr>
        </thead>
        <tbody>
          <AbRow
            label="Composite"
            a={ab.a.compositeScore}
            b={ab.b.compositeScore}
            delta={ab.compositeDelta}
            first
          />
          {KEY_DIFF_DIMS.map((d) => (
            <AbRow
              key={d.key}
              label={d.label}
              a={ab.a.dimensionAverages[d.key] ?? null}
              b={ab.b.dimensionAverages[d.key] ?? null}
              delta={ab.dimensionDeltas[d.key] ?? null}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AbRow({
  label,
  a,
  b,
  delta,
  first,
}: {
  label: string;
  a: number | null;
  b: number | null;
  delta: number | null;
  first?: boolean;
}) {
  return (
    <tr style={{ borderTop: first ? undefined : '1px solid var(--eco-border-muted)' }}>
      <Td>
        <span style={{ color: 'var(--eco-text-secondary)' }}>{label}</span>
      </Td>
      <Td align="right" mono>{fmtNum(a, 2)}</Td>
      <Td align="right" mono>{fmtNum(b, 2)}</Td>
      <Td align="right"><DeltaChip value={delta} /></Td>
    </tr>
  );
}

// ─── Primitives ──────────────────────────────────────────────────────────────

function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className="px-4 py-2.5 font-medium"
      style={{ color: 'var(--eco-text-secondary)', textAlign: align, whiteSpace: 'nowrap' }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  mono,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
}) {
  return (
    <td
      className="px-4 py-2.5"
      style={{
        textAlign: align,
        color: 'var(--eco-text-secondary)',
        fontFamily: mono ? 'var(--eco-font-mono)' : undefined,
        fontSize: mono ? '0.8rem' : undefined,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </td>
  );
}

/** A 0..1 score chip, tinted mint→amber→coral by value. */
function ScoreChip({ value, small }: { value: number | null; small?: boolean }) {
  if (value === null) {
    return (
      <span style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.8rem' }}>—</span>
    );
  }
  const { bg, fg } = scoreTint(value);
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-medium ${small ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-0.5 text-xs'}`}
      style={{ background: bg, color: fg, fontFamily: 'var(--eco-font-mono)' }}
    >
      {value.toFixed(2)}
    </span>
  );
}

function ScoreWithSpread({
  value,
  spread,
  small,
}: {
  value: number | null;
  spread?: number | null;
  small?: boolean;
}) {
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <ScoreChip value={value} small={small} />
      {spread !== null && spread !== undefined && Number.isFinite(spread) && (
        <span style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.72rem' }}>
          ±{spread.toFixed(2)}
        </span>
      )}
    </span>
  );
}

/** A signed delta chip: green up / red down / muted ~0. */
function DeltaChip({ value }: { value: number | null }) {
  if (value === null) {
    return <span style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.8rem' }}>—</span>;
  }
  const near0 = Math.abs(value) < 0.005;
  const fg = near0
    ? 'var(--eco-text-muted)'
    : value > 0
      ? 'var(--eco-mint)'
      : 'var(--eco-coral)';
  const arrow = near0 ? '·' : value > 0 ? '▲' : '▼';
  const sign = value > 0 ? '+' : '';
  return (
    <span style={{ color: fg, fontFamily: 'var(--eco-font-mono)', fontSize: '0.8rem' }}>
      {sign}
      {value.toFixed(2)} {arrow}
    </span>
  );
}

// ─── Format helpers ──────────────────────────────────────────────────────────

/** Tint a 0..1 score: high → mint, mid → amber, low → coral. */
function scoreTint(value: number): { bg: string; fg: string } {
  if (value >= 0.8) {
    return { bg: 'var(--eco-success-soft)', fg: 'var(--eco-success)' };
  }
  if (value >= 0.5) {
    return { bg: 'var(--eco-amber-soft)', fg: 'var(--eco-amber)' };
  }
  return { bg: 'var(--eco-error-soft)', fg: 'var(--eco-coral)' };
}

function fmtNum(v: number | null, dp: number): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(dp);
}

function fmtMs(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${String(Math.round(v))} ms`;
}

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${String(Math.round(v * 100))}%`;
}
