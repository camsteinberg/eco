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
 * ── System-prompt fidelity ──────────────────────────────────────────────────
 * The harness measures with the REAL production on-device system prompt so its
 * numbers reflect what users actually get. The default `buildSystemPrompt`
 * delegates to `getOnDeviceSystemPrompt(modelId)` (lib/system-prompt.ts) — the
 * exact base prompt `useChat.buildSystemPrompt` feeds the model: the lean Eco
 * identity prompt plus the model's catalog `systemDirective` suffix. We
 * deliberately import the small, React-free `lib/system-prompt` assembler
 * rather than the `useChat` hook (which would pull React transitively into a
 * pure-logic module).
 *
 * Since Wave 2.6 Stage 1, production places per-intent hints at the END of
 * each user turn (`buildHintedUserTurn` / `applyTurnHints` — measured at
 * Stage 0: far stronger conditioning than the system front, and KV-stable).
 * The runner composes through those SAME shared helpers, so the messages are
 * byte-identical to dispatch: system = base prompt only; history user turns
 * re-hinted exactly as production re-renders them; the final user turn
 * carries the spec-intent hint. Hint-comparability eras for stored runs:
 * pre-`wave26-stage0` (no hint anywhere) → `wave26-stage0*` (hint in the
 * system front) → `wave26-stage1*`+ (hint on the user turn).
 *
 * One production layer is intentionally NOT reproduced: user custom
 * instructions — user-specific, empty for the default user.
 *
 * Probes may set `hintPlacement: 'system'` (research counterfactual): the
 * pre-Stage-1 composition, kept so the relocation decision stays
 * re-measurable.
 */

import type { ChatIntent } from '../../lib/chat-intent';
import {
  applyTurnHints,
  buildHintedUserTurn,
  composeQualitySystemPrompt,
  getGenerationProfile,
} from '../../lib/chat-intent';
import { getOnDeviceSystemPrompt } from '../../lib/system-prompt';
import { getModel } from '../catalog/catalog';
import { getDeviceProfile } from '../device/profile';
import { classifyDeviceClass } from '../evidence/seed';
import { profileKey } from '../evidence/ledger';
import { bootstrapLocalAi } from '../bootstrap';
import { loadModel, generate as generateThroughLifecycle } from '../runtime/lifecycle';
import type { ModelConfig } from '../types';
import type { ChatMessage, GenerateOptions, TokenEvent } from '../runtime/types';
import { getEvalCandidateModel } from './eval-candidates';
import { applyEcoTangentArm, type EcoTangentArm } from './eco-tangent';
import { scoreResult } from './rubric';
import { saveEvalRun } from './storage';
import { EVAL_PROMPTS } from './prompts';
import { FELT_PROBES } from './felt-probes';
import { SHAPE_PROBES, SHAPE_RESEARCH_ARMS } from './shape-probes';
import type {
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
  /** Subset of prompt ids (fixed ∪ felt ∪ extra); default all. */
  promptIds?: string[];
  /**
   * Session-scoped probes appended to the fixed+felt pool (e.g. captured
   * failures selected in the diagnostics panel), deduped by id — a collision
   * with a fixed/felt id keeps the checked-in spec.
   */
  extraPrompts?: EvalPromptSpec[];
  /**
   * Include the Stage-0 answer-shape research arms (forced intents / explicit
   * phrasing / hint placement — shape-probes.SHAPE_RESEARCH_ARMS). Off by
   * default: arms measure NON-production composition, so they'd skew routine
   * scorecard composites if they rode every run.
   */
  includeResearchArms?: boolean;
  /**
   * Diagnostics-only run-wide message composition lane. Defaults to production's
   * user-turn hints; the system-front lane is a controlled counterfactual.
   */
  messageTopology?: EvalMessageTopology;
  /**
   * Eco-tangent A/B arm (prompt-persona-quality-pass root cause #2). When set,
   * swaps the identity sentence of the base system prompt for the arm's variant
   * — a LOCAL, UNSHIPPED parameterization (see local-ai/eval/eco-tangent.ts).
   * 'A' is the live sentence (a no-op). Off by default: production runs never
   * set it, so the harness measures the shipped prompt. The A/B never lands in
   * prod code — only the winning sentence ships, as a one-line prompt change.
   */
  identityArm?: EcoTangentArm;
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
 * Pick the prompt specs to run from the fixed ∪ shape ∪ felt (∪ research arms
 * ∪ extra) pool, preserving pool order. The answer-shape probes are part of
 * the permanent bar (like felt probes); the research arms join only when
 * explicitly requested. Extras are deduped by id — the checked-in spec always
 * wins a collision.
 */
function selectPrompts(
  promptIds?: string[],
  extraPrompts?: EvalPromptSpec[],
  includeResearchArms?: boolean,
): EvalPromptSpec[] {
  const pool: EvalPromptSpec[] = [
    ...EVAL_PROMPTS,
    ...SHAPE_PROBES,
    ...FELT_PROBES,
    ...(includeResearchArms ? SHAPE_RESEARCH_ARMS : []),
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
  tokenEventCount: number;
  ttftMs: number | null;
  endedCleanly: boolean;
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
  let tokenEventCount = 0;
  let ttftMs: number | null = null;
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
    tokenEventCount,
    ttftMs,
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
      smokePass,
    },
    ...(spec.judge && spec.judge.length > 0 ? { judge: spec.judge } : {}),
    error: outcome.error,
  };
}

/**
 * Compose the full message list for one probe, mirroring production dispatch
 * byte-for-byte (Wave 2.6 Stage 1 placement).
 *
 * Default (= production, also selectable as 'user-turn'): the system message
 * is the BASE prompt only; every history user turn re-renders through the
 * SAME `applyTurnHints` production uses (the KV re-render contract); the
 * final user turn carries the spec-intent hint at its end via
 * `buildHintedUserTurn` (raw prompt when the hint is empty).
 *
 * 'system' placement (research counterfactual — the pre-Stage-1 production
 * composition): hint joined into the system front, raw history, raw user
 * turn. Kept so the relocation decision stays re-measurable; never the
 * default again.
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

  const history = (spec.history ?? []).map((turn): ChatMessage => ({
    role: turn.role,
    content: turn.content,
  }));

  if (messageTopology === 'system-front-hints' || spec.hintPlacement === 'system') {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: composeQualitySystemPrompt(baseSystemPrompt, spec.intent, true, modelId),
      },
      ...history,
      { role: 'user', content: spec.prompt },
    ];
    return {
      messages,
      promptTrace: traceForMessages(spec, messages, 'none', 'system-front', 'none'),
    };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: baseSystemPrompt },
    ...(applyTurnHints(history, true, modelId) as ChatMessage[]),
    { role: 'user', content: buildHintedUserTurn(spec.prompt, spec.intent, true, modelId) },
  ];
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
    perf: { ttftMs: null, tokensPerSec: null, totalMs: 0, completionTokens: 0, smokePass: false },
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

  // Eco-tangent A/B: swap the identity sentence of the base system prompt for
  // the selected arm (a local, unshipped parameterization). Arm A is a no-op;
  // an unset arm leaves the shipped prompt untouched.
  const arm = config.identityArm;
  const buildSystemPrompt = arm
    ? (modelId: string): string => applyEcoTangentArm(d.buildSystemPrompt(modelId), arm)
    : d.buildSystemPrompt;

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

      const profileOptions = d.buildOptions(modelId, spec.intent);
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
