// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eval-harness runner.
 *
 * Drives real on-device generation across catalog models × the fixed prompt
 * set, captures output + perf, scores each result with the automated rubric,
 * and assembles a labeled `EvalRun` that storage persists and aggregate rolls
 * up. The point is a measure-first, before/after methodology: run the SAME
 * harness with `label: 'baseline'` today and `label: 'after-phase-1'` after the
 * sampling-plumbing fix, then diff the two scorecards — the delta is the fix.
 *
 * Every external dependency is injected via `EvalRunnerDeps` with a production
 * default, so the whole runner is unit-testable in plain Vitest with fakes — no
 * browser, no model, no catalog. The DEFAULT `generate` (which boots the
 * local-AI stack, loads the model, and streams through the runtime lifecycle)
 * is the only browser-coupled path; tests inject `generate` and never touch it.
 *
 * ── Prompt fidelity ─────────────────────────────────────────────────────────
 * Since R4a the runner composes its messages through the SAME pure
 * `assemble()` production dispatch uses (`local-ai/prompt/assemble.ts`), so
 * "the harness measures what users get" is enforced by the call graph rather
 * than by two hand-maintained compositions agreeing. The default
 * `buildSystemPrompt` delegates to `getOnDeviceSystemPrompt(modelId)` — the
 * lean Eco identity prompt, which is the base prompt production feeds the
 * model. We import the small, React-free assembler rather than the `useChat`
 * hook (which would pull React transitively into a pure-logic module).
 *
 * One production layer is DELIBERATELY not reproduced: user custom
 * instructions. It is now a single explicit `customInstructions: ''` argument
 * at the `assemble()` call in `composeProbeMessages`, not an omission. The
 * reason is comparability — custom instructions are per-user free text, so a
 * run that included them would measure that user's prompt rather than the
 * shipped default, and two runs would stop being comparable. Measuring the
 * effect of custom instructions is a separate arm, not the baseline.
 *
 * Options are NOT assembled here: `assemble()` returns the snake_case shape the
 * legacy chat seam takes, while the harness needs `GenerateOptions` and layers
 * its own arms and per-run cap on top. Both resolve the same sampling row from
 * the same `getGenerationProfile`, so there is no second source of truth —
 * only a second wire shape, which R4b's `TokenEvent` seam removes.
 */

import type { ChatIntent } from '../../lib/chat-intent';
import {
  getGenerationProfile,
} from '../../lib/chat-intent';
import { buildBranchRecaps } from '../../lib/detail-recap';
import { getOnDeviceSystemPrompt } from '../../lib/system-prompt';
import { assemble } from '../prompt/assemble';
import { getModel } from '../catalog/catalog';
import { getDeviceProfile } from '../device/profile';
import { classifyDeviceClass } from '../evidence/seed';
import { profileKey } from '../evidence/ledger';
import { bootstrapLocalAi } from '../bootstrap';
import { loadModel, generate as generateThroughLifecycle } from '../runtime/lifecycle';
import type { ModelConfig } from '../types';
import type { ChatMessage, GenerateOptions, TokenEvent } from '../runtime/types';
import { getEvalCandidateModel } from './eval-candidates';
import { scoreResult } from './rubric';
import { saveEvalRun } from './storage';
import { EVAL_PROMPTS } from './prompts';
import { CONTEXT_BOUNDARY_PROBES, CONTEXT_STRESS_PROBES } from './context-stress-probes';
import type {
  EvalGroundingRecord,
  EvalMessageTopology,
  EvalPromptContractId,
  EvalPromptSpec,
  EvalPromptTrace,
  EvalResult,
  EvalRun,
  EvalRunConfigFingerprint,
  EvalRunDevice,
  EvalRuntimeAdapter,
  SamplingMode,
} from './types';

// ─── Defaults ──────────────────────────────────────────────────────────────

/** Hard cap on tokens per generation. Keeps full-catalog runs bounded. */
const DEFAULT_MAX_TOKENS_CAP = 512;
/** Token-stream timeout. Applies to streaming ONLY, never to model load. */
const DEFAULT_GENERATION_TIMEOUT_MS = 60_000;
/** Default decode mode: the production sampling profile (realistic-feel arm). */
const DEFAULT_SAMPLING_MODE: SamplingMode = 'sampled';
/** Default replicate count: one generation per prompt/model. */
const DEFAULT_SAMPLES_PER_PROBE = 1;
/** Default run-wide message composition: production's user-turn hints. */
const DEFAULT_MESSAGE_TOPOLOGY: EvalMessageTopology = 'production-user-turn-hints';
/** Safety cap so a URL typo cannot schedule an accidental all-night local eval. */
const MAX_SAMPLES_PER_PROBE = 10;
/**
 * Harness composition version. Bump when message composition / hint placement
 * changes so two runs are only treated as comparable at the same version.
 * v1 = Wave 2.6 Stage 1 (per-intent hints on the user turn) + greedy/sampled
 * decode mode.
 */
const HARNESS_VERSION = 1;
// NAME RETAINED DELIBERATELY (R4a): per-intent hints were deleted in R1, so this
// era no longer places any. The string is written into persisted runs and is the
// key two runs are compared on, so renaming it would silently split the history.
const COMPOSITION_ERA = 'wave2.6-stage1-user-turn-hints';
const GEMMA_NATIVE_ECO_CONTRACT = [
  'You are Eco, a private on-device assistant.',
  'Be natural, useful, and honest.',
  'Answer the user task directly.',
  'Match depth to the request.',
  'Follow explicit format and length instructions exactly.',
].join(' ');

// ─── Public contract ─────────────────────────────────────────────────────────

/**
 * The STREAM seam. Yields `TokenEvent`s for one (model, messages, options)
 * against an ALREADY-LOADED model. Loading is `prepareModel`'s job, run untimed
 * before the stream timer arms — so the per-generation timeout covers only the
 * token stream, never a cold model download. The default is the runtime
 * lifecycle's `generate` (stream-only; no bootstrap/load).
 */
export type EvalGenerationFn = (
  model: ModelConfig,
  messages: ChatMessage[],
  options: GenerateOptions,
) => AsyncIterable<TokenEvent>;

/**
 * The LOAD seam. Boots the stack and loads `model` into the lifecycle singleton,
 * UNTIMED — a cold multi-GB download can take minutes and must NOT count against
 * the stream timeout. Called once per model before its prompt loop; a throw
 * (load/cooldown failure) is recorded as an error result per prompt rather than
 * crashing the run.
 */
export type EvalPrepareModelFn = (model: ModelConfig, signal?: AbortSignal) => Promise<void>;

/**
 * Injectable dependencies. Every field has a production default; tests override
 * the ones they need (injecting `prepareModel` + `generate` skips bootstrap/load
 * and streams against fakes — no browser/model required).
 */
export type EvalRunnerDeps = {
  /** Default: lifecycle `generate(messages, options)` — stream-only, model must be loaded. */
  generate?: EvalGenerationFn;
  /** Default: bootstrapLocalAi() then loadModel(model, {signal}) — UNTIMED. */
  prepareModel?: EvalPrepareModelFn;
  /** Default: catalog.getModel. */
  getModel?: (id: string) => ModelConfig | null;
  /** Default: getGenerationProfile(intent, true, modelId, {allowValidationModel:true}). */
  buildOptions?: (modelId: string, intent: ChatIntent) => GenerateOptions;
  /** Default: getOnDeviceSystemPrompt(modelId) — the production on-device prompt. */
  buildSystemPrompt?: (modelId: string) => string;
  /** Default: device/profile + evidence/seed + evidence/ledger. */
  getDevice?: () => EvalRunDevice;
  /** Default: storage.saveEvalRun. */
  save?: (run: EvalRun) => void;
  /** Default: Date.now. Also drives the per-generation deadline (test-injectable). */
  now?: () => number;
  /** Default: a random run id. */
  generateRunId?: () => string;
};

export type EvalProgress = {
  phase: 'loading' | 'generating' | 'scoring' | 'model-done' | 'run-done' | 'error';
  modelId: string;
  promptId?: string;
  /** Results completed so far. */
  completed: number;
  /** Total scheduled = models × prompts × samplesPerProbe. */
  total: number;
  note?: string;
};

export type EvalRunConfig = {
  /** 'baseline' | 'after-phase-1' | custom. */
  label: string;
  modelIds: string[];
  /** Subset of prompt ids (fixed ∪ context-stress ∪ extra); default all. */
  promptIds?: string[];
  /**
   * Session-scoped probes appended to the checked-in pool (e.g. captured
   * failures selected in the diagnostics panel), deduped by id — a collision
   * with a checked-in id keeps the checked-in spec.
   */
  extraPrompts?: EvalPromptSpec[];
  /**
   * Include the diagnostic context-stress and context-boundary probes
   * (context-stress-probes.ts). Off by default: they measure headroom at a
   * model's context ceiling rather than answer quality, so they would skew
   * routine scorecard composites if they rode every run. The URL param that
   * arms them is `eco-eval-arms=1`.
   */
  includeResearchArms?: boolean;
  /**
   * Diagnostics-only run-wide message composition lane. Per-turn hints were
   * removed (R1); this field now only gates the Gemma-native contract lane.
   */
  messageTopology?: EvalMessageTopology;
  /** Hard cap per generation (default 512 — keeps runs fast). */
  maxTokensCap?: number;
  /** Applies to the TOKEN STREAM only, not load (default 60000). */
  perGenerationTimeoutMs?: number;
  /**
   * Decode mode (default 'sampled' = the production per-model profile). 'greedy'
   * overrides each generation to deterministic argmax (temperature 0) so the run
   * is reproducible — the decision-grade arm for correctStop/exactness/format
   * before-after deltas. Recorded on the run's `config` fingerprint so a greedy
   * run is never silently compared against a sampled one.
   */
  samplingMode?: SamplingMode;
  /**
   * Replicate generations per prompt/model (default 1, clamped 1..10). Use >1
   * for sampled mode to estimate variance without hand-running the same URL.
   */
  samplesPerProbe?: number;
  onProgress?: (p: EvalProgress) => void;
  /** Aborts the whole run after the current generation finalizes. */
  signal?: AbortSignal;
};

// ─── Default dependency implementations ──────────────────────────────────────

/**
 * Production load seam: boot the local-AI stack and load the model into the
 * lifecycle singleton. UNTIMED on purpose — a cold multi-GB download can take
 * minutes, and the runner calls this BEFORE arming the stream timer + capturing
 * `startMs`, so the per-generation timeout covers only the token stream. Tests
 * inject a no-op `prepareModel` and never reach this.
 */
async function defaultPrepareModel(model: ModelConfig, signal?: AbortSignal): Promise<void> {
  await bootstrapLocalAi();
  if (model.runtime === 'webllm') {
    // A WebLLM model serves from WebLLM's own Cache API namespaces, which only
    // the cache bridge populates (the engine's base URL is a same-origin path
    // that deliberately 404s). Setup and upgrade run the bridge for catalog
    // models; nothing runs it for an eval-only model, so `loadModel` alone
    // fails with a cache miss. The bridge has a returning-user fast path, so
    // this is a no-op once the weights are present.
    const { bridgeDownloadWebLLMModel } = await import('../runtime/webllm-cache-bridge');
    await bridgeDownloadWebLLMModel(model, { signal });
  }
  await loadModel(model, { signal });
}

/**
 * Production stream seam: stream tokens through the runtime lifecycle against
 * the ALREADY-LOADED model (loaded by `defaultPrepareModel`). Stream-only — no
 * bootstrap/load here, so this runs entirely inside the timed window. Tests
 * inject `generate` and never reach this.
 */
function defaultGenerate(
  _model: ModelConfig,
  messages: ChatMessage[],
  options: GenerateOptions,
): AsyncIterable<TokenEvent> {
  return generateThroughLifecycle(messages, options);
}

/** Default option builder: the rich per-model sampling profile for the intent. */
function defaultBuildOptions(modelId: string, intent: ChatIntent): GenerateOptions {
  const profile = getGenerationProfile(intent, true, modelId, { allowValidationModel: true });
  const options: GenerateOptions = {
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
  };
  if (profile.topP !== undefined) options.topP = profile.topP;
  if (profile.topK !== undefined) options.topK = profile.topK;
  if (profile.repetitionPenalty !== undefined) options.repetitionPenalty = profile.repetitionPenalty;
  if (profile.noRepeatNgramSize !== undefined) options.noRepeatNgramSize = profile.noRepeatNgramSize;
  return options;
}

/** Default device fingerprint — mirrors DiagnosticsClient + smoke.getProfileKey. */
function defaultGetDevice(): EvalRunDevice {
  try {
    const profile = getDeviceProfile();
    return {
      profileKey: profileKey(profile),
      browserClass: profile.browserClass,
      webgpuSupport: profile.webgpuSupport,
      deviceClass: classifyDeviceClass(profile),
    };
  } catch {
    return {
      profileKey: 'unknown',
      browserClass: 'unknown',
      webgpuSupport: 'unknown',
      deviceClass: 'unknown',
    };
  }
}

/** Default run id: timestamp + random suffix (no crypto dependency required). */
function defaultGenerateRunId(): string {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Default model resolver: catalog ∪ eval-candidates. The eval candidates
 * (local-ai/eval/eval-candidates.ts) are NOT in the shipping catalog, so the
 * harness resolves them here while keeping `getModel` (catalog-only) untouched.
 * Tests inject `getModel` and never reach this.
 */
function defaultGetModel(id: string): ModelConfig | null {
  return getModel(id) ?? getEvalCandidateModel(id);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

type ResolvedDeps = {
  generate: EvalGenerationFn;
  prepareModel: EvalPrepareModelFn;
  getModel: (id: string) => ModelConfig | null;
  buildOptions: (modelId: string, intent: ChatIntent) => GenerateOptions;
  buildSystemPrompt: (modelId: string) => string;
  getDevice: () => EvalRunDevice;
  save: (run: EvalRun) => void;
  now: () => number;
  generateRunId: () => string;
};

function resolveDeps(deps?: EvalRunnerDeps): ResolvedDeps {
  return {
    generate: deps?.generate ?? defaultGenerate,
    prepareModel: deps?.prepareModel ?? defaultPrepareModel,
    getModel: deps?.getModel ?? defaultGetModel,
    buildOptions: deps?.buildOptions ?? defaultBuildOptions,
    buildSystemPrompt: deps?.buildSystemPrompt ?? getOnDeviceSystemPrompt,
    getDevice: deps?.getDevice ?? defaultGetDevice,
    save: deps?.save ?? saveEvalRun,
    now: deps?.now ?? Date.now,
    generateRunId: deps?.generateRunId ?? defaultGenerateRunId,
  };
}

function runtimeAdapterFor(model: ModelConfig): EvalRuntimeAdapter {
  if (model.runtime === 'transformers') return 'transformers';
  if (model.runtime === 'litert') return 'litert';
  if (model.runtime === 'webllm') return 'webllm';
  return 'unknown';
}

/**
 * Pick the prompt specs to run from the fixed (∪ context-stress ∪ extra) pool,
 * preserving pool order. The diagnostic context-stress and context-boundary
 * headroom probes join only when explicitly requested (`includeResearchArms`,
 * off by default), so a full run's default set and its fingerprint stay
 * unchanged. Extras are deduped by id — the checked-in spec always wins a
 * collision.
 */
function selectPrompts(
  promptIds?: string[],
  extraPrompts?: EvalPromptSpec[],
  includeResearchArms?: boolean,
): EvalPromptSpec[] {
  const pool: EvalPromptSpec[] = [
    ...EVAL_PROMPTS,
    ...(includeResearchArms ? [...CONTEXT_STRESS_PROBES, ...CONTEXT_BOUNDARY_PROBES] : []),
  ];
  const seen = new Set(pool.map((p) => p.id));
  for (const spec of extraPrompts ?? []) {
    if (seen.has(spec.id)) continue;
    pool.push(spec);
    seen.add(spec.id);
  }
  if (!promptIds || promptIds.length === 0) return pool;
  const wanted = new Set(promptIds);
  return pool.filter((p) => wanted.has(p.id));
}

/**
 * Collapse options to deterministic greedy decode (argmax). Sets temperature 0
 * — which the Transformers worker already maps to `do_sample:false`
 * (transformers-generate-args) and the LiteRT adapter maps to
 * SamplerType.GREEDY — and DROPS the nucleus/penalty knobs: they don't apply
 * under argmax and would misrepresent the recorded `generationOptions`. The
 * result is a pure, reproducible decode comparable across runtimes (LiteRT has
 * no repetition-penalty knob, so dropping it also levels the A/B).
 */
function toGreedyOptions(options: GenerateOptions): GenerateOptions {
  const greedy: GenerateOptions = { temperature: 0 };
  if (options.maxTokens !== undefined) greedy.maxTokens = options.maxTokens;
  return greedy;
}

/** Clamp replicate count to a deliberate, local-hardware-safe range. */
function normalizeSamplesPerProbe(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SAMPLES_PER_PROBE;
  return Math.min(MAX_SAMPLES_PER_PROBE, Math.max(1, Math.floor(value)));
}

/** Deterministic, dependency-free FNV-1a hash for run comparability. */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * JSON key scoring is exact-name and order-insensitive (`every` required key
 * appears in the parsed object), so fingerprint the canonical key set rather
 * than only the count. Key names are operator-authored scoring-contract
 * metadata, not user prompt/history/answer content.
 */
function canonicalJsonScoringKeys(keys: string[] | undefined): string[] {
  return [...new Set(keys ?? [])].sort();
}

/** Hash non-content prompt metadata for run comparability without persisting prompt text. */
function hashPromptSet(prompts: EvalPromptSpec[]): string {
  return hashString(
    JSON.stringify(
      prompts.map((spec) => ({
        id: spec.id,
        category: spec.category,
        intent: spec.intent,
        historyRoles: (spec.history ?? []).map((turn) => turn.role),
        historyTurnCount: spec.history?.length ?? 0,
        expectedAnswerCount: spec.expectedAnswers?.length ?? 0,
        forbiddenAnswerCount: spec.forbiddenAnswers?.length ?? 0,
        hasExactReply: typeof spec.exactReply === 'string',
        maxSentences: spec.maxSentences ?? null,
        requireLineCount: spec.requireLineCount ?? null,
        forbidBullets: spec.forbidBullets ?? null,
        requireCodeBlock: spec.requireCodeBlock ?? null,
        requireOnlyCodeBlock: spec.requireOnlyCodeBlock ?? null,
        requireBulletLines: spec.requireBulletLines ?? null,
        requireJsonKeys: canonicalJsonScoringKeys(spec.requireJsonKeys),
        expectDecline: spec.expectDecline ?? null,
        minWords: spec.minWords ?? null,
        expectedShape: spec.expectedShape ?? null,
        depthBand: spec.depthBand ?? null,
        hintPlacement: spec.hintPlacement ?? 'user-turn',
        judge: spec.judge ?? [],
      })),
    ),
  );
}

/** Numeric options actually requested, for the result record. */
function numericOptions(options: GenerateOptions): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof options.temperature === 'number') out.temperature = options.temperature;
  if (typeof options.maxTokens === 'number') out.maxTokens = options.maxTokens;
  if (typeof options.topP === 'number') out.topP = options.topP;
  if (typeof options.topK === 'number') out.topK = options.topK;
  if (typeof options.repetitionPenalty === 'number') out.repetitionPenalty = options.repetitionPenalty;
  if (typeof options.noRepeatNgramSize === 'number') out.noRepeatNgramSize = options.noRepeatNgramSize;
  return out;
}

/** The raw measurements collected from one token stream. */
type StreamOutcome = {
  output: string;
  /** Worker-reported completion tokens, else null (fall back to event count). */
  reportedCompletionTokens: number | null;
  /** Adapter-reported tokenizer-backed PROMPT tokens, else null (LiteRT omits it). */
  reportedPromptTokens: number | null;
  tokenEventCount: number;
  ttftMs: number | null;
  /** Adapter-reported max inter-token gap (ms), else null (#28 stall signature). */
  maxInterTokenGapMs: number | null;
  endedCleanly: boolean;
  /** Per-generation confidence summary (Transformers + WebLLM; absent on LiteRT). */
  confidence: import('../runtime/confidence').ConfidenceSummary | null;
  /** Error reason from an 'error' event or a timeout, else null. */
  error: string | null;
  startMs: number;
  endMs: number;
};

/**
 * Drive one token stream to completion, timing it against a deadline.
 *
 * Determinism: rather than rely solely on a real `setTimeout` (which a
 * synchronous fake `generate` could outrun before the timer ever fires), we
 * combine THREE signals so the timeout is observable in tests with an injected
 * clock:
 *   1. an `AbortController` we trip on timeout AND link to `config.signal`,
 *      passed into `generate` via `options.signal`;
 *   2. a `setTimeout(timeoutMs)` that trips that controller;
 *   3. an elapsed check against the injected `now()` after EACH event.
 * A never-ending fake stream with a tiny `timeoutMs` and a clock that advances
 * past the deadline trips (3) deterministically without waiting on wall time.
 */
async function runStream(
  generate: EvalGenerationFn,
  model: ModelConfig,
  messages: ChatMessage[],
  options: GenerateOptions,
  timeoutMs: number,
  runSignal: AbortSignal | undefined,
  now: () => number,
): Promise<StreamOutcome> {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = (): void => controller.abort();
  if (runSignal) {
    if (runSignal.aborted) controller.abort();
    else runSignal.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Don't keep the Node event loop alive purely for this timer.
  (timer as unknown as { unref?: () => void }).unref?.();

  const startMs = now();
  let output = '';
  let reportedCompletionTokens: number | null = null;
  let reportedPromptTokens: number | null = null;
  let tokenEventCount = 0;
  let ttftMs: number | null = null;
  let maxInterTokenGapMs: number | null = null;
  let confidence: import('../runtime/confidence').ConfidenceSummary | null = null;
  let endedCleanly = false;
  let error: string | null = null;

  try {
    for await (const event of generate(model, messages, { ...options, signal: controller.signal })) {
      if (event.kind === 'token') {
        if (ttftMs === null) ttftMs = now() - startMs;
        output += event.text;
        tokenEventCount++;
      } else if (event.kind === 'done') {
        if (typeof event.completionTokens === 'number') {
          reportedCompletionTokens = event.completionTokens;
        }
        // The tokenizer-backed input length, when the adapter reports it. The
        // retrieval arm's cost rule is stated in added PROMPT tokens, so this is
        // the number that decides it; the chars/4 estimate is only a fallback.
        if (typeof event.promptTokens === 'number') {
          reportedPromptTokens = event.promptTokens;
        }
        // The adapter measures the gap on its own performance clock (decode-
        // faithful); read it straight off `done` rather than re-deriving here.
        maxInterTokenGapMs = event.maxInterTokenGapMs ?? null;
        confidence = event.confidence ?? null;
        endedCleanly = true;
        break;
      } else {
        // kind === 'error'
        error = event.reason;
        break;
      }

      // Elapsed-time guard: deterministic even when the real timer hasn't
      // fired (a synchronous fake stream advancing an injected clock).
      if (now() - startMs >= timeoutMs) {
        timedOut = true;
        controller.abort();
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    if (runSignal) runSignal.removeEventListener('abort', onAbort);
  }

  if (timedOut && !endedCleanly) {
    // A timeout supersedes any abort/error noise so the label is unambiguous.
    error = `timeout: exceeded ${timeoutMs}ms`;
  }

  return {
    output,
    reportedCompletionTokens,
    reportedPromptTokens,
    tokenEventCount,
    ttftMs,
    maxInterTokenGapMs,
    confidence,
    endedCleanly,
    error,
    startMs,
    endMs: now(),
  };
}

/** Build the scored `EvalResult` for one (model, prompt) from a stream outcome. */
function buildResult(
  spec: EvalPromptSpec,
  model: ModelConfig,
  requestedOptions: GenerateOptions,
  requestedMaxTokens: number,
  outcome: StreamOutcome,
  promptTrace: EvalPromptTrace,
  sampleIndex?: number,
  grounding?: EvalGroundingRecord,
): EvalResult {
  // Prefer the worker-reported raw count; fall back to the visible token-event
  // count only when a runtime omits `done.completionTokens`. That fallback
  // counts POST-output-filter tokens, so on such a runtime it can under-report
  // (e.g. stripped <think> tokens) and turn `hitTokenCap` into a false negative.
  // LiteRT currently reports visible chunk count rather than tokenizer-backed
  // tokens; keep its throughput null so scorecards don't compare chunk/s with
  // Transformers/WebLLM tok/s.
  const runtimeAdapter = runtimeAdapterFor(model);
  const completionTokens = outcome.reportedCompletionTokens ?? outcome.tokenEventCount;
  const totalMs = outcome.endMs - outcome.startMs;
  const smokePass = outcome.tokenEventCount > 0 && outcome.error === null;
  const hitTokenCap = completionTokens >= requestedMaxTokens;
  const tokensPerSec =
    runtimeAdapter !== 'litert' && completionTokens > 0 && totalMs > 0
      ? completionTokens / (totalMs / 1000)
      : null;

  const scores = scoreResult(spec, {
    output: outcome.output,
    endedCleanly: outcome.endedCleanly,
    hitTokenCap,
  });

  return {
    promptId: spec.id,
    ...(sampleIndex !== undefined ? { sampleIndex } : {}),
    category: spec.category,
    modelId: model.id,
    runtimeAdapter: runtimeAdapterFor(model),
    output: outcome.output,
    generationOptions: numericOptions(requestedOptions),
    promptTrace,
    scores,
    perf: {
      ttftMs: outcome.ttftMs,
      tokensPerSec,
      totalMs,
      completionTokens,
      promptTokens: outcome.reportedPromptTokens,
      smokePass,
      maxInterTokenGapMs: outcome.maxInterTokenGapMs,
      ranToCap: hitTokenCap,
      ...(outcome.confidence != null ? { confidence: outcome.confidence } : {}),
    },
    ...(spec.judge && spec.judge.length > 0 ? { judge: spec.judge } : {}),
    ...(grounding !== undefined ? { grounding } : {}),
    error: outcome.error,
  };
}

/**
 * Compose the full message list for one probe, mirroring production dispatch
 * byte-for-byte. System message is the base prompt only; user turns pass
 * through unchanged; recaps are appended from the same
 * `buildBranchRecaps`/`appendBranchRecaps` pair dispatch uses.
 *
 * The Gemma-native contract below is left WITHOUT recaps on purpose: it
 * exists to hold one variable still while something else is measured, and
 * adding a second difference would confound the comparison.
 */
type ComposedProbeMessages = {
  messages: ChatMessage[];
  promptTrace: EvalPromptTrace;
};

function nonContentTraceHash(
  promptId: string,
  roleSequence: ChatMessage['role'][],
  firstUserContract: EvalPromptTrace['firstUserContract'],
  qualityHintPlacement: EvalPromptTrace['qualityHintPlacement'],
  promptContractId: EvalPromptContractId,
): string {
  return hashString([
    promptId,
    roleSequence.join(','),
    firstUserContract,
    qualityHintPlacement,
    promptContractId,
  ].join('\n'));
}

function traceForMessages(
  spec: EvalPromptSpec,
  messages: ChatMessage[],
  firstUserContract: EvalPromptTrace['firstUserContract'],
  qualityHintPlacement: EvalPromptTrace['qualityHintPlacement'],
  promptContractId: EvalPromptContractId,
): EvalPromptTrace {
  const roleSequence = messages.map((m) => m.role);
  return {
    roleSequence,
    systemMessageCount: messages.filter((m) => m.role === 'system').length,
    firstUserContract,
    qualityHintPlacement,
    promptContractId,
    messageTextHash: nonContentTraceHash(
      spec.id,
      roleSequence,
      firstUserContract,
      qualityHintPlacement,
      promptContractId,
    ),
  };
}

function foldContractIntoUserTurn(content: string): string {
  return `${GEMMA_NATIVE_ECO_CONTRACT}\n\nUser task:\n${content}`;
}

function composeGemmaNativeMessages(spec: EvalPromptSpec): ComposedProbeMessages {
  const messages: ChatMessage[] = [];
  let contractApplied = false;

  for (const turn of spec.history ?? []) {
    if (!contractApplied && turn.role === 'user') {
      messages.push({ role: 'user', content: foldContractIntoUserTurn(turn.content) });
      contractApplied = true;
      continue;
    }
    messages.push({ role: turn.role, content: turn.content });
  }

  messages.push({
    role: 'user',
    content: contractApplied ? spec.prompt : foldContractIntoUserTurn(spec.prompt),
  });

  return {
    messages,
    promptTrace: traceForMessages(
      spec,
      messages,
      'gemma-native-eco-contract',
      'first-user-contract',
      'gemma-native-eco-contract-v1',
    ),
  };
}

function composeProbeMessages(
  spec: EvalPromptSpec,
  baseSystemPrompt: string,
  modelId: string,
  messageTopology: EvalMessageTopology,
): ComposedProbeMessages {
  if (messageTopology === 'gemma-native-user-contract') {
    return composeGemmaNativeMessages(spec);
  }

  const branch: ChatMessage[] = [
    ...(spec.history ?? []).map((turn): ChatMessage => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: 'user', content: spec.prompt },
  ];

  // The SAME `assemble()` production dispatch uses, so "the harness measures
  // what users get" is a fact about the call graph rather than a claim in a
  // comment. Recaps derive from the RAW branch (history + this turn), which is
  // what `assemble` expects. `systemPrompt` is passed pre-composed because the
  // caller has already applied the prompt arms and any grounding note.
  const messages = assemble({
    modelId,
    messages: branch,
    branchRecaps: buildBranchRecaps(branch),
    // The eval lane deliberately measures with NO custom instructions — see the
    // fidelity note in this file's header.
    customInstructions: '',
    systemPrompt: baseSystemPrompt,
    allowValidationModel: true,
  }).messages;
  return {
    messages,
    promptTrace: traceForMessages(spec, messages, 'none', 'user-turn', 'none'),
  };
}

/** Build a result for a (prompt, modelId) the catalog can't resolve. */
function buildUnknownModelResult(spec: EvalPromptSpec, modelId: string, sampleIndex?: number): EvalResult {
  return errorResult(spec, modelId, 'unknown', `unknown model: "${modelId}" is not in the catalog`, sampleIndex);
}

/**
 * A zeroed error result carrying a known runtime adapter — used when a model
 * loads but `prepareModel` failed (load/cooldown error), so the result still
 * attributes the failure to the right runtime.
 */
function buildPrepareFailedResult(
  spec: EvalPromptSpec,
  model: ModelConfig,
  message: string,
  sampleIndex?: number,
): EvalResult {
  return errorResult(spec, model.id, runtimeAdapterFor(model), `load failed: ${message}`, sampleIndex);
}

/** Shared shape for a generation that never produced tokens. */
function errorResult(
  spec: EvalPromptSpec,
  modelId: string,
  runtimeAdapter: EvalRuntimeAdapter,
  error: string,
  sampleIndex?: number,
): EvalResult {
  return {
    promptId: spec.id,
    ...(sampleIndex !== undefined ? { sampleIndex } : {}),
    category: spec.category,
    modelId,
    runtimeAdapter,
    output: '',
    generationOptions: {},
    scores: scoreResult(spec, { output: '', endedCleanly: false, hitTokenCap: false }),
    perf: {
      ttftMs: null,
      tokensPerSec: null,
      totalMs: 0,
      completionTokens: 0,
      smokePass: false,
      maxInterTokenGapMs: null,
      ranToCap: false,
    },
    ...(spec.judge && spec.judge.length > 0 ? { judge: spec.judge } : {}),
    error,
  };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/**
 * Run the eval harness for a config and assemble a labeled `EvalRun`.
 *
 * For each model: load it ONCE via `prepareModel` (UNTIMED — a cold multi-GB
 * download must not count against the per-generation timeout), then stream each
 * prompt against the already-loaded model. Only the token stream is timed, with
 * the deadline starting AFTER load resolves. Each generation is measured per the
 * contract (ttft, completion tokens, tokens/sec, clean-stop, token-cap, timeout)
 * and scored by the automated rubric.
 *
 * Failure handling never crashes the run: an unknown model id, or a model whose
 * load throws, is recorded as an error result per prompt and the run moves on to
 * the next model. Respects `config.signal`: once aborted, no further work is
 * scheduled and the run finalizes with the results collected so far. The
 * assembled run is persisted via `save` and returned.
 */
export async function runEval(config: EvalRunConfig, deps?: EvalRunnerDeps): Promise<EvalRun> {
  const d = resolveDeps(deps);
  const cap = config.maxTokensCap ?? DEFAULT_MAX_TOKENS_CAP;
  const timeoutMs = config.perGenerationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const samplingMode = config.samplingMode ?? DEFAULT_SAMPLING_MODE;
  const samplesPerProbe = normalizeSamplesPerProbe(config.samplesPerProbe);
  const messageTopology = config.messageTopology ?? DEFAULT_MESSAGE_TOPOLOGY;
  const prompts = selectPrompts(config.promptIds, config.extraPrompts, config.includeResearchArms);
  const total = config.modelIds.length * prompts.length * samplesPerProbe;
  const runSignal = config.signal;

  // R6 removed the prompt-arm layer (identity / dispatch / everyday / grounding):
  // every one of those arms was a retired research parameterization, and with
  // them gone the harness composes exactly the shipped prompt and the shipped
  // per-intent options, with no switch in between.
  const buildSystemPrompt = d.buildSystemPrompt;
  const buildOptions = d.buildOptions;

  const emit = (p: EvalProgress): void => config.onProgress?.(p);

  const startedAt = new Date(d.now()).toISOString();
  const results: EvalResult[] = [];
  let completed = 0;

  for (const modelId of config.modelIds) {
    if (runSignal?.aborted) break;

    const model = d.getModel(modelId);
    if (!model) {
      // Don't crash the run — record an error result per prompt and move on.
      emit({ phase: 'error', modelId, completed, total, note: 'unknown model' });
      for (const spec of prompts) {
        for (let sampleIndex = 1; sampleIndex <= samplesPerProbe; sampleIndex++) {
          const resultSampleIndex = samplesPerProbe > 1 ? sampleIndex : undefined;
          results.push(buildUnknownModelResult(spec, modelId, resultSampleIndex));
          completed++;
          emit({ phase: 'scoring', modelId, promptId: spec.id, completed, total });
        }
      }
      emit({ phase: 'model-done', modelId, completed, total });
      continue;
    }

    emit({ phase: 'loading', modelId, completed, total });

    // Load the model ONCE per model, UNTIMED and BEFORE the stream timer arms —
    // a cold multi-GB download must not count against the per-generation
    // timeout. lifecycle is a singleton, so the prompt loop streams against the
    // already-loaded model. A load failure is recorded per prompt, not thrown.
    try {
      await d.prepareModel(model, runSignal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ phase: 'error', modelId, completed, total, note: 'load failed' });
      for (const spec of prompts) {
        for (let sampleIndex = 1; sampleIndex <= samplesPerProbe; sampleIndex++) {
          const resultSampleIndex = samplesPerProbe > 1 ? sampleIndex : undefined;
          results.push(buildPrepareFailedResult(spec, model, message, resultSampleIndex));
          completed++;
          emit({ phase: 'scoring', modelId, promptId: spec.id, completed, total });
        }
      }
      emit({ phase: 'model-done', modelId, completed, total });
      continue;
    }

    for (const spec of prompts) {
      if (runSignal?.aborted) break;

      const profileOptions = buildOptions(modelId, spec.intent);
      // Greedy mode collapses to deterministic argmax for a reproducible arm;
      // sampled keeps the production per-model profile.
      const baseOptions =
        samplingMode === 'greedy' ? toGreedyOptions(profileOptions) : profileOptions;
      const requestedMaxTokens = Math.min(baseOptions.maxTokens ?? cap, cap);
      const requestedOptions: GenerateOptions = { ...baseOptions, maxTokens: requestedMaxTokens };

      // Messages composed through the SHARED production helpers (hints on
      // user turns — see the header's fidelity note). Multi-turn probes
      // (captured failures / follow-up controls) replay their prior turns
      // between the system prompt and the final user turn, re-hinted exactly
      // as production re-renders history.
      const composed = composeProbeMessages(
        spec,
        buildSystemPrompt(modelId),
        modelId,
        messageTopology,
      );

      for (let sampleIndex = 1; sampleIndex <= samplesPerProbe; sampleIndex++) {
        if (runSignal?.aborted) break;
        const resultSampleIndex = samplesPerProbe > 1 ? sampleIndex : undefined;

        emit({ phase: 'generating', modelId, promptId: spec.id, completed, total });

        const outcome = await runStream(
          d.generate,
          model,
          composed.messages,
          requestedOptions,
          timeoutMs,
          runSignal,
          d.now,
        );

        emit({ phase: 'scoring', modelId, promptId: spec.id, completed, total });
        results.push(
          buildResult(
            spec,
            model,
            requestedOptions,
            requestedMaxTokens,
            outcome,
            composed.promptTrace,
            resultSampleIndex,
          ),
        );
        completed++;
      }
    }

    emit({ phase: 'model-done', modelId, completed, total });
  }

  const fingerprint: EvalRunConfigFingerprint = {
    messageTopology,
    samplingMode,
    samplesPerProbe,
    maxTokensCap: cap,
    perGenerationTimeoutMs: timeoutMs,
    includeResearchArms: config.includeResearchArms ?? false,
    promptCount: prompts.length,
    promptSetHash: hashPromptSet(prompts),
    compositionEra: COMPOSITION_ERA,
    harnessVersion: HARNESS_VERSION,
  };

  const run: EvalRun = {
    schemaVersion: 1,
    runId: d.generateRunId(),
    label: config.label,
    startedAt,
    finishedAt: new Date(d.now()).toISOString(),
    device: d.getDevice(),
    config: fingerprint,
    results,
  };

  d.save(run);
  emit({ phase: 'run-done', modelId: '', completed, total });
  return run;
}
