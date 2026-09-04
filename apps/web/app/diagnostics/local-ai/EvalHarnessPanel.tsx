// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@eco/ui';
import type { EvalProgress, EvalRunConfig } from '../../../src/local-ai/eval/harness';
import type { CapturedFailure } from '../../../src/local-ai/eval/capture';
import type {
  EvalMessageTopology,
  EvalPromptSpec,
  EvalRun,
  Scorecard,
  ScorecardDiff,
} from '../../../src/local-ai/eval/types';
import {
  AbCompare,
  DiffTable,
  EmptyHint,
  ScorecardMeta,
  ScorecardTable,
  type AbResult,
} from './EvalScorecard';
import { PairwiseJudge } from './PairwiseJudge';
// Pure + storage-only (no catalog, no runtime, no model), so unlike the eval
// engine this is safe at module scope; the panel keeps it out of an effect so
// pairing can be a `useMemo`.
import {
  buildPairs,
  exportPairwiseSession,
  loadPairwiseSessions,
  orderForJudge,
  savePairwiseSession,
  sessionIdFor,
  tally as tallyPairs,
  verdictFromSide,
} from '../../../src/local-ai/eval/pairwise';
import type { PairArm, PairwiseSession } from '../../../src/local-ai/eval/pairwise';

// ─── Static metadata (no heavy imports at module scope) ──────────────────────
//
// The eval engine + catalog are dynamically imported inside handlers / on mount
// (mirroring DiagnosticsClient) so they never run during SSR. Only pure types
// live at module scope; presentational scorecard surfaces live in EvalScorecard.

interface PickerModel {
  id: string;
  friendlyName: string;
  sizeGB: number;
  runtime: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function EvalHarnessPanel() {
  const searchParams = useSearchParams();

  // Run config
  const [label, setLabel] = useState('baseline');
  const [maxTokensCap, setMaxTokensCap] = useState(512);
  const [samplingMode, setSamplingMode] = useState<'greedy' | 'sampled'>('sampled');
  const [samplesPerProbe, setSamplesPerProbe] = useState(1);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [pickerModels, setPickerModels] = useState<PickerModel[]>([]);
  const [pickerLoaded, setPickerLoaded] = useState(false);

  // URL autorun (fire-once)
  const autorunFiredRef = useRef(false);
  const [autorunNote, setAutorunNote] = useState<string | null>(null);

  // Judge-score backfill
  const [judgeInput, setJudgeInput] = useState('');
  const [judgeNote, setJudgeNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [skeletonCopied, setSkeletonCopied] = useState(false);

  // Run state
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<EvalProgress | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Persisted runs + selection
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Captured failures (failure-capture loop, chat #7 W2.1)
  const [captures, setCaptures] = useState<CapturedFailure[]>([]);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<string[]>([]);
  const [capturedOnly, setCapturedOnly] = useState(false);
  const [captureCopied, setCaptureCopied] = useState(false);
  const [captureImportInput, setCaptureImportInput] = useState('');
  const [captureNote, setCaptureNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(
    null,
  );

  // Diff selectors
  const [beforeRunId, setBeforeRunId] = useState<string | null>(null);
  const [afterRunId, setAfterRunId] = useState<string | null>(null);

  // A-B selectors
  const [abRunId, setAbRunId] = useState<string | null>(null);
  const [abModelA, setAbModelA] = useState<string | null>(null);
  const [abModelB, setAbModelB] = useState<string | null>(null);

  // Blind pairwise judging (arms are (runId, modelId); verdicts live under their
  // own storage key, so nothing here touches the eval-run schema)
  const [pwArmA, setPwArmA] = useState<PairArm | null>(null);
  const [pwArmB, setPwArmB] = useState<PairArm | null>(null);
  const [pwJudge, setPwJudge] = useState('');
  const [pwSession, setPwSession] = useState<PairwiseSession | null>(null);
  const [pwIndex, setPwIndex] = useState(0);
  // Persisted results carry no prompt text (EvalPromptTrace is deliberately
  // content-free), so the judging card gets prompt + history from the pool.
  const [pwSpecs, setPwSpecs] = useState<EvalPromptSpec[]>([]);

  // Derived scorecards (built off the main thread of the render via effects)
  const [scorecards, setScorecards] = useState<{
    selected: Scorecard | null;
    diff: ScorecardDiff | null;
  }>({ selected: null, diff: null });
  const [ab, setAb] = useState<AbResult | null>(null);
  const [abError, setAbError] = useState<string | null>(null);

  // ── Load catalog + persisted runs on mount (dynamic import — no SSR) ──
  const refreshRuns = useCallback(async () => {
    const { loadEvalRuns } = await import('../../../src/local-ai/eval/storage');
    setRuns(loadEvalRuns());
  }, []);

  const refreshCaptures = useCallback(async () => {
    const { loadCaptures } = await import('../../../src/local-ai/eval/capture-store');
    const loaded = loadCaptures();
    setCaptures(loaded);
    // Drop selections for captures that no longer exist.
    setSelectedCaptureIds((prev) => prev.filter((id) => loaded.some((c) => c.captureId === id)));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { getCatalog } = await import('../../../src/local-ai/catalog/catalog');
        const { getEvalCandidateModels } = await import(
          '../../../src/local-ai/eval/eval-candidates'
        );
        setPickerModels(
          [...getCatalog(), ...getEvalCandidateModels()].map((m) => ({
            id: m.id,
            friendlyName: m.friendlyName,
            sizeGB: m.sizeGB,
            runtime: m.runtime,
          })),
        );
      } catch {
        setPickerModels([]);
      } finally {
        setPickerLoaded(true);
      }
      await refreshRuns();
      await refreshCaptures();
    })();
  }, [refreshRuns, refreshCaptures]);

  const toggleModel = useCallback((id: string) => {
    setSelectedModelIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  }, []);

  // ── Run / cancel ──
  //
  // Accepts an optional override so the autorun effect can pass freshly-parsed
  // URL values directly (the `setState` calls in the same tick haven't committed
  // yet, so the closed-over `selectedModelIds`/`label`/`maxTokensCap` would still
  // be stale). A manual button click passes nothing and uses current state.
  const handleRun = useCallback(
    async (override?: {
      modelIds?: string[];
      label?: string;
      maxTokensCap?: number;
      samplingMode?: 'greedy' | 'sampled';
      samplesPerProbe?: number;
      /** Autorun-only (no UI control): subset of prompt ids to run. */
      promptIds?: string[];
      /** Autorun-only: include the diagnostic context-stress/boundary probes. */
      includeResearchArms?: boolean;
      /** Autorun-only: run-wide message composition topology. */
      messageTopology?: EvalMessageTopology;
      /** Autorun-only: per-generation stream timeout override (ms). */
      perGenerationTimeoutMs?: number;
      /** Autorun-only: session-scoped probes appended to the pool. */
      extraPrompts?: EvalRunConfig['extraPrompts'];
    }) => {
      const runModelIds = override?.modelIds ?? selectedModelIds;
      const runLabel = override?.label ?? label;
      const runMaxTokens = override?.maxTokensCap ?? maxTokensCap;
      const runSamplingMode = override?.samplingMode ?? samplingMode;
      const runSamplesPerProbe = override?.samplesPerProbe ?? samplesPerProbe;

      if (running || runModelIds.length === 0) return;
      setRunError(null);
      setRunning(true);
      setProgress({ phase: 'loading', modelId: '', completed: 0, total: 0 });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const { runEval } = await import('../../../src/local-ai/eval/harness');

        // Selected captured failures replay as session-scoped probes. With
        // "captured only" on, the run narrows to just those probes — the fast
        // iteration loop (replay the failing set, nothing else).
        const selectedCaptures = captures.filter((c) =>
          selectedCaptureIds.includes(c.captureId),
        );
        let extraPrompts: EvalRunConfig['extraPrompts'];
        if (selectedCaptures.length > 0) {
          const { capturedFailureToPromptSpec } = await import(
            '../../../src/local-ai/eval/capture'
          );
          extraPrompts = selectedCaptures.map(capturedFailureToPromptSpec);
        }
        // Autorun-only session-scoped probes are appended to the pool; the
        // harness dedupes by id.
        if (override?.extraPrompts && override.extraPrompts.length > 0) {
          extraPrompts = [...(extraPrompts ?? []), ...override.extraPrompts];
        }

        const config: EvalRunConfig = {
          label: runLabel.trim() || 'baseline',
          modelIds: runModelIds,
          maxTokensCap: runMaxTokens,
          samplingMode: runSamplingMode,
          samplesPerProbe: runSamplesPerProbe,
          ...(extraPrompts ? { extraPrompts } : {}),
          ...(extraPrompts && capturedOnly
            ? { promptIds: selectedCaptures.map((c) => c.captureId) }
            : {}),
          // Autorun-only overrides (URL-driven; manual runs never set these).
          ...(override?.promptIds && override.promptIds.length > 0
            ? { promptIds: override.promptIds }
            : {}),
          ...(override?.includeResearchArms ? { includeResearchArms: true } : {}),
          ...(override?.messageTopology ? { messageTopology: override.messageTopology } : {}),
          ...(override?.perGenerationTimeoutMs !== undefined
            ? { perGenerationTimeoutMs: override.perGenerationTimeoutMs }
            : {}),
          onProgress: (p) => {
            setProgress(p);
          },
          signal: controller.signal,
        };
        const run = await runEval(config);
        await refreshRuns();
        setSelectedRunId(run.runId);
      } catch (err) {
        setRunError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
        abortRef.current = null;
        setProgress(null);
      }
    },
    [
      running,
      selectedModelIds,
      label,
      maxTokensCap,
      samplingMode,
      samplesPerProbe,
      refreshRuns,
      captures,
      selectedCaptureIds,
      capturedOnly,
    ],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── URL autorun (fire-once) ──
  //
  // `?eco-eval-autorun=1` (alongside the page's `?eco-diagnostics=1` gate) kicks
  // off one eval pass hands-off, so a full model-quality run can be triggered by
  // a single URL. Mirrors DiagnosticsClient's fire-once-on-mount pattern: a ref
  // guard means it runs exactly once even as deps re-evaluate. We wait for the
  // picker to load so the model ids can be validated, and pass parsed values
  // straight into handleRun (not via state) to dodge the stale-closure race.
  useEffect(() => {
    if (autorunFiredRef.current) return;
    if (searchParams.get('eco-eval-autorun') !== '1') return;
    if (!pickerLoaded) return;

    const rawModels = searchParams.get('eco-eval-models');
    const requested = (rawModels ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const known = new Set(pickerModels.map((m) => m.id));
    const validIds = requested.filter((id) => known.has(id));
    const skipped = requested.filter((id) => !known.has(id));

    if (validIds.length === 0) {
      autorunFiredRef.current = true;
      setAutorunNote(
        requested.length === 0
          ? 'Autorun skipped: no eco-eval-models specified.'
          : `Autorun skipped: none of [${requested.join(', ')}] are in the picker.`,
      );
      return;
    }

    const rawLabel = searchParams.get('eco-eval-label');
    const autoLabel = rawLabel && rawLabel.trim().length > 0 ? rawLabel.trim() : 'baseline';

    const rawMaxTokens = searchParams.get('eco-eval-maxtokens');
    const autoMaxTokens =
      rawMaxTokens !== null ? clampInt(rawMaxTokens, 16, 4096, maxTokensCap) : maxTokensCap;

    // `eco-eval-timeout` (ms): per-generation stream timeout. High caps need
    // it — 2048 tokens at ~20 tok/s outruns the 60s default mid-answer.
    const rawTimeout = searchParams.get('eco-eval-timeout');
    const autoTimeoutMs =
      rawTimeout !== null ? clampInt(rawTimeout, 10_000, 600_000, 60_000) : undefined;

    // `eco-eval-arms=1`: include the diagnostic context-stress and
    // context-boundary probes (off by default, see the harness config doc).
    const includeResearchArms = searchParams.get('eco-eval-arms') === '1';

    // `eco-eval-sampling=greedy`: deterministic argmax (reproducible arm).
    // Anything else (incl. absent) = the default 'sampled' production profile.
    const autoSamplingMode: 'greedy' | 'sampled' =
      searchParams.get('eco-eval-sampling') === 'greedy' ? 'greedy' : 'sampled';

    // `eco-eval-topology`: URL-only diagnostics control for prompt-topology bakeoffs.
    // Absent/invalid = harness default (production user-turn hints).
    const rawTopology = searchParams.get('eco-eval-topology');
    const autoMessageTopology: EvalMessageTopology | undefined =
      rawTopology === 'user-turn' || rawTopology === 'production-user-turn-hints'
        ? 'production-user-turn-hints'
        : rawTopology === 'system' || rawTopology === 'system-front-hints'
          ? 'system-front-hints'
          : rawTopology === 'gemma-native' || rawTopology === 'gemma-native-user-contract'
            ? 'gemma-native-user-contract'
            : undefined;

    // `eco-eval-samples=N`: replicate each prompt/model N times (clamped in the harness).
    const rawSamplesPerProbe = searchParams.get('eco-eval-samples');
    const autoSamplesPerProbe =
      rawSamplesPerProbe !== null ? clampInt(rawSamplesPerProbe, 1, 10, 1) : 1;

    // `eco-eval-prompts`: comma-separated exact prompt ids. This is the
    // surgical path for final-gate reruns (e.g. if4,if5,if6,st2,rich5) without
    // dragging every category peer into the pass.
    const rawPromptIds = searchParams.get('eco-eval-prompts');
    const requestedPromptIds = (rawPromptIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // `eco-eval-categories`: run only prompts in these categories (expanded
    // to prompt ids against the same pool the harness selects from).
    const rawCategories = searchParams.get('eco-eval-categories');
    const categories = (rawCategories ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Reflect the parsed config in the UI for transparency…
    setSelectedModelIds(validIds);
    setLabel(autoLabel);
    setMaxTokensCap(autoMaxTokens);
    setSamplingMode(autoSamplingMode);
    setSamplesPerProbe(autoSamplesPerProbe);
    setAutorunNote(
      skipped.length > 0
        ? `Autorun started on [${validIds.join(', ')}] (skipped unknown: [${skipped.join(', ')}]).`
        : `Autorun started on [${validIds.join(', ')}].`,
    );

    // …but run with the parsed values directly so the in-flight render's stale
    // state can't override them.
    autorunFiredRef.current = true;
    void (async () => {
      let promptIds: string[] | undefined =
        requestedPromptIds.length > 0 ? requestedPromptIds : undefined;
      const loadPromptPool = async () => {
        const [
          { EVAL_PROMPTS },
          { EVERYDAY_CONVERSATION_PROBES },
          { CONVERSATION_INTEGRITY_PROBES },
          { CONTEXT_STRESS_PROBES, CONTEXT_BOUNDARY_PROBES },
          { KNOWN_ANSWER_PROBES },
        ] = await Promise.all([
          import('../../../src/local-ai/eval/prompts'),
          import('../../../src/local-ai/eval/everyday-conversation-probes'),
          import('../../../src/local-ai/eval/conversation-integrity-probe'),
          import('../../../src/local-ai/eval/context-stress-probes'),
          import('../../../src/local-ai/eval/known-answer-probes'),
        ]);
        return [
          ...EVAL_PROMPTS,
          // The conversation-integrity (#27 leak) probes ride here so
          // `eco-eval-categories=conversation-integrity` and their `ci-*` ids
          // resolve; they carry history, so they must join as extraPrompts below.
          ...CONVERSATION_INTEGRITY_PROBES,
          // The known-answer set (right-answer accuracy) rides the same way so
          // `eco-eval-categories=known-answer` and its `ka-*` ids resolve.
          ...KNOWN_ANSWER_PROBES,
          // Mirror the harness's selectPrompts pool: the diagnostic context-
          // stress headroom probes are reachable only under the research-arms
          // gate, so `eco-eval-prompts=ctx-stress-…` (with eco-eval-arms=1)
          // passes id-validation here and reaches the harness.
          ...(includeResearchArms ? [...CONTEXT_STRESS_PROBES, ...CONTEXT_BOUNDARY_PROBES] : []),
          // The conversation set is derived from its corpus, so it is not in the
          // harness's checked-in pool — it is named here so
          // `eco-eval-categories=everyday-conversation` and
          // `eco-eval-prompts=everyday-convo-…` can resolve it, and it rides to
          // the harness as extraPrompts below.
          ...EVERYDAY_CONVERSATION_PROBES,
        ];
      };
      let promptNote = '';
      if (requestedPromptIds.length > 0) {
        const pool = await loadPromptPool();
        const knownPromptIds = new Set(pool.map((p) => p.id));
        const validPromptIds = requestedPromptIds.filter((id) => knownPromptIds.has(id));
        const skippedPromptIds = requestedPromptIds.filter((id) => !knownPromptIds.has(id));
        if (validPromptIds.length === 0) {
          setAutorunNote(
            `Autorun skipped: no prompts match ids [${requestedPromptIds.join(', ')}].`,
          );
          return;
        }
        promptIds = validPromptIds;
        if (skippedPromptIds.length > 0) {
          promptNote = ` Skipped unknown prompts: [${skippedPromptIds.join(', ')}].`;
        }
      }
      if (!promptIds && categories.length > 0) {
        const pool = await loadPromptPool();
        const wanted = new Set(categories);
        promptIds = pool.filter((p) => wanted.has(p.category)).map((p) => p.id);
        if (promptIds.length === 0) {
          // Guard: empty promptIds would mean "run everything" to the harness.
          setAutorunNote(
            `Autorun skipped: no prompts match categories [${categories.join(', ')}].`,
          );
          return;
        }
      }
      if (promptNote) {
        setAutorunNote(
          skipped.length > 0
            ? `Autorun started on [${validIds.join(', ')}] (skipped unknown: [${skipped.join(', ')}]).${promptNote}`
            : `Autorun started on [${validIds.join(', ')}].${promptNote}`,
        );
      }
      // The probe sets derived from corpora live outside the harness's
      // checked-in pool, so the selected ones have to ride along as
      // session-scoped extraPrompts. Armed only when the resolved selection
      // actually names one: a run that selected none carries exactly the
      // extras it carried before this existed. The conversation probes must
      // ride this way or their `history` never reaches the harness.
      let extraPrompts: EvalPromptSpec[] = [];
      if (promptIds && promptIds.length > 0) {
        const [
          { EVERYDAY_CONVERSATION_PROBES },
          { CONVERSATION_INTEGRITY_PROBES },
          { KNOWN_ANSWER_PROBES },
        ] = await Promise.all([
          import('../../../src/local-ai/eval/everyday-conversation-probes'),
          import('../../../src/local-ai/eval/conversation-integrity-probe'),
          import('../../../src/local-ai/eval/known-answer-probes'),
        ]);
        const wanted = new Set(promptIds);
        extraPrompts = [
          ...EVERYDAY_CONVERSATION_PROBES,
          ...CONVERSATION_INTEGRITY_PROBES,
          ...KNOWN_ANSWER_PROBES,
        ].filter((p) => wanted.has(p.id));
      }

      await handleRun({
        modelIds: validIds,
        label: autoLabel,
        maxTokensCap: autoMaxTokens,
        samplingMode: autoSamplingMode,
        samplesPerProbe: autoSamplesPerProbe,
        ...(promptIds ? { promptIds } : {}),
        ...(includeResearchArms ? { includeResearchArms: true } : {}),
        ...(autoMessageTopology ? { messageTopology: autoMessageTopology } : {}),
        ...(autoTimeoutMs !== undefined ? { perGenerationTimeoutMs: autoTimeoutMs } : {}),
        ...(extraPrompts.length > 0 ? { extraPrompts } : {}),
      });
    })();
  }, [searchParams, pickerLoaded, pickerModels, maxTokensCap, handleRun]);

  // ── Saved-run actions ──
  const handleCopy = useCallback(async () => {
    try {
      const { exportEvalRuns } = await import('../../../src/local-ai/eval/storage');
      await navigator.clipboard.writeText(exportEvalRuns());
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Clipboard unavailable — silently no-op (parity with DiagnosticsClient).
    }
  }, []);

  const handleDownload = useCallback(async () => {
    const { exportEvalRuns } = await import('../../../src/local-ai/eval/storage');
    const blob = new Blob([exportEvalRuns()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eco-eval-runs-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleClear = useCallback(async () => {
    const { clearEvalRuns } = await import('../../../src/local-ai/eval/storage');
    clearEvalRuns();
    setRuns([]);
    setSelectedRunId(null);
    setBeforeRunId(null);
    setAfterRunId(null);
    setAbRunId(null);
    setPwArmA(null);
    setPwArmB(null);
    setPwSession(null);
  }, []);

  // ── Blind pairwise judging ──

  // The prompt pool, for prompt text + replayed history on the judging card.
  useEffect(() => {
    void (async () => {
      try {
        const [
          { EVAL_PROMPTS },
          { EVERYDAY_CONVERSATION_PROBES },
          { CONVERSATION_INTEGRITY_PROBES },
          { CONTEXT_STRESS_PROBES, CONTEXT_BOUNDARY_PROBES },
          { KNOWN_ANSWER_PROBES },
        ] = await Promise.all([
          import('../../../src/local-ai/eval/prompts'),
          import('../../../src/local-ai/eval/everyday-conversation-probes'),
          import('../../../src/local-ai/eval/conversation-integrity-probe'),
          import('../../../src/local-ai/eval/context-stress-probes'),
          import('../../../src/local-ai/eval/known-answer-probes'),
        ]);
        setPwSpecs([
          ...EVAL_PROMPTS,
          ...CONVERSATION_INTEGRITY_PROBES,
          ...KNOWN_ANSWER_PROBES,
          ...CONTEXT_STRESS_PROBES,
          ...CONTEXT_BOUNDARY_PROBES,
          ...EVERYDAY_CONVERSATION_PROBES,
        ]);
      } catch {
        setPwSpecs([]);
      }
    })();
  }, []);

  const pwPairing = useMemo(() => {
    const sameArm =
      pwArmA !== null &&
      pwArmB !== null &&
      pwArmA.runId === pwArmB.runId &&
      pwArmA.modelId === pwArmB.modelId;
    if (!pwArmA?.modelId || !pwArmB?.modelId || sameArm) return { pairs: [], excluded: [] };
    return buildPairs(runs, pwArmA, pwArmB, pwSpecs);
  }, [runs, pwArmA, pwArmB, pwSpecs]);

  // One session per (armA, armB, judge): re-select the same three and the
  // verdicts already recorded come back rather than starting over.
  const pwExcludedCount = pwPairing.excluded.length;
  useEffect(() => {
    if (!pwArmA?.modelId || !pwArmB?.modelId) {
      setPwSession(null);
      return;
    }
    const sessionId = sessionIdFor(pwArmA, pwArmB, pwJudge);
    const existing = loadPairwiseSessions().find((s) => s.sessionId === sessionId);
    const now = new Date().toISOString();
    const session: PairwiseSession = existing
      ? { ...existing, excludedCount: pwExcludedCount }
      : {
          schemaVersion: 1,
          sessionId,
          createdAt: now,
          updatedAt: now,
          judge: pwJudge,
          armA: pwArmA,
          armB: pwArmB,
          verdicts: {},
          excludedCount: pwExcludedCount,
          revealedEarly: false,
        };
    setPwSession(session);
    const firstUnjudged = pwPairing.pairs.findIndex((p) => session.verdicts[p.pairId] === undefined);
    setPwIndex(firstUnjudged === -1 ? pwPairing.pairs.length : firstUnjudged);
  }, [pwArmA, pwArmB, pwJudge, pwPairing, pwExcludedCount]);

  const pwPair = pwPairing.pairs[pwIndex];
  const pwView = pwPair ? orderForJudge(pwPair) : null;
  const pwTally = pwSession ? tallyPairs(pwSession, pwPairing.pairs) : null;
  const pwAllDecided = pwTally !== null && pwTally.pairs > 0 && pwTally.decided === pwTally.pairs;

  const handlePwVerdict = useCallback(
    (side: 'left' | 'right' | 'tie') => {
      if (!pwSession || !pwView) return;
      const next: PairwiseSession = {
        ...pwSession,
        verdicts: { ...pwSession.verdicts, [pwView.pairId]: verdictFromSide(pwView, side) },
      };
      savePairwiseSession(next);
      setPwSession(next);
      setPwIndex((i) => i + 1);
    },
    [pwSession, pwView],
  );

  const handlePwSkip = useCallback(() => {
    setPwIndex((i) => i + 1);
  }, []);

  const handlePwReveal = useCallback(() => {
    if (!pwSession) return;
    // An early reveal is recorded, not prevented — the exported session has to
    // say whether the judge saw the identities before finishing.
    const next: PairwiseSession = { ...pwSession, revealedEarly: !pwAllDecided };
    savePairwiseSession(next);
    setPwSession(next);
  }, [pwSession, pwAllDecided]);

  const handlePwDownload = useCallback(() => {
    if (!pwSession) return;
    const blob = new Blob([exportPairwiseSession(pwSession, pwPairing.pairs)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eco-pairwise-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [pwSession, pwPairing.pairs]);

  // ── Captured-failure actions ──
  const toggleCapture = useCallback((captureId: string) => {
    setSelectedCaptureIds((prev) =>
      prev.includes(captureId) ? prev.filter((id) => id !== captureId) : [...prev, captureId],
    );
  }, []);

  const handleCaptureCopy = useCallback(async () => {
    try {
      const { exportCaptures } = await import('../../../src/local-ai/eval/capture-store');
      await navigator.clipboard.writeText(exportCaptures());
      setCaptureCopied(true);
      setTimeout(() => {
        setCaptureCopied(false);
      }, 2000);
    } catch {
      // Clipboard unavailable — silently no-op (parity with run export).
    }
  }, []);

  const handleCaptureDownload = useCallback(async () => {
    const { exportCaptures } = await import('../../../src/local-ai/eval/capture-store');
    const blob = new Blob([exportCaptures()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eco-captures-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleCaptureDelete = useCallback(
    async (captureId: string) => {
      const { removeCapture } = await import('../../../src/local-ai/eval/capture-store');
      removeCapture(captureId);
      await refreshCaptures();
    },
    [refreshCaptures],
  );

  const handleCaptureImport = useCallback(async () => {
    if (captureImportInput.trim().length === 0) return;
    const { importCaptures } = await import('../../../src/local-ai/eval/capture-store');
    const result = importCaptures(captureImportInput);
    if (result === null) {
      setCaptureNote({
        tone: 'error',
        text: 'Import failed: not a capture export (expected the envelope or a bare array).',
      });
      return;
    }
    setCaptureNote({
      tone: 'ok',
      text: `Imported ${String(result.imported)}, skipped ${String(result.skipped)} (duplicates/invalid).`,
    });
    setCaptureImportInput('');
    await refreshCaptures();
  }, [captureImportInput, refreshCaptures]);

  // ── Judge-score backfill (operates on the selected run) ──
  //
  // Fills the coherence/taskFit judge dims (1..5) on an already-persisted run
  // without re-running generation — the writer for the W2a A/B review. Parses a
  // JSON array of { promptId, modelId, sampleIndex?, coherence?, taskFit? }, validates each
  // entry, writes the valid ones, then refreshes + re-selects so judgeAverages
  // update in the scorecard. Never throws to the user.
  const handleApplyJudgeScores = useCallback(async () => {
    if (!selectedRunId || judgeInput.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(judgeInput);
    } catch (err) {
      setJudgeNote({
        tone: 'error',
        text: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (!Array.isArray(parsed)) {
      setJudgeNote({ tone: 'error', text: 'Expected a JSON array of judge entries.' });
      return;
    }

    const valid: {
      promptId: string;
      modelId: string;
      sampleIndex?: number;
      coherence?: number;
      taskFit?: number;
    }[] = [];
    const errors: string[] = [];
    parsed.forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null) {
        errors.push(`#${String(i)}: not an object`);
        return;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.promptId !== 'string' || e.promptId.length === 0) {
        errors.push(`#${String(i)}: promptId must be a non-empty string`);
        return;
      }
      if (typeof e.modelId !== 'string' || e.modelId.length === 0) {
        errors.push(`#${String(i)}: modelId must be a non-empty string`);
        return;
      }
      const out: {
        promptId: string;
        modelId: string;
        sampleIndex?: number;
        coherence?: number;
        taskFit?: number;
      } = {
        promptId: e.promptId,
        modelId: e.modelId,
      };
      if (e.sampleIndex !== undefined) {
        if (typeof e.sampleIndex !== 'number' || !Number.isInteger(e.sampleIndex) || e.sampleIndex < 1) {
          errors.push(`#${String(i)}: sampleIndex must be a positive integer`);
          return;
        }
        out.sampleIndex = e.sampleIndex;
      }
      let hasDim = false;
      for (const dim of ['coherence', 'taskFit'] as const) {
        if (e[dim] === undefined) continue;
        const n = e[dim];
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || n > 5) {
          errors.push(`#${String(i)}: ${dim} must be a number in [1, 5]`);
          return;
        }
        out[dim] = n;
        hasDim = true;
      }
      if (!hasDim) {
        errors.push(`#${String(i)}: provide at least one of coherence / taskFit`);
        return;
      }
      valid.push(out);
    });

    if (valid.length === 0) {
      setJudgeNote({
        tone: 'error',
        text: `No valid entries.${errors.length > 0 ? ` ${errors.join('; ')}` : ''}`,
      });
      return;
    }

    const { setJudgeScores } = await import('../../../src/local-ai/eval/storage');
    const ok = setJudgeScores(selectedRunId, valid);
    if (!ok) {
      setJudgeNote({ tone: 'error', text: 'Run not found — it may have been cleared.' });
      return;
    }

    await refreshRuns();
    // Re-select so the scorecard effect recomputes judgeAverages.
    setSelectedRunId(selectedRunId);
    setJudgeNote({
      tone: 'ok',
      text:
        `Applied ${String(valid.length)} entr${valid.length === 1 ? 'y' : 'ies'}.` +
        (errors.length > 0 ? ` Skipped ${String(errors.length)}: ${errors.join('; ')}` : ''),
    });
  }, [selectedRunId, judgeInput, refreshRuns]);

  // ── Copy a judge-score skeleton for the selected run ──
  //
  // Emits one { promptId, modelId } row per result that REQUESTED judging and
  // is still unfilled, ready to paste into the box above and annotate with 1..5
  // values — no manual transcription of the run's prompt × model matrix.
  const handleCopyJudgeSkeleton = useCallback(async () => {
    if (!selectedRunId) return;
    const run = runs.find((r) => r.runId === selectedRunId);
    if (!run) return;
    const { buildJudgeSkeleton } = await import('../../../src/local-ai/eval/storage');
    const skeleton = buildJudgeSkeleton(run).map((e) => {
      const row: {
        promptId: string;
        modelId: string;
        sampleIndex?: number;
        coherence?: null;
        taskFit?: null;
      } = {
        promptId: e.promptId,
        modelId: e.modelId,
      };
      if (e.sampleIndex !== undefined) row.sampleIndex = e.sampleIndex;
      if (e.needs.includes('coherence')) row.coherence = null;
      if (e.needs.includes('taskFit')) row.taskFit = null;
      return row;
    });
    if (skeleton.length === 0) {
      setJudgeNote({ tone: 'ok', text: 'No judge-marked results need filling on this run.' });
      return;
    }
    setJudgeInput(JSON.stringify(skeleton, null, 2));
    try {
      await navigator.clipboard.writeText(JSON.stringify(skeleton, null, 2));
      setSkeletonCopied(true);
      setTimeout(() => {
        setSkeletonCopied(false);
      }, 2000);
    } catch {
      // Clipboard unavailable — the textarea is already populated, so no-op.
    }
  }, [selectedRunId, runs]);

  // ── Selected-run scorecard ──
  useEffect(() => {
    if (!selectedRunId) {
      setScorecards((s) => ({ ...s, selected: null }));
      return;
    }
    const run = runs.find((r) => r.runId === selectedRunId);
    if (!run) {
      setScorecards((s) => ({ ...s, selected: null }));
      return;
    }
    void (async () => {
      const { buildScorecard } = await import('../../../src/local-ai/eval/aggregate');
      setScorecards((s) => ({ ...s, selected: buildScorecard(run) }));
    })();
  }, [selectedRunId, runs]);

  // ── Before/after diff ──
  useEffect(() => {
    if (!beforeRunId || !afterRunId) {
      setScorecards((s) => ({ ...s, diff: null }));
      return;
    }
    const before = runs.find((r) => r.runId === beforeRunId);
    const after = runs.find((r) => r.runId === afterRunId);
    if (!before || !after) {
      setScorecards((s) => ({ ...s, diff: null }));
      return;
    }
    void (async () => {
      const { buildScorecard, diffScorecards } = await import(
        '../../../src/local-ai/eval/aggregate'
      );
      setScorecards((s) => ({
        ...s,
        diff: diffScorecards(buildScorecard(before), buildScorecard(after)),
      }));
    })();
  }, [beforeRunId, afterRunId, runs]);

  // ── A-B compare ──
  const abRun = useMemo(
    () => runs.find((r) => r.runId === abRunId) ?? null,
    [runs, abRunId],
  );
  const abModelOptions = useMemo(() => {
    if (!abRun) return [];
    return Array.from(new Set(abRun.results.map((r) => r.modelId)));
  }, [abRun]);

  useEffect(() => {
    setAb(null);
    setAbError(null);
    if (!abRun || !abModelA || !abModelB) return;
    if (abModelA === abModelB) {
      setAbError('Pick two different models to compare.');
      return;
    }
    void (async () => {
      try {
        const { compareModels } = await import('../../../src/local-ai/eval/aggregate');
        setAb(compareModels(abRun, abModelA, abModelB));
      } catch (err) {
        setAbError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [abRun, abModelA, abModelB]);

  // ── Render ──
  return (
    <div className="space-y-8">
      <SectionDivider />

      <header>
        <h2
          className="text-xl tracking-tight"
          style={{ fontFamily: 'var(--eco-font-display)', color: 'var(--eco-text)' }}
        >
          Eval Harness
        </h2>
        <p className="mt-1.5 text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
          Run the fixed chat prompt set across catalog models, score each result
          against the rubric, and read the scorecard. Run a labeled baseline, ship
          a backend change, run an after pass, then diff the two to prove the fix.
        </p>
      </header>

      {/* ── Run controls ── */}
      <PanelSection title="Run">
        <div
          className="mb-4 rounded-lg p-3 text-xs leading-relaxed"
          style={{
            background: 'var(--eco-amber-soft, rgba(212, 168, 83, 0.12))',
            border: '1px solid var(--eco-amber, #d4a853)',
            color: 'var(--eco-text-secondary)',
          }}
        >
          <strong style={{ color: 'var(--eco-text)' }}>Heads up —</strong> running
          downloads and executes real models on-device. A cold run is a multi-GB
          download and can take several minutes <em>per model</em>. Keep the tab
          focused. Cancel finalizes after the current generation.
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label">
            <input
              type="text"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
              disabled={running}
              placeholder="baseline"
              className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          </Field>
          <Field label="Max tokens / generation">
            <input
              type="number"
              min={16}
              max={4096}
              value={maxTokensCap}
              onChange={(e) => {
                setMaxTokensCap(clampInt(e.target.value, 16, 4096, 512));
              }}
              disabled={running}
              className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          </Field>
          <Field label="Decode mode">
            <select
              value={samplingMode}
              onChange={(e) => {
                setSamplingMode(e.target.value === 'greedy' ? 'greedy' : 'sampled');
              }}
              disabled={running}
              className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-sm outline-none"
              style={inputStyle}
            >
              <option value="sampled">sampled — production profile (realistic feel)</option>
              <option value="greedy">greedy — deterministic argmax (reproducible)</option>
            </select>
          </Field>
          <Field label="Samples / probe">
            <input
              type="number"
              min={1}
              max={10}
              value={samplesPerProbe}
              disabled={running}
              onChange={(e) => {
                setSamplesPerProbe(clampInt(e.target.value, 1, 10, 1));
              }}
              className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          </Field>
          </div>

        <div className="mt-4">
          <div
            className="mb-2 text-xs font-medium uppercase tracking-wide"
            style={{ color: 'var(--eco-text-secondary)' }}
          >
            Models ({selectedModelIds.length} selected)
          </div>
          {pickerModels.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--eco-text-muted)' }}>
              Loading catalog…
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {pickerModels.map((m) => {
                const checked = selectedModelIds.includes(m.id);
                return (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg p-3"
                    style={{
                      border: `1px solid ${checked ? 'var(--eco-primary)' : 'var(--eco-border-muted)'}`,
                      background: checked
                        ? 'var(--eco-primary-soft)'
                        : 'var(--eco-surface-elevated)',
                      opacity: running ? 0.6 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={running}
                      onChange={() => {
                        toggleModel(m.id);
                      }}
                      className="mt-0.5"
                      style={{ accentColor: 'var(--eco-primary)' }}
                    />
                    <span className="min-w-0">
                      <span
                        className="block truncate text-sm font-medium"
                        style={{ color: 'var(--eco-text)' }}
                      >
                        {m.friendlyName}
                      </span>
                      <span
                        className="block text-xs"
                        style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)' }}
                      >
                        {m.sizeGB} GB · {m.runtime} · {m.id}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {running ? (
            <Button onClick={handleCancel} variant="danger">
              Cancel run
            </Button>
          ) : (
            <Button
              onClick={() => {
                void handleRun();
              }}
              variant="primary"
              disabled={selectedModelIds.length === 0}
            >
              Run eval
            </Button>
          )}
          {!running && selectedCaptureIds.length > 0 && (
            <span
              className="text-xs"
              style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)' }}
            >
              {capturedOnly
                ? `captured probes only (${String(selectedCaptureIds.length)})`
                : `+${String(selectedCaptureIds.length)} captured probe${selectedCaptureIds.length === 1 ? '' : 's'}`}
            </span>
          )}
          {running && progress && <ProgressReadout progress={progress} />}
        </div>

        {autorunNote && (
          <p
            className="mt-3 rounded-lg p-3 text-xs"
            style={{
              background: 'var(--eco-surface)',
              border: '1px solid var(--eco-border-muted)',
              color: 'var(--eco-text-secondary)',
              fontFamily: 'var(--eco-font-mono)',
            }}
          >
            {autorunNote}
          </p>
        )}

        {runError && (
          <p
            className="mt-3 rounded-lg p-3 text-sm"
            style={{
              background: 'var(--eco-error-soft, rgba(199, 92, 74, 0.1))',
              color: 'var(--eco-coral)',
              fontFamily: 'var(--eco-font-mono)',
            }}
          >
            {runError}
          </p>
        )}
      </PanelSection>

      {/* ── Captured failures (failure-capture loop) ── */}
      <PanelSection title={`Captured failures (${String(captures.length)})`}>
        <p className="mb-3 text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
          Real conversations flagged from /chat (enable with{' '}
          <code style={{ fontFamily: 'var(--eco-font-mono)' }}>?eco-capture=1</code>). Select
          captures to replay them as multi-turn probes in the next run. Captures live in this
          browser only — export/import to move them between prod and localhost.
        </p>

        {captures.length === 0 ? (
          <EmptyHint>
            Nothing captured yet. Open /chat?eco-capture=1, hover a bad reply, and choose
            “Flag for eval…” from its ··· menu.
          </EmptyHint>
        ) : (
          <ul className="space-y-2">
            {[...captures].reverse().map((capture) => {
              const checked = selectedCaptureIds.includes(capture.captureId);
              return (
                <li
                  key={capture.captureId}
                  className="flex items-start gap-3 rounded-lg px-4 py-3"
                  style={{
                    border: `1px solid ${checked ? 'var(--eco-primary)' : 'var(--eco-border-muted)'}`,
                    background: checked ? 'var(--eco-primary-soft)' : 'var(--eco-surface-elevated)',
                    opacity: running ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={running}
                    onChange={() => {
                      toggleCapture(capture.captureId);
                    }}
                    className="mt-1"
                    style={{ accentColor: 'var(--eco-primary)' }}
                    aria-label={`Include ${capture.captureId} in the next run`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span
                        className="rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{
                          background: 'var(--eco-surface)',
                          color: 'var(--eco-text)',
                          fontFamily: 'var(--eco-font-mono)',
                        }}
                      >
                        {capture.tags.join(', ') || 'untagged'}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)' }}>
                        {capture.captureId}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
                        {capture.modelId ?? 'model unknown'}
                        {capture.history.length > 0
                          ? ` · ${String(capture.history.length)} prior turn${capture.history.length === 1 ? '' : 's'}`
                          : ''}
                        {' · '}
                        {formatTimestamp(capture.capturedAt)}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-sm" style={{ color: 'var(--eco-text)' }}>
                      {capture.prompt}
                    </span>
                    {capture.note && (
                      <span className="mt-0.5 block truncate text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
                        {capture.note}
                      </span>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={running}
                    onClick={() => {
                      void handleCaptureDelete(capture.captureId);
                    }}
                    aria-label={`Delete ${capture.captureId}`}
                  >
                    Delete
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {captures.length > 0 && (
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm" style={{ color: 'var(--eco-text)' }}>
            <input
              type="checkbox"
              checked={capturedOnly}
              disabled={running || selectedCaptureIds.length === 0}
              onChange={() => {
                setCapturedOnly((v) => !v);
              }}
              style={{ accentColor: 'var(--eco-primary)' }}
            />
            Run captured probes only (skip the fixed prompt set)
          </label>
        )}

        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            onClick={() => {
              void handleCaptureCopy();
            }}
            variant="secondary"
            disabled={captures.length === 0}
          >
            {captureCopied ? 'Copied' : 'Copy as JSON'}
          </Button>
          <Button
            onClick={() => {
              void handleCaptureDownload();
            }}
            variant="secondary"
            disabled={captures.length === 0}
          >
            Download .json
          </Button>
          <Button
            onClick={() => {
              void refreshCaptures();
            }}
            variant="ghost"
          >
            Refresh
          </Button>
        </div>

        <div className="mt-5 border-t pt-5" style={{ borderColor: 'var(--eco-border-muted)' }}>
          <div
            className="mb-1.5 text-xs font-medium uppercase tracking-wide"
            style={{ color: 'var(--eco-text-secondary)' }}
          >
            Import captures
          </div>
          <p className="mb-2 text-xs" style={{ color: 'var(--eco-text-muted)' }}>
            Paste an export from another origin (e.g. flagged on econetwork.ai, replayed here).
            Duplicates are skipped by capture id.
          </p>
          <textarea
            value={captureImportInput}
            onChange={(e) => {
              setCaptureImportInput(e.target.value);
            }}
            rows={4}
            placeholder='{ "schemaVersion": 1, "captures": [ … ] }'
            className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-xs outline-none"
            style={{ ...inputStyle, fontFamily: 'var(--eco-font-mono)' }}
          />
          <div className="mt-3">
            <Button
              onClick={() => {
                void handleCaptureImport();
              }}
              variant="secondary"
              disabled={captureImportInput.trim().length === 0}
            >
              Import captures
            </Button>
          </div>
          {captureNote && (
            <p
              className="mt-3 rounded-lg p-3 text-xs"
              style={{
                background:
                  captureNote.tone === 'error'
                    ? 'var(--eco-error-soft, rgba(199, 92, 74, 0.1))'
                    : 'var(--eco-primary-soft)',
                color:
                  captureNote.tone === 'error'
                    ? 'var(--eco-coral)'
                    : 'var(--eco-text-secondary)',
                fontFamily: 'var(--eco-font-mono)',
              }}
            >
              {captureNote.text}
            </p>
          )}
        </div>
      </PanelSection>

      {/* ── Scorecard ── */}
      <PanelSection title="Scorecard">
        <RunSelect
          runs={runs}
          value={selectedRunId}
          onChange={setSelectedRunId}
          placeholder="Select a run to view its scorecard"
        />
        {scorecards.selected ? (
          <div className="mt-4">
            <ScorecardMeta scorecard={scorecards.selected} />
            <ScorecardTable scorecard={scorecards.selected} />
          </div>
        ) : (
          <EmptyHint>Select a saved run above to see its scorecard.</EmptyHint>
        )}

        {/* ── Judge-score backfill ── */}
        <div className="mt-5 border-t pt-5" style={{ borderColor: 'var(--eco-border-muted)' }}>
          <div
            className="mb-1.5 text-xs font-medium uppercase tracking-wide"
            style={{ color: 'var(--eco-text-secondary)' }}
          >
            Fill judge scores
          </div>
          <p className="mb-2 text-xs" style={{ color: 'var(--eco-text-muted)' }}>
            Backfill coherence / taskFit (1–5) on the selected run without re-running.
            Paste a JSON array:{' '}
            <code style={{ fontFamily: 'var(--eco-font-mono)' }}>
              [{'{'} &quot;promptId&quot;, &quot;modelId&quot;, &quot;sampleIndex&quot;?, &quot;coherence&quot;?, &quot;taskFit&quot;? {'}'}]
            </code>
          </p>
          <textarea
            value={judgeInput}
            onChange={(e) => {
              setJudgeInput(e.target.value);
            }}
            disabled={!selectedRunId}
            rows={5}
            placeholder='[{ "promptId": "math-1", "modelId": "candidate/lfm2.5-1.2b-instruct-onnx", "coherence": 4, "taskFit": 5 }]'
            className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-xs outline-none"
            style={{ ...inputStyle, fontFamily: 'var(--eco-font-mono)', opacity: selectedRunId ? 1 : 0.6 }}
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <Button
              onClick={() => {
                void handleCopyJudgeSkeleton();
              }}
              variant="ghost"
              disabled={!selectedRunId}
            >
              {skeletonCopied ? 'Copied skeleton' : 'Copy judge skeleton'}
            </Button>
            <Button
              onClick={() => {
                void handleApplyJudgeScores();
              }}
              variant="secondary"
              disabled={!selectedRunId || judgeInput.trim().length === 0}
            >
              Apply judge scores
            </Button>
          </div>
          {judgeNote && (
            <p
              className="mt-3 rounded-lg p-3 text-xs"
              style={{
                background:
                  judgeNote.tone === 'error'
                    ? 'var(--eco-error-soft, rgba(199, 92, 74, 0.1))'
                    : 'var(--eco-primary-soft)',
                color:
                  judgeNote.tone === 'error'
                    ? 'var(--eco-coral)'
                    : 'var(--eco-text-secondary)',
                fontFamily: 'var(--eco-font-mono)',
              }}
            >
              {judgeNote.text}
            </p>
          )}
        </div>
      </PanelSection>

      {/* ── Before / after diff ── */}
      <PanelSection title="Before → after diff">
        <p className="mb-3 text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
          The view to judge a fix. Pick a baseline (before) and an after-fix run.
          Green = improvement, red = regression. Only models present in both runs
          appear.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Before">
            <RunSelect runs={runs} value={beforeRunId} onChange={setBeforeRunId} placeholder="baseline run" />
          </Field>
          <Field label="After">
            <RunSelect runs={runs} value={afterRunId} onChange={setAfterRunId} placeholder="after-fix run" />
          </Field>
        </div>
        {scorecards.diff ? (
          <div className="mt-4">
            <p className="mb-2 text-xs" style={{ color: 'var(--eco-text-muted)' }}>
              <span style={{ fontFamily: 'var(--eco-font-mono)' }}>{scorecards.diff.beforeLabel}</span>
              {' → '}
              <span style={{ fontFamily: 'var(--eco-font-mono)' }}>{scorecards.diff.afterLabel}</span>
            </p>
            <DiffTable diff={scorecards.diff} />
          </div>
        ) : (
          <EmptyHint>Pick two runs to compare.</EmptyHint>
        )}
      </PanelSection>

      {/* ── A-B model compare ── */}
      <PanelSection title="A / B model compare">
        <p className="mb-3 text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
          Two models head-to-head <em>within one run</em> (same device, same prompts).
          Deltas are B − A.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Run">
            <RunSelect
              runs={runs}
              value={abRunId}
              onChange={(id) => {
                setAbRunId(id);
                setAbModelA(null);
                setAbModelB(null);
              }}
              placeholder="select a run"
            />
          </Field>
          <Field label="Model A">
            <ModelSelect options={abModelOptions} value={abModelA} onChange={setAbModelA} disabled={!abRun} />
          </Field>
          <Field label="Model B">
            <ModelSelect options={abModelOptions} value={abModelB} onChange={setAbModelB} disabled={!abRun} />
          </Field>
        </div>
        {abError && (
          <p className="mt-3 text-sm" style={{ color: 'var(--eco-text-muted)' }}>
            {abError}
          </p>
        )}
        {ab && <AbCompare ab={ab} />}
        {!ab && !abError && <EmptyHint>Pick a run and two different models.</EmptyHint>}
      </PanelSection>

      {/* ── Blind pairwise scorer ── */}
      <PanelSection title="Blind pairwise">
        <PairwiseJudge
          runs={runs}
          armA={pwArmA}
          armB={pwArmB}
          onArmChange={(side, arm) => {
            if (side === 'A') setPwArmA(arm);
            else setPwArmB(arm);
          }}
          judge={pwJudge}
          onJudgeChange={setPwJudge}
          view={pwView}
          position={Math.min(pwIndex + 1, pwPairing.pairs.length)}
          pairCount={pwPairing.pairs.length}
          excludedCount={pwExcludedCount}
          onVerdict={handlePwVerdict}
          onSkip={handlePwSkip}
          tally={pwTally}
          revealed={pwAllDecided || (pwSession?.revealedEarly ?? false)}
          onReveal={handlePwReveal}
          onDownload={handlePwDownload}
          notice={
            pwSession === null
              ? 'Pick two arms — a run and a model on each side.'
              : pwArmA?.runId === pwArmB?.runId && pwArmA?.modelId === pwArmB?.modelId
                ? 'Both arms name the same model in the same run — pick a different model or a different run.'
                : pwPairing.pairs.length === 0
                  ? 'No judgeable pairs: the two arms share no prompt with a usable reply on both sides.'
                  : pwView === null
                    ? 'Every pair has a verdict.'
                    : null
          }
        />
      </PanelSection>

      {/* ── Saved runs ── */}
      <PanelSection title={`Saved runs (${String(runs.length)})`}>
        <div className="mb-4 flex flex-wrap gap-3">
          <Button
            onClick={() => {
              void handleCopy();
            }}
            variant="secondary"
            disabled={runs.length === 0}
          >
            {copied ? 'Copied' : 'Copy as JSON'}
          </Button>
          <Button
            onClick={() => {
              void handleDownload();
            }}
            variant="secondary"
            disabled={runs.length === 0}
          >
            Download .json
          </Button>
          <Button
            onClick={() => {
              void handleClear();
            }}
            variant="secondary"
            disabled={runs.length === 0}
          >
            Clear eval runs
          </Button>
          <Button
            onClick={() => {
              void refreshRuns();
            }}
            variant="ghost"
          >
            Refresh
          </Button>
        </div>
        {runs.length === 0 ? (
          <EmptyHint>No eval runs saved yet. Run a baseline above to get started.</EmptyHint>
        ) : (
          <ul className="space-y-2">
            {[...runs].reverse().map((run) => {
              const active = run.runId === selectedRunId;
              const modelCount = new Set(run.results.map((r) => r.modelId)).size;
              return (
                <li key={run.runId}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRunId(run.runId);
                    }}
                    className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-4 py-3 text-left"
                    style={{
                      border: `1px solid ${active ? 'var(--eco-primary)' : 'var(--eco-border-muted)'}`,
                      background: active ? 'var(--eco-primary-soft)' : 'var(--eco-surface-elevated)',
                    }}
                  >
                    <span
                      className="rounded-full px-2 py-0.5 text-xs font-medium"
                      style={{ background: 'var(--eco-surface)', color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)' }}
                    >
                      {run.label}
                    </span>
                    <span
                      className="text-xs"
                      style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)' }}
                    >
                      {run.runId}
                    </span>
                    <span className="ml-auto text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
                      {modelCount} model{modelCount === 1 ? '' : 's'} · {run.results.length} results · {run.device.deviceClass}
                      {run.config
                        ? ` · ${run.config.samplingMode} · n=${String(run.config.samplesPerProbe)} · ${run.config.promptSetHash}`
                        : ''}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--eco-text-muted)' }}>
                      {formatTimestamp(run.startedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}

// ─── Panel-local layout helpers ──────────────────────────────────────────────

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3
        className="mb-3 text-sm font-medium uppercase tracking-wide"
        style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}
      >
        {title}
      </h3>
      <div
        className="rounded-xl p-5"
        style={{ border: '1px solid var(--eco-border-muted)', background: 'var(--eco-surface-elevated)' }}
      >
        {children}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span
        className="mb-1.5 block text-xs font-medium uppercase tracking-wide"
        style={{ color: 'var(--eco-text-secondary)' }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function SectionDivider() {
  return (
    <div
      aria-hidden
      style={{
        height: '1px',
        background:
          'linear-gradient(to right, transparent, var(--eco-border-muted), transparent)',
      }}
    />
  );
}

function ProgressReadout({ progress }: { progress: EvalProgress }) {
  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const detail = [progress.modelId, progress.promptId].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-3 text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
        <span style={{ fontFamily: 'var(--eco-font-mono)' }}>
          {progress.phase}
          {detail ? ` — ${detail}` : ''}
          {progress.note ? ` (${progress.note})` : ''}
        </span>
        <span style={{ fontFamily: 'var(--eco-font-mono)', color: 'var(--eco-text)' }}>
          {progress.completed} / {progress.total}
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--eco-border-muted)' }}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {/* Width-only fill — no transition, so it respects reduced-motion by default. */}
        <div className="h-full rounded-full" style={{ width: `${String(pct)}%`, background: 'var(--eco-primary)' }} />
      </div>
    </div>
  );
}

function RunSelect({
  runs,
  value,
  onChange,
  placeholder,
}: {
  runs: EvalRun[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder: string;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => {
        onChange(e.target.value || null);
      }}
      className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-sm outline-none"
      style={inputStyle}
    >
      <option value="">{placeholder}</option>
      {[...runs].reverse().map((run) => (
        <option key={run.runId} value={run.runId}>
          {run.label} — {run.runId} ({new Set(run.results.map((r) => r.modelId)).size} models)
        </option>
      ))}
    </select>
  );
}

function ModelSelect({
  options,
  value,
  onChange,
  disabled,
}: {
  options: string[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => {
        onChange(e.target.value || null);
      }}
      disabled={disabled}
      className="w-full rounded-[var(--eco-radius-sm)] px-3 py-2 text-sm outline-none"
      style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }}
    >
      <option value="">select a model</option>
      {options.map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </select>
  );
}

// ─── Style + format helpers ──────────────────────────────────────────────────

const inputStyle: CSSProperties = {
  background: 'var(--eco-surface)',
  border: '1px solid var(--eco-border-muted)',
  color: 'var(--eco-text)',
  fontFamily: 'var(--eco-font-body)',
};

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
