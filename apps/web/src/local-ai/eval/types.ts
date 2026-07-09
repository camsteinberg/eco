// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eval-harness core types.
 *
 * The eval harness measures on-device chat output quality so backend fixes
 * are provable rather than vibes. This module is the pure-logic core: a fixed
 * prompt set plus an automated scoring rubric. It must run in plain Vitest
 * (Node) — no browser/model/DOM dependencies. The `ChatIntent` import is
 * type-only on purpose so this module stays free of the catalog/runtime.
 *
 * `EvalResult`, `EvalPerf`, and `EvalRun` are owned by a sibling task and are
 * intentionally NOT defined here.
 */

import type { ChatIntent } from '../../lib/chat-intent';

// ─── Prompt set ──────────────────────────────────────────────────────────

export type EvalCategory =
  | 'factual-known'
  | 'math'
  | 'reasoning'
  | 'code'
  | 'summarization'
  | 'instruction-following'
  | 'uncertainty'
  | 'stop-behavior'
  | 'conversation'
  | 'format-json'
  | 'richness'
  | 'answer-shape'
  | 'captured';

/**
 * The answer SHAPE a probe's ask deserves (Wave 2.6) — orthogonal to task
 * class. `teaching` = a developed practical guide; `focused` = the explain
 * register; `brief` = a short reply (single fact, explicit format instruction,
 * or register-matched follow-up). Derived from the PRODUCTION shape type
 * (lib/answer-shape.ts — type-only import, this module stays runtime-free)
 * minus `uncertain` and `social`: probes are labeled with what the ask
 * deserves, and both of those are classifier outcomes (a guess-guard and a
 * greeting register, respectively), not deserved depths this routing audit
 * grades.
 */
export type AnswerShape = Exclude<
  import('../../lib/answer-shape').AnswerShape,
  'uncertain' | 'social'
>;

/**
 * Word-count band for the depthMatch dim. Both bounds optional: a teaching
 * probe typically sets only `minWords` (under-shoot = stub on a teach-me ask);
 * a brief control typically sets only `maxWords` (over-shoot = lecturing on a
 * simple ask — the bake-off LFM failure class). Bounds are graduated floors/
 * ceilings, not targets (see rubric.scoreDepthMatch).
 */
export type DepthBand = { minWords?: number; maxWords?: number };

/** One prior conversation turn a multi-turn probe replays before its prompt. */
export type EvalHistoryTurn = { role: 'user' | 'assistant'; content: string };

/** A judge dimension a human (or LLM judge) fills in later, 1..5. */
export type JudgeDimension = 'coherence' | 'taskFit';

/**
 * A single fixed eval prompt plus the optional automated-check inputs the
 * rubric reads. The rubric applies only the checks whose fields are present.
 */
export type EvalPromptSpec = {
  id: string;
  category: EvalCategory;
  intent: ChatIntent;
  prompt: string;
  /**
   * Prior conversation turns replayed before `prompt` (multi-turn probes —
   * captured failures). The harness builds [system, ...history, prompt-user].
   */
  history?: EvalHistoryTurn[];
  // ── optional automated-check inputs ──
  /** Exactness: any-of match (whole-token, case-insensitive). */
  expectedAnswers?: string[];
  /** Confabulation / wrong-answer guards (whole-token, case-insensitive). */
  forbiddenAnswers?: string[];
  /** Instruction-following: the whole reply should be exactly this. */
  exactReply?: string;
  /** Instruction-following: at most N sentences. */
  maxSentences?: number;
  /** Instruction-following: exactly N non-empty lines. */
  requireLineCount?: number;
  /** Instruction-following: no markdown/plain-text bullet markers. */
  forbidBullets?: boolean;
  /** Format: must contain a fenced ``` code block. */
  requireCodeBlock?: boolean;
  /** Format: the whole reply must be exactly one fenced ``` code block. */
  requireOnlyCodeBlock?: boolean;
  /** Instruction-following: every non-empty line must be a bullet/list line. */
  requireBulletLines?: boolean;
  /** Format-json: the first JSON object must contain these keys. */
  requireJsonKeys?: string[];
  /** Uncertainty: should hedge/decline rather than confabulate. */
  expectDecline?: boolean;
  /**
   * Richness: a genuinely helpful reply should reach at least this many words
   * (graduated floor, NOT a length target — catches the terse failure mode).
   */
  minWords?: number;
  // ── answer-shape inputs (Wave 2.6) ──
  /** The shape this ask deserves; feeds the static routing audit. */
  expectedShape?: AnswerShape;
  /** depthMatch band: penalizes under- AND over-shoot (see rubric). */
  depthBand?: DepthBand;
  /**
   * Marks a research arm whose `intent` DELIBERATELY diverges from what
   * `inferChatIntent(prompt)` returns (potency/placement A/B arms). Probes
   * WITHOUT this flag must keep `intent` in lockstep with the live router —
   * a test asserts it, so the probe set can't silently drift from production.
   */
  forcedIntent?: true;
  /**
   * Where the harness places the per-intent turn hint for this probe.
   * Default (= 'user-turn') mirrors production since Wave 2.6 Stage 1: the
   * hint rides the end of the user turn and the system front stays hint-free
   * (measured stronger conditioning + KV-stable, see Stage-0 findings).
   * 'system' is the pre-Stage-1 composition, kept as the research
   * counterfactual so the relocation decision stays re-measurable.
   */
  hintPlacement?: 'system' | 'user-turn';
  /** Dimensions a human/LLM judge must fill in later. */
  judge?: JudgeDimension[];
  /** Guidance for the judge. */
  notes?: string;
};

// ─── Scoring ─────────────────────────────────────────────────────────────

/**
 * The scored rubric for a single result.
 *
 * Automated dims are 0..1, or `null` when not applicable to the prompt.
 * Judge dims are 1..5, `null` until a judge fills them.
 */
export type RubricScores = {
  // ── automated ──
  correctStop: number | null;
  /** Always computed. */
  noRepetition: number;
  /** Always computed. */
  noCannedLeakage: number;
  /** Always computed. */
  noThinkLeakage: number;
  /**
   * Always computed. 0 when CJK script (ideographs / kana / hangul) leaks into
   * the output while the prompt-side text has none; 1 otherwise (incl. a
   * legitimately CJK prompt).
   */
  noCjkLeak: number;
  formatAdherence: number | null;
  exactness: number | null;
  instructionFollowing: number | null;
  /** Heuristic; a judge confirms. */
  appropriateUncertainty: number | null;
  /** Richness floor: min(1, words/minWords). null unless `minWords` set. */
  answerDepth: number | null;
  /**
   * Depth-band fit: graduated penalty for under-shoot (words/minWords) AND
   * over-shoot (maxWords/words). null unless `depthBand` set. Word counts are
   * a proxy for shape — a judge (taskFit) confirms structure quality.
   */
  depthMatch: number | null;
  // ── judge ──
  coherence: number | null;
  taskFit: number | null;
};

/** Context the harness passes when scoring a single result. */
export type RubricContext = {
  /** Final user-visible output (post output-filter). */
  output: string;
  /** Whether generation ended cleanly (a 'done' event), vs aborted/timed-out. */
  endedCleanly: boolean;
  /** Whether generation hit the max-token cap. */
  hitTokenCap: boolean;
};

// ─── Run-level types ─────────────────────────────────────────────────────
//
// A harness *runner* (a later task) produces `EvalRun` objects; storage.ts
// persists them and aggregate.ts turns them into scorecards. These types are
// pure data — no browser/model/DOM dependency.

/** Which runtime backend produced a result. */
export type EvalRuntimeAdapter = 'transformers' | 'webllm' | 'litert' | 'unknown';

export const EVAL_MESSAGE_TOPOLOGIES = [
  'production-user-turn-hints',
  'system-front-hints',
  'gemma-native-user-contract',
] as const;

/** Run-wide diagnostics control for where Eco places per-turn quality hints. */
export type EvalMessageTopology = (typeof EVAL_MESSAGE_TOPOLOGIES)[number];

/** Non-content identifier for prompt contracts that affect message composition. */
export type EvalPromptContractId = 'none' | 'gemma-native-eco-contract-v1';

/** Privacy-safe description of the prompt topology used for one result. */
export type EvalPromptTrace = {
  /** Role order sent to the runtime. No prompt text is stored here. */
  roleSequence: ('system' | 'user' | 'assistant')[];
  /** Count of system-role messages sent to the runtime. */
  systemMessageCount: number;
  /** Whether the compact Eco contract was folded into the first user turn. */
  firstUserContract: 'none' | 'gemma-native-eco-contract';
  /** Where Eco placed the model-conditioning text for this result. */
  qualityHintPlacement: 'user-turn' | 'system-front' | 'first-user-contract';
  /** Non-content contract version identifier; never a hash of contract text. */
  promptContractId: EvalPromptContractId;
  /**
   * Back-compat field name for persisted eval results. New runs store a
   * non-content trace hash derived from role sequence + prompt id + topology
   * placement + contract id, never from raw prompt/message text.
   */
  messageTextHash: string;
};

/** Performance measurements for a single generation. */
export type EvalPerf = {
  /** Time-to-first-token, ms. `null` if no token was ever produced. */
  ttftMs: number | null;
  /** Steady-state decode rate. `null` if not measurable. */
  tokensPerSec: number | null;
  /** Wall-clock generation time, ms. */
  totalMs: number;
  /** Raw completion tokens produced (worker-side count). */
  completionTokens: number;
  /** Produced >=1 token without error. */
  smokePass: boolean;
};

/** One scored prompt × model result. */
export type EvalResult = {
  promptId: string;
  /** 1-based replicate index when a run executes the same prompt/model more than once. */
  sampleIndex?: number;
  category: EvalCategory;
  modelId: string;
  runtimeAdapter: EvalRuntimeAdapter;
  /** Runtime execution backend when the adapter can report it; used for seed WASM-proof refreshes. */
  runtimeBackend?: 'webgpu' | 'wasm';
  /** Visible (post output-filter) output. */
  output: string;
  /** Sampling actually requested (temperature, maxTokens, topP, ...). */
  generationOptions: Record<string, number>;
  /** Privacy-safe prompt/topology trace for comparability audits. */
  promptTrace?: EvalPromptTrace;
  scores: RubricScores;
  perf: EvalPerf;
  /**
   * The judge dims this probe requested (from its spec), so a result is
   * self-describing about what a human/LLM judge should score. Drives the
   * "judge skeleton" affordance. Absent when the probe requested no judging
   * (and on runs persisted before this field existed).
   */
  judge?: JudgeDimension[];
  error: string | null;
};

/** Device fingerprint a run was captured on (for comparability). */
export type EvalRunDevice = {
  profileKey: string;
  browserClass: string;
  webgpuSupport: string;
  deviceClass: string;
};

/**
 * Decode mode for a run. `greedy` = deterministic argmax (no sampling RNG) —
 * the reproducible arm: re-running yields identical output (modulo negligible
 * WebGPU float-ordering), so before/after deltas on correctStop/exactness/
 * format are trustworthy, not eyeballed. `sampled` = the production per-model
 * sampling profile (temperature/top_p/top_k) — the realistic-feel arm.
 */
export type SamplingMode = 'greedy' | 'sampled';

/**
 * A run's configuration fingerprint. Stamped on every run so cross-run diffs
 * are HONEST: a greedy run and a sampled run measure different things and are
 * NOT directly comparable, and a composition change (e.g. hint placement) makes
 * older runs incomparable. `diffScorecards` / `compareModels` callers read this
 * to confirm two runs share an `era` before trusting a delta.
 */
export type EvalRunConfigFingerprint = {
  /** Run-wide message composition lane used for this diagnostics pass. */
  messageTopology: EvalMessageTopology;
  samplingMode: SamplingMode;
  /** Number of replicate generations per prompt/model. */
  samplesPerProbe: number;
  /** Hard token cap applied per generation. */
  maxTokensCap: number;
  /** Per-generation stream timeout (ms). */
  perGenerationTimeoutMs: number;
  /** Whether the Stage-0 answer-shape research arms were included. */
  includeResearchArms: boolean;
  /** Number of prompt specs run per model. */
  promptCount: number;
  /** Deterministic non-content hash of selected prompt IDs, categories, topology metadata, and scoring flags. */
  promptSetHash: string;
  /** Human-readable message-composition era for comparability checks. */
  compositionEra: string;
  /**
   * Harness composition version — bumped when message composition / hint
   * placement changes. Two runs are only directly comparable at the same
   * version (current era: Wave 2.6 Stage 1 — per-intent hints on the user turn).
   */
  harnessVersion: number;
};

/** A full harness run: one device, one label, many prompt × model results. */
export type EvalRun = {
  schemaVersion: 1;
  runId: string;
  /** e.g. 'baseline' | 'after-phase-1' | custom. */
  label: string;
  /** ISO timestamp. */
  startedAt: string;
  /** ISO timestamp, or `null` if the run is still in progress. */
  finishedAt: string | null;
  device: EvalRunDevice;
  /**
   * The run's config fingerprint (sampling mode, caps, prompt count, harness
   * version). Optional: runs persisted before this field lack it; the storage
   * guard tolerates its absence.
   */
  config?: EvalRunConfigFingerprint;
  results: EvalResult[];
};

// ─── Aggregation output ──────────────────────────────────────────────────

/** Mean per rubric dim. A dim is absent or `null` when never applicable. */
export type DimensionAverages = Partial<Record<keyof RubricScores, number | null>>;

/** A single model's rolled-up scores across one run's prompts. */
export type ModelScorecard = {
  modelId: string;
  runtimeAdapter: EvalRuntimeAdapter;
  /** Result rows for this model (prompt count × samplesPerProbe). */
  promptCount: number;
  /** Mean per dim over prompts where it's non-null (null if never applicable). */
  dimensionAverages: DimensionAverages;
  /** Population stddev per dim; null when fewer than two finite values exist. */
  dimensionStdDev: DimensionAverages;
  perf: { medianTtftMs: number | null; medianTokensPerSec: number | null; smokePassRate: number };
  /** Mean of non-null AUTOMATED dims (0..1). */
  compositeScore: number;
  /** Population stddev of per-result composites; null when fewer than two finite values exist. */
  compositeStdDev: number | null;
  /** 1..5 means, null if unjudged. */
  judgeAverages: { coherence: number | null; taskFit: number | null };
};

/** All model scorecards from one run, with its device context. */
export type Scorecard = {
  runId: string;
  label: string;
  device: EvalRunDevice;
  config?: EvalRunConfigFingerprint;
  models: ModelScorecard[];
};

/** Per-dim after-before delta (null if either side null). */
export type DimensionDelta = Partial<Record<keyof RubricScores, number | null>>;

/** One model's before→after delta. */
export type ModelScorecardDelta = {
  modelId: string;
  compositeDelta: number;
  dimensionDeltas: DimensionDelta;
  perfDelta: { medianTtftMs: number | null; medianTokensPerSec: number | null; smokePassRate: number };
};

/** Diff between two scorecards (matched by modelId; only models in BOTH). */
export type ScorecardDiff = {
  beforeLabel: string;
  afterLabel: string;
  /** Non-empty when the two runs differ on device/config fingerprints. */
  configWarnings: string[];
  models: ModelScorecardDelta[];
};
