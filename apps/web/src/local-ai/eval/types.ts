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
import type { ConfidenceSummary } from '../runtime/confidence';

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
  /**
   * The everyday-use probe set — one probe per item of the blind-authored
   * `__tests__/fixtures/everyday-use-corpus.ts`, derived at module load
   * (local-ai/eval/everyday-probes.ts). Its own category so a run can be
   * filtered to "what ordinary people actually bring" as a unit.
   */
  | 'everyday-use'
  /**
   * The everyday-use CONVERSATION probes — one probe per item of
   * `__tests__/fixtures/everyday-conversation-corpus.ts`, derived at module load
   * (local-ai/eval/everyday-conversation-probes.ts). Separate from
   * `everyday-use` rather than folded into it: every probe here replays a
   * history, so its results are not comparable with a single-turn one and must
   * not be averaged alongside them.
   */
  | 'everyday-conversation'
  /**
   * The capability probe — the 28-task blind everyday-task set derived at module
   * load (local-ai/eval/capability-probe.ts), the runnable form of eco-notes
   * `decisions/capability-probe-2026-08-12.md`. Its own category so a run can be
   * filtered to exactly the probe and scored by hand against the vetted key.
   */
  | 'capability-probe'
  /**
   * The conversation-integrity probe — the blind fixture for the #27 "nora leak"
   * (local-ai/eval/conversation-integrity-probe.ts). A private detail planted in
   * an earlier turn must NOT resurface in a message drafted to a third party. Its
   * own category so a run can be scoped to it and the headline leak-rate
   * (leak-rate.ts) computed from exactly this set, never diluted into a composite.
   */
  | 'conversation-integrity'
  /**
   * The known-answer probe set (local-ai/eval/known-answer-probes.ts): everyday
   * asks whose answer is a checkable fact or number — time arithmetic, money,
   * conversions, lookups. Its own category so a run can be scoped to exactly
   * "did the model get the answer RIGHT" and the headline accuracy
   * (known-answer-accuracy.ts) computed from this set alone, never diluted into
   * a shape composite.
   */
  | 'known-answer'
  /**
   * The dispatch probe set (local-ai/eval/dispatch-probes.ts): the blind
   * realistic-input corpus plus pre-committed recall phrasings, run to measure
   * whether a model can select the right tool from a schema — the question the
   * hand-written matchers answer today. Its own category so a run scopes to
   * exactly that and its results are never averaged into an answer-quality
   * composite: the graded unit here is the tool call, not the reply.
   */
  | 'dispatch'
  /**
   * The passage-retrieval probe set (local-ai/eval/retrieval-probes.ts): the
   * frozen 20-row protocol corpus, the blind corpus's no-tool rows, and three
   * hostile-fixture rows, run to measure whether injecting question-matched body
   * SENTENCES beats injecting the article's lead summary. Its own category so a
   * run scopes to exactly that comparison; the graded unit is the answer, but the
   * decision-grade score is blind human scoring, not this run's composite.
   */
  | 'retrieval'
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

/**
 * The piece of correspondence an ask names, for the `deliversAskedArtifact` dim.
 *
 * `kind` is the medium the item's own words name — a text, an email, a letter.
 * It gates the dim and is reported; nothing branches on it in the scorer today.
 *
 * `audience` is who the reply has to be written TO, in the item's own terms. It
 * is deliberately NOT pattern-matched: matching a hand-written audience string
 * against the reply would score the wording of the annotation rather than the
 * reply. It rides the probe's `notes` to the judge, and it is what makes the
 * annotation reviewable — "addressed to whom" is the half of this property a
 * mechanical check reads only indirectly.
 */
export type ExpectedArtifact = {
  kind: 'message' | 'email' | 'letter';
  audience: string;
};

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
   * `deliversFirst`: this ask has a DELIVERABLE, so the reply must not withhold
   * it behind questions to the user. Gated (rather than always-on) on purpose:
   * turning the dim on everywhere would silently change every existing probe
   * set's `compositeScore` and break comparability with stored runs.
   */
  expectDeliverable?: true;
  /**
   * `preservesUserText`: the reply has to give the user's own words or figures
   * back, so reusing spans of the prompt is REQUIRED rather than penalised.
   * Set only where the prompt actually carries the text to be reused — a
   * follow-up whose antecedent lives in an earlier turn has nothing in
   * `prompt` to preserve and must leave this unset.
   */
  expectUserTextReuse?: true;
  /**
   * `preservesFacts`: the reply has to carry the user's own FIGURES, DATES and
   * NAMES back out intact while the wording is deliberately changed (a summary
   * compresses, a tone rewrite softens, a hospital letter is translated out of
   * jargon). The sibling of `expectUserTextReuse`, and deliberately EXCLUSIVE of
   * it: span overlap reads a wording job correctly and a facts job backwards.
   * Set only where the prompt actually carries the facts.
   */
  expectFactPreservation?: true;
  /**
   * `preservesHistoryFacts`: verbatim spans of EARLIER turns (`history`) whose
   * figures, dates and names have to come back in the reply to THIS turn — the
   * drafted email, the list of bills, the date the party moved to.
   *
   * Carries the spans rather than a boolean because the window cannot be
   * derived: a conversation's history also holds an abandoned topic and the
   * figures the current ask supersedes, and extracting facts from all of it
   * would score the CORRECT answer as a failure. Presence is the gate, as it is
   * for `expectedAnswers` and `depthBand`. See `rubric.analyzeHistoryFactPreservation`
   * for why the scope is authored and the facts are not.
   */
  historyFactSources?: readonly string[];
  /**
   * `honorsRuledOut`: terms an EARLIER turn ruled out — a value the conversation
   * superseded ("£745" after "use the 790 rent"), or a thing the person refused
   * ("i dont have a thermometer"). Each must be ABSENT from the reply.
   *
   * The inverse test to `historyFactSources`, and kept separate from it on
   * purpose: averaged together, a reply could earn back a broken instruction by
   * quoting an extra date. Presence is the gate.
   */
  historyRuledOut?: readonly string[];
  /**
   * `deliversAskedArtifact`: this ask is for a piece of correspondence the person
   * will SEND, so the reply has to BE that message rather than notes about it.
   *
   * A RICHER ANNOTATION THAN A BOOLEAN, deliberately. `expectDeliverable` above
   * is a flag because `deliversFirst` needs nothing else: any deliverable counts.
   * This dim has to know what shape the deliverable takes and who it is written
   * to, and both are readings of the corpus item that a person made and can be
   * argued with — so they are written down rather than inferred at runtime.
   * Hand-authored per item, with the justification beside it (see
   * `everyday-probes.ts`); never derived from the prompt text.
   */
  expectsArtifact?: ExpectedArtifact;
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
   *
   * NAME RETAINED DELIBERATELY (R4a): per-intent turn hints were deleted in R1,
   * so nothing places a hint any more. The name stays because this field feeds
   * `hashPromptSet` (harness.ts) — the non-content comparability hash stamped on
   * every stored run — so renaming it re-keys the entire run history and two
   * runs either side of the rename stop being comparable. The field now only
   * selects a research arm's composition; it is eval-lane only and never
   * reaches dispatch.
   */
  hintPlacement?: 'system' | 'user-turn';
  /**
   * `noUnfilledSlots` / `noInventedTime` / `deliversUnburied`: the overwrite
   * instrument's three structural dims. Gated (rather than always-on) on
   * purpose: turning them on everywhere would change every existing probe set's
   * `compositeScore` and break comparability with stored runs. Set only on the
   * everyday-use items where the M2 baseline measured the failure class.
   */
  expectOverwriteWatch?: true;
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
  noThinkLeakage: number;
  /**
   * Always computed. 0 when CJK script (ideographs / kana / hangul) leaks into
   * the output while the prompt-side text has none; 1 otherwise (incl. a
   * legitimately CJK prompt).
   */
  noCjkLeak: number;
  exactness: number | null;
  /** Richness floor: min(1, words/minWords). null unless `minWords` set. */
  answerDepth: number | null;
  /**
   * Whether the deliverable survived the reply's questions. null unless
   * `expectDeliverable` is set.
   *
   *   1   — no request to the user, OR a deliverable precedes the first one;
   *   0.5 — the reply asks first but still delivers in the same turn;
   *   0   — the reply asks and never delivers (the corpus bounce, phrased
   *         forty different ways as "before writing anything").
   *
   * Deliberately NOT first-sentence position: a two-word preamble ("Sure —")
   * ahead of a real deliverable is not a defect, and scoring it as one would
   * measure politeness rather than delivery.
   */
  deliversFirst: number | null;
  /**
   * Fraction of the facts an EARLIER turn established — the drafted email's
   * dates, the list of bills, the date the party moved to — that came back in
   * the reply to a LATER turn. null unless `historyFactSources` names the spans
   * that carry them.
   *
   * The dim that closes the fact half of the gap
   * `everyday-conversation-probes.ts` states about itself:
   * five of those conversations need faithful reproduction and none of them
   * could have it measured, because the instrument read one turn and the
   * requirement spanned many.
   *
   * ★ ONE-SIDED, BY DESIGN. It scores fact survival and nothing else: a
   * reply that names the facts without doing the job scores 1.0 here, and
   * `answerDepth` / `deliversFirst` / the judge are what catch that.
   */
  preservesHistoryFacts: number | null;
  /**
   * Fraction of the things an earlier turn ruled out that the reply managed NOT
   * to bring back. null unless `historyRuledOut` names them.
   *
   * 1.0 = none resurfaced. The failures it exists for are the ones the bounce
   * conditions name in those words: the old rent figure back in the printed
   * list, Saturday back in the invitation after the party moved off it, the
   * thermometer he already said he does not own.
   */
  honorsRuledOut: number | null;
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

/** Which runtime backend produced a result. `'webllm'` is a historical
 *  persisted value — user devices hold eval records from before the WebLLM
 *  runtime was retired (2026-07-10); no live catalog model produces it now. */
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

/**
 * The everyday-use A/B cells (local-ai/eval/everyday-arms.ts). The remaining
 * switch is the prompt-inclusive n-gram ban, plus the mandatory `control` cell
 * where every switch is as shipped.
 *
 * `no-add-context`, `no-add-context-ngram-off`, and `posture-direct` were
 * retired 2026-08-26 when the posture-direct treatment shipped as the new
 * production prompt. Persisted runs may still carry the old IDs.
 *
 * Declared HERE rather than beside the arm table so the run fingerprint can
 * record which cell produced a run without `types` importing the arm module
 * (that edge would close a cycle: the arm module reads `EvalRun`).
 */
export type EvalEverydayArmId =
  | 'control'
  | 'ngram-off';

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
  /**
   * Tokenizer-backed INPUT length for this generation, as reported by the
   * adapter's `done` event. The transformers adapter reports it (the worker reads
   * the rendered `input_ids` tensor width); LiteRT does not, so it is `null` there
   * and on every run persisted before this field existed.
   *
   * The retrieval measurement's cost rule is stated in ADDED PROMPT TOKENS, and a
   * chars/4 estimate is not good enough to decide a threshold on — so the real
   * number is recorded whenever the runtime will give it, alongside the estimate on
   * `EvalResult.grounding.injectedTokensEstimate`.
   */
  promptTokens?: number | null;
  /** Produced >=1 token without error. */
  smokePass: boolean;
  /**
   * Largest gap between two consecutive streamed tokens, in ms (the #28 stall
   * signature), as reported by the transformers adapter's `done` event. `null`
   * when the runtime didn't report it or fewer than two tokens streamed. Optional
   * because it is absent on `EvalRun`s persisted before this field existed.
   */
  maxInterTokenGapMs?: number | null;
  /**
   * Whether generation exhausted its token budget (`completionTokens >=`
   * requested cap) rather than stopping naturally. A stall runs to the cap.
   * Optional for the same persisted-run back-compat reason as above.
   */
  ranToCap?: boolean;
  /**
   * Per-generation confidence summary. Transformers provides full-vocabulary
   * entropy; WebLLM provides chosen-token logprobs only (entropy fields are
   * `null`). Optional: absent on runs persisted before this field existed
   * and on runtimes that do not expose logits (LiteRT).
   */
  confidence?: ConfidenceSummary;
};

/** How a grounding tool step ended, in the retrieval arm's vocabulary. */
export type EvalGroundingOutcome = 'found' | 'hedge' | 'decline' | 'degraded' | 'none';

/**
 * What the retrieval arm's tool step did on one probe (local-ai/eval/retrieval-arm.ts).
 *
 * Present only on results from a run that set `groundingArm`; absent everywhere
 * else, including every run persisted before the arm existed. Every field is a
 * MEASUREMENT, and the two output-derived flags are signals for a blind human
 * scorer rather than verdicts — see the arm module for what each one over- and
 * under-counts.
 */
export type EvalGroundingRecord = {
  /** Did the shipped matcher claim this turn at all? `false` = no lookup happened. */
  fired: boolean;
  /** Resolved article title, on a FOUND result. */
  title?: string;
  /** Resolved article URL, on a FOUND result. */
  url?: string;
  /** The tool's own extraction-confidence tier for the hit. */
  confidence?: string;
  /** Which span reached the model. Absent when nothing fired. */
  mode?: 'lead' | 'passages' | 'passages-fallback-lead';
  /** Sentences injected, in `'passages'` mode. */
  passageCount?: number;
  /** Character length of the injected note; 0 when nothing fired. */
  injectedChars: number;
  /** `injectedChars / 4` — the harness-wide estimate, kept beside `perf.promptTokens`. */
  injectedTokensEstimate: number;
  /** Wall-clock ms of the whole tool step (match + every fetch). */
  toolMs: number;
  /** Wall-clock ms of the article-BODY request alone; `null` when none was made. */
  bodyFetchMs?: number | null;
  /** Section heading per injected passage, in injection order. */
  sectionTitles?: string[];
  /** How the tool step ended. */
  outcome: EvalGroundingOutcome;
  /** Hostile rows only: did the fixture's injected sentence reach the injected note? */
  injectionSurfaced?: boolean;
  /** Hostile rows only: did the fixture's sentinel word reach the model's REPLY? */
  sentinelInOutput?: boolean;
  /** Fraction of the reply inside verbatim >=40-char spans of the injected note. */
  parrotRatio?: number;
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
  /**
   * What the retrieval arm's grounding tool step did on this probe. Present only
   * when the run set `groundingArm`; absent on every other run, so a stored result
   * says for itself whether a tool ran rather than relying on the typed label.
   */
  grounding?: EvalGroundingRecord;
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
 * Which history-eviction rule the runtime applies for a run. `'quantized'` is
 * the shipped rule (PR #348): the window start moves in half-budget steps and
 * then holds still, which cuts re-prefill stalls but leaves the model with
 * between half and a full budget of history right after a move. `'minimal'` is
 * the rule it replaced: the start is the oldest message that still fits, so the
 * model always sees a full budget and pays a re-prefill on nearly every turn.
 */
export type EvalEvictionRule = 'quantized' | 'minimal';

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
  /**
   * Which everyday-use A/B cell produced this run, when one was selected.
   * Absent on runs that did not set an arm (including every run persisted before
   * the arms existed). `compareEverydayArms` reads this to find the control, and
   * refuses to diff runs that lack it.
   */
  everydayArm?: EvalEverydayArmId;
  /**
   * `'schemas'` when this run carried the tool-schema dispatch arm in its system
   * prompt. Absent on every other run, including the dispatch measurement's own
   * control arm — so a stored run always says which prompt produced it rather
   * than relying on the human-typed label.
   */
  dispatchArm?: 'schemas';
  /**
   * Which history-eviction rule the runtime applied for this run: `'quantized'`
   * (the shipped rule — the window start moves in half-budget steps and then
   * holds still) or `'minimal'` (the pre-#348 rule — the start is the oldest
   * message that still fits, so it advances on nearly every turn past the wall).
   *
   * Absent on every run the harness produced before this field existed. Absent
   * does NOT mean `'quantized'`: those runs bypassed window selection entirely
   * and sent full history, so back-filling them would invent a fact. The
   * pairwise scorer compares two arms that BOTH set it.
   */
  evictionRule?: EvalEvictionRule;
  /**
   * Which retrieval arm ran the grounding tool for this run: `'lead'` (the
   * control — today's shipped lead-summary injection) or `'passages'` (the
   * treatment). Absent when the run ran NO tool at all, which is every other run
   * the harness has ever produced — so a stored run always says whether a tool
   * touched its prompts, and a lead run can never be mistaken for a tool-free one.
   */
  groundingArm?: 'lead' | 'passages';
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
