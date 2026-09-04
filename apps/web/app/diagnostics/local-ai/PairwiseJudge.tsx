// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { Button } from '@eco/ui';
import type { CSSProperties, ReactNode } from 'react';
import type {
  JudgeView,
  PairArm,
  PairwiseTally,
} from '../../../src/local-ai/eval/pairwise';
import type { EvalRun } from '../../../src/local-ai/eval/types';

// ─── Blind pairwise judging surface ──────────────────────────────────────────
//
// Presentational only, like EvalScorecard: state, pairing and persistence live
// in EvalHarnessPanel. The judging card is deliberately identity-free — it is
// handed a `JudgeView`, which carries prompt and two texts and nothing that
// names a model, a run, a label or a sample index. Arm identities appear only
// in the tally, and only once `revealed` is true.

export type PairwiseJudgeProps = {
  runs: EvalRun[];
  armA: PairArm | null;
  armB: PairArm | null;
  onArmChange: (side: 'A' | 'B', arm: PairArm | null) => void;
  judge: string;
  onJudgeChange: (judge: string) => void;
  /** The pair awaiting a verdict, already side-ordered. `null` when none is left. */
  view: JudgeView | null;
  /** 1-based position of `view` in the pair list, for the progress readout. */
  position: number;
  pairCount: number;
  excludedCount: number;
  onVerdict: (side: 'left' | 'right' | 'tie') => void;
  onSkip: () => void;
  tally: PairwiseTally | null;
  revealed: boolean;
  onReveal: () => void;
  onDownload: () => void;
  notice: string | null;
};

export function PairwiseJudge(props: PairwiseJudgeProps) {
  const { runs, armA, armB, view, tally, revealed } = props;
  const decidedAll = tally !== null && tally.decided === tally.pairs && tally.pairs > 0;

  return (
    <>
      <p className="mb-3 text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
        Two arms head-to-head, one reply at a time, <em>blind</em>. An arm is a model
        within a run, so the same model in two runs compares two settings. Pairs where
        either arm errored or returned nothing are excluded and counted.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <ArmPicker label="Arm A" runs={runs} arm={armA} onChange={(a) => { props.onArmChange('A', a); }} />
        <ArmPicker label="Arm B" runs={runs} arm={armB} onChange={(a) => { props.onArmChange('B', a); }} />
        <FieldLabel label="Judge">
          <input
            value={props.judge}
            onChange={(e) => { props.onJudgeChange(e.target.value); }}
            placeholder="your name"
            className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </FieldLabel>
      </div>

      {props.notice && (
        <p className="mt-3 text-sm" style={{ color: 'var(--eco-text-muted)' }}>{props.notice}</p>
      )}

      {view && (
        <div
          className="mt-4 rounded-xl p-4"
          style={{ border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface)' }}
        >
          <div className="mb-3 flex items-baseline justify-between gap-3 text-xs" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)' }}>
            <span>{view.promptId}</span>
            <span>{props.position} / {props.pairCount} · {props.excludedCount} excluded</span>
          </div>

          {view.history.length > 0 && (
            <div className="mb-3 text-xs" style={{ color: 'var(--eco-text-muted)' }}>
              {view.history.map((turn, i) => (
                <p key={`${turn.role}-${String(i)}`} className="mb-1">
                  <span style={{ fontFamily: 'var(--eco-font-mono)' }}>{turn.role}: </span>
                  {turn.content}
                </p>
              ))}
            </div>
          )}

          <p className="mb-4 text-sm" style={{ color: 'var(--eco-text)' }}>
            {view.promptText ?? '(prompt text unavailable — judge on the replies alone)'}
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <ReplyCard heading="Left" text={view.left} />
            <ReplyCard heading="Right" text={view.right} />
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={() => { props.onVerdict('left'); }} variant="secondary">Left is better</Button>
            <Button onClick={() => { props.onVerdict('tie'); }} variant="secondary">Tie</Button>
            <Button onClick={() => { props.onVerdict('right'); }} variant="secondary">Right is better</Button>
            <Button onClick={props.onSkip} variant="ghost">Skip</Button>
          </div>
        </div>
      )}

      {tally && (
        <div className="mt-4">
          <TallyTable tally={tally} />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {revealed ? (
              <p className="text-xs" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)' }}>
                A = {armA ? `${armA.modelId} · ${armA.runId}` : '—'} · B ={' '}
                {armB ? `${armB.modelId} · ${armB.runId}` : '—'}
                {decidedAll ? '' : ' (revealed early)'}
              </p>
            ) : (
              <Button onClick={props.onReveal} variant="secondary">Reveal identities now</Button>
            )}
            <Button onClick={props.onDownload} variant="secondary">Download session JSON</Button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function ArmPicker({
  label,
  runs,
  arm,
  onChange,
}: {
  label: string;
  runs: EvalRun[];
  arm: PairArm | null;
  onChange: (arm: PairArm | null) => void;
}) {
  const run = runs.find((r) => r.runId === arm?.runId) ?? null;
  const modelIds = run ? [...new Set(run.results.map((r) => r.modelId))] : [];
  return (
    <FieldLabel label={label}>
      <select
        value={arm?.runId ?? ''}
        onChange={(e) => { onChange(e.target.value ? { runId: e.target.value, modelId: '' } : null); }}
        className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-sm outline-none"
        style={inputStyle}
      >
        <option value="">select a run</option>
        {[...runs].reverse().map((r) => (
          <option key={r.runId} value={r.runId}>{r.label} — {r.runId}</option>
        ))}
      </select>
      <select
        value={arm?.modelId ?? ''}
        onChange={(e) => { onChange(arm ? { runId: arm.runId, modelId: e.target.value } : null); }}
        disabled={!run}
        className="mt-2 w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-sm outline-none"
        style={{ ...inputStyle, opacity: run ? 1 : 0.6 }}
      >
        <option value="">select a model</option>
        {modelIds.map((id) => (
          <option key={id} value={id}>{id}</option>
        ))}
      </select>
    </FieldLabel>
  );
}

function ReplyCard({ heading, text }: { heading: string; text: string }) {
  return (
    <div className="rounded-lg p-3" style={{ border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface-elevated)' }}>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--eco-text-secondary)' }}>
        {heading}
      </p>
      <p className="whitespace-pre-wrap text-sm" style={{ color: 'var(--eco-text)' }}>{text}</p>
    </div>
  );
}

function TallyTable({ tally }: { tally: PairwiseTally }) {
  const rate = tally.winRateA === null ? '—' : `${(tally.winRateA * 100).toFixed(1)}%`;
  const ci =
    tally.interval === null
      ? '—'
      : `[${(tally.interval.lo * 100).toFixed(1)}%, ${(tally.interval.hi * 100).toFixed(1)}%]`;
  return (
    <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--eco-border-muted)' }}>
      <table className="w-full text-sm">
        <tbody>
          <TallyRow label="Wins A" value={String(tally.winsA)} first />
          <TallyRow label="Wins B" value={String(tally.winsB)} />
          <TallyRow label="Ties" value={String(tally.ties)} />
          <TallyRow label="Judged / pairs" value={`${String(tally.decided)} / ${String(tally.pairs)}`} />
          <TallyRow label="Excluded" value={String(tally.excluded)} />
          <TallyRow label="Win rate A (ties split)" value={rate} />
          <TallyRow label="Wilson 95%" value={ci} />
        </tbody>
      </table>
    </div>
  );
}

function TallyRow({ label, value, first }: { label: string; value: string; first?: boolean }) {
  return (
    <tr style={{ borderTop: first ? undefined : '1px solid var(--eco-border-muted)' }}>
      <td className="px-3 py-2" style={{ color: 'var(--eco-text-secondary)' }}>{label}</td>
      <td className="px-3 py-2 text-right" style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)' }}>
        {value}
      </td>
    </tr>
  );
}

function FieldLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--eco-text-secondary)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: CSSProperties = {
  background: 'var(--eco-surface)',
  border: '1px solid var(--eco-border-muted)',
  color: 'var(--eco-text)',
  fontFamily: 'var(--eco-font-body)',
};
