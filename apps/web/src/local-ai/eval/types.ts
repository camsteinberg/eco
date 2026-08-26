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
   * `preservesUserRegister`: the reply has to come back in the person's own
   * VOICE, not just with their tokens. Set on the same items as
   * `expectUserTextReuse` — those are exactly the asks that say "leave it in my
   * own words" — but it measures something that dim provably cannot see: a
   * reply that replaced an applicant's voice with cover-letter English scored
   * 1.00 on span overlap (2026-08-09). See `register-shift.ts`.
   */
  expectUserRegister?: true;
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
   * Longest contiguous run of the user's own tokens the reply managed to reuse,
   * scaled against a clause-length target. null unless `expectUserTextReuse`.
   *
   * This is the only dim that can read out a PROMPT-INCLUSIVE n-gram ban: with
   * `noRepeatNgramSize = n` the model can copy at most n-1 consecutive prompt
   * tokens at any position, so the measured span is a direct readout of the
   * constraint. COMPARATIVE by design — read the delta between arms, not the
   * absolute level.
   */
  preservesUserText: number | null;
  /**
   * Whether the person's REGISTER survived, measured as formal-correspondence
   * markers the reply introduced that their pasted text did not have. 1 = their
   * voice; 0 = replaced by a genre exemplar. null unless `expectUserRegister`.
   *
   * The sibling `preservesUserText` cannot see this: it reads a longest common
   * token span, and an 8-token run survives almost any rewrite. Differential
   * against the paste by design — a person who already signs off "Sincerely" is
   * not made formal by the model echoing it.
   */
  preservesUserRegister: number | null;
  /**
   * Fraction of the concrete facts in the user's pasted block — figures,
   * monetary amounts, dates, proper names — that came back UNCORRUPTED. null
   * unless `expectFactPreservation`.
   *
   * Deliberately NOT a span measure. Span overlap rewards parroting and punishes
   * the rephrasing these items are asking for; this dim asks only whether "£25",
   * "£180", "7 not 8" and the names survived, however they were re-worded. A
   * corrupted near-form ("332,062" for "332,026", "Nobel Award" for "Nobel
   * Prize") is a MISS, not a match.
   *
   * ★ ONE-SIDED, BY DESIGN. It scores fact survival and nothing else, so a
   * verbatim parrot of the paste scores 1.0 — see `scoreFactPreservation`.
   * COMPARATIVE by design, like `preservesUserText`: read the delta between
   * arms, not the absolute level.
   */
  preservesFacts: number | null;
  /**
   * Fraction of the facts an EARLIER turn established — the drafted email's
   * dates, the list of bills, the date the party moved to — that came back in
   * the reply to a LATER turn. null unless `historyFactSources` names the spans
   * that carry them.
   *
   * The conversation sibling of `preservesFacts`, and the dim that closes the
   * fact half of the gap `everyday-conversation-probes.ts` states about itself:
   * five of those conversations need faithful reproduction and none of them
   * could have it measured, because the instrument read one turn and the
   * requirement spanned many.
   *
   * ★ ONE-SIDED, like its sibling. It scores fact survival and nothing else: a
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
  /**
   * Did the reply hand back the message/email/letter the ask named, addressed to
   * someone and in the person's own voice? null unless `expectsArtifact`.
   *
   *   1   — a salutation opens a body somebody could send;
   *   0.5 — signed but never addressed: the announcement/flyer register, which is
   *         where the hand-labelled borderline samples sit;
   *   0   — notes, advice, fragments, or a deflection.
   *
   * ★ NOT `deliversFirst`. That dim counts ANY bullet list as a deliverable, so
   * organiser notes score 1 on it — measured, on thirty real generations, at 29
   * ones and one 0.5 while the artifact arrived in ten. This dim scores the SHAPE
   * of what came back; that one scores whether anything came back before the
   * questions. Neither subsumes the other and neither re-scores the other's axis.
   */
  deliversAskedArtifact: number | null;
  // ── overwrite instrument (M2 mechanism 1) ──
  /**
   * Bracket-slot penalty. 1 = clean, 0 = defective slots present. null unless
   * `expectOverwriteWatch`. A slot is defective when the slotted fact was given
   * by the user, when it is inserted into the user's own reproduced text, when
   * the slots are so numerous the artifact is a template, or when the slot
   * invites the user to author content. Name/date/phone blanks for genuinely
   * unknown facts are NOT defects.
   *
   * Calibration source: 35 hand-labelled frozen captures (M2 baseline
   * 2026-08-06), labelled before any scorer existed.
   */
  noUnfilledSlots: number | null;
  /**
   * Invented-time penalty. 1 = clean, 0 = the reply commits to a time/day the
   * ask never gave. null unless `expectOverwriteWatch`. The detector is
   * DIFFERENTIAL against the ask text: a time-word that appears in the ask
   * (e.g. summarise-01's "tonight") is sourced and clean.
   *
   * Calibration source: same 35 frozen captures.
   */
  noInventedTime: number | null;
  /**
   * Artifact-burial penalty. 1 = the asked-for artifact/answer IS the reply,
   * 0 = buried under or replaced by apparatus (Option/Version multiplicity,
   * "Changes Made & Rationale" sections, bold-field outlines, per-marker
   * enumerations). null unless `expectOverwriteWatch`. Orthogonal to fidelity
   * (preservesUserText/preservesFacts) and to correctness.
   *
   * Calibration source: same 35 frozen captures.
   */
  deliversUnburied: number | null;
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
 * The everyday-use A/B cells (local-ai/eval/everyday-arms.ts). Two orthogonal
 * switches — the system prompt's add-context clause, and the prompt-inclusive
 * n-gram ban — plus the mandatory `control` cell where every switch is as
 * shipped, and `posture-direct`, which replaces the whole shipped prompt base
 * with a direct-by-default posture rather than conditioning one clause of it.
 *
 * Declared HERE rather than beside the arm table so the run fingerprint can
 * record which cell produced a run without `types` importing the arm module
 * (that edge would close a cycle: the arm module reads `EvalRun`).
 */
export type EvalEverydayArmId =
  | 'control'
  | 'no-add-context'
  | 'ngram-off'
  | 'no-add-context-ngram-off'
  | 'posture-direct';

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
  /**
   * Which everyday-use A/B cell produced this run, when one was selected.
   * Absent on runs that did not set an arm (including every run persisted before
   * the arms existed). `compareEverydayArms` reads this to find the control, and
   * refuses to diff runs that lack it.
   */
  everydayArm?: EvalEverydayArmId;
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
