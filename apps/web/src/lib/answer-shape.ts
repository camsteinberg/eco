// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Answer-shape classification (Wave 2.6 Stage 1).
 *
 * The SHAPE an ask deserves — `teaching | focused | brief | uncertain` — as a
 * first-class axis, orthogonal to task class (code/writing/file/research stay
 * with `inferChatIntent`'s cascade). Deterministic and host-side by design:
 * sub-2B models cannot scope depth conditionals themselves (Wave-1 live-probed
 * law), so the host decides the shape and selects an additive treatment; the
 * model is never asked to branch.
 *
 * Measured grounding (Stage 0):
 * the old regex cascade misrouted 13/19 shape-labeled asks (68%) — teaching-
 * shaped asks NEVER reached the deep treatment (0/8), and single-fact asks rode
 * the explain register (the "polite padding" class, which on Qwen carries
 * hallucinated padding). Every signal below earns its place via the shape probe
 * set (`local-ai/eval/shape-probes.ts`) — the anti-bloat rule: a signal with no
 * probe evidence does not belong here.
 *
 * Asymmetric-cost policy (plan-locked): never lecture on a guess. When signals
 * conflict or none fire, the shape is `uncertain` and the treatment is the
 * focused middle — the Stage-2 expansion affordance is the recovery, not a
 * longer answer.
 */

/**
 * The shape an ask deserves. `uncertain` receives the focused treatment;
 * `social` (greetings/thanks/acknowledgments/farewells) maps to the brief
 * `quick` family but ALSO suppresses the per-turn hint entirely — a social
 * turn carries no task to apply an instruction to, so appending one is
 * nonsense on every model (and on Gemma-LiteRT the model parrots it back).
 */
export type AnswerShape = 'teaching' | 'focused' | 'brief' | 'social' | 'uncertain';

/** Per-turn context the classifier may consult (all optional, deterministic). */
export type AnswerShapeContext = {
  /** Whether earlier conversation turns precede this one. */
  hasPriorTurns?: boolean;
};

// ─── Explicit depth words (migrated from chat-intent's cascade) ─────────────
//
// These previously lived as LONG_FORM_RE / DEEP_RE inside chat-intent.ts and
// routed straight to `deep`. They are the STRONGEST teaching signal (the user
// literally asked for depth), and exporting them here makes answer-shape the
// single owner of the depth axis. chat-intent imports them back for its
// cascade-order guarantee (explicit depth words keep beating WRITING_RE so
// "give me a detailed dinner recipe" stays deep, exactly as before).

export const LONG_FORM_RE = /\b(long|detailed|full|complete|comprehensive|step[- ]by[- ]step|in depth|thorough)\b/i;
export const DEEP_RE = /\b(analyze|compare|evaluate|strategy|plan|tradeoffs|pros and cons|deep|comprehensive|think through|architecture)\b/i;

// ─── Brief guards (checked FIRST — explicit instructions and single facts) ──

/**
 * Explicit format/length instructions WIN over everything (the inviolable
 * Wave-1 clause): "in one sentence", "reply with just the number", "no other
 * text", "JSON only", "exactly three …".
 */
const EXPLICIT_BREVITY_RE =
  /\b(?:in (?:exactly )?(?:one|a single|1|two|2|three|3) (?:sentence|sentences|word|words|line|lines)|one[- ]sentence|tl;?dr|(?:reply|answer|respond) with (?:just|only)|only the word|no other text|nothing else|(?:json|code|number|word)s? only|exactly (?:one|two|three|four|five|\d+)\b)/i;
// NOTE: "briefly"/"in short" are handled by POSITIONED_BREVITY_ADVERB_RE
// (below) — bare mid-sentence adverb uses are not instructions (PR #154
// review finding) and must affect neither routing nor hint suppression.

/**
 * Single-fact interrogative openers: "what is the capital of australia",
 * "who wrote the great gatsby", "when did world war 2 end", "how tall is …".
 * Bounded to short asks (a long what-is question is usually conceptual) and
 * vetoed by comparison/plurality/process markers, which deserve development.
 */
const SINGLE_FACT_OPENER_RE =
  /^(?:what(?:'?s| is| are| was| were)|who(?:'?s| is| are| was| were| wrote| invented| founded| directed| painted| discovered)|when (?:is|was|did|does|do)|where (?:is|was|are|were)|how (?:many|much|old|far|tall|long|heavy))\b/i;

const SINGLE_FACT_VETO_RE =
  /\b(?:difference between|vs\.?|versus|ways?|tips|steps|options|pros and cons|why|how (?:do|can|should))\b/i;

/**
 * BROAD explicit-instruction detector for HINT SUPPRESSION (not routing).
 * Deliberately wider than `EXPLICIT_BREVITY_RE`: when the user gives ANY
 * format/length instruction, the per-turn hint is suppressed entirely —
 * measured (wave26-stage1-gates, if3): a hint appended AFTER the user's
 * instruction wins by recency on a 1.2B and breaks the inviolable
 * instructions-win clause (6 sentences against "in exactly one sentence").
 * Asymmetric cost: suppressing a hint on a false positive loses a little
 * scaffolding; contradicting an explicit instruction loses user trust.
 * Routing stays shape-driven — only the hint yields.
 */
const FORMAT_INSTRUCTION_RE =
  /\b(?:in (?:exactly )?(?:one|a single|\d+|two|three|four|five) (?:sentence|sentences|word|words|line|lines|paragraph|paragraphs|bullet|bullets|point|points)|one[- ]sentence|keep it (?:short|brief|simple|to)|no more than|at most|word limit|(?:reply|answer|respond) (?:with|in) (?:just|only|exactly|one\b|a single|\d+|json\b|markdown\b|bullets?\b|code\b)|only the word|no other text|nothing else|exactly \d+|exactly (?:one|two|three|four|five)|as (?:a|an) (?:list|table|poem|haiku|json|outline)|in (?:json|markdown|bullet|table|list) (?:form|format)?|bullet points? only|(?:json|code|number|word)s? only|use (?:only )?(?:bullet points?|bullets?|json|markdown)\b)\b/i;

/**
 * "briefly" / "in short" are instructions only when POSITIONED like one —
 * clause-initial, after a comma/dash, or sentence-final. Mid-sentence uses
 * ("a good way to briefly meet new people") are ordinary adverbs and must
 * not suppress the hint (review finding, PR #154).
 */
const POSITIONED_BREVITY_ADVERB_RE =
  /(?:^|[,;:—–-]\s*)(?:briefly|in short)\b|\b(?:briefly|in short)\s*[.!?]?\s*$/i;

/**
 * Whether the user gave an explicit format/length instruction this turn.
 * Consumed by `chat-intent.buildHintedUserTurn` to suppress the per-turn
 * hint (see FORMAT_INSTRUCTION_RE rationale). Pure and deterministic — part
 * of the history re-render contract.
 */
export function hasExplicitFormatInstruction(content: string): boolean {
  return (
    FORMAT_INSTRUCTION_RE.test(content)
    || POSITIONED_BREVITY_ADVERB_RE.test(content.trim())
    || EXPLICIT_BREVITY_RE.test(content)
  );
}

/**
 * Courtesy preambles users wrap fact lookups in ("i want to know who wrote
 * 1984", "can you tell me when ww2 ended"). Stripped before the single-fact
 * opener test so the wrapper doesn't hide the lookup.
 */
const COURTESY_PREAMBLE_RE =
  /^(?:i (?:want|need|would like|'?d like) to know|can you tell me|could you tell me|do you know|tell me)[,:]?\s+/i;

const SINGLE_FACT_MAX_WORDS = 14;

/**
 * Short anaphoric follow-up in an ongoing thread ("make day 3 harder",
 * "can you make that into a checklist") — must match the conversation
 * register, not balloon into a lecture.
 */
const ANAPHORA_RE = /\b(?:that|those|this|these|it|them|one|day \d+|step \d+|number \d+)\b/i;
const FOLLOW_UP_MAX_WORDS = 8;

/** Bare fragments ("capital of france?", "build me a sandwich"). */
const SHORT_FRAGMENT_MAX_WORDS = 4;

// ─── Social turns (greetings / thanks / acks / farewells) ───────────────────
//
// A social turn is one whose ENTIRE text is a social phrase — greeting, thanks,
// acknowledgment, or farewell — optionally padded with social filler ("hi
// there", "ok cool", "thanks so much"). The full-match anchoring IS the
// conservative guard the brief requires: any substantive content (a question
// or a task, e.g. "hi, what's the capital of france?") leaves a residue the
// alternation can't consume, so the turn is NOT social and routes on its
// substance. Pure and deterministic — part of the history re-render contract.

const SOCIAL_PHRASE =
  // greetings
  'hello|hi|hey|heya|hiya|howdy|yo|greetings|sup|good morning|good afternoon|good evening|good day|morning|afternoon|evening|whats up|whatsup|wassup|how are you|hows it going|how goes it|'
  // thanks
  + 'thanks|thank you|thankyou|thanks so much|thank you so much|thanks a lot|thanks a ton|thanks again|many thanks|much appreciated|appreciate it|appreciate that|thx|ty|cheers|'
  // acknowledgments
  + 'ok|okay|k|kk|cool|nice|great|awesome|sweet|got it|gotcha|sounds good|sure|alright|all right|right|fair enough|makes sense|perfect|understood|yep|yeah|yup|will do|'
  // farewells
  + 'bye|bye bye|goodbye|see you|see ya|see you later|later|cya|take care|good night|goodnight|night';

// Filler that may pad a social utterance without adding substance.
const SOCIAL_FILLER = 'there|you|all|everyone|team|friend|mate|again|too|though|so much|a lot|much|for that|for this|for the help|for helping|that helps|that helped';

const SOCIAL_RE = new RegExp(
  `^(?:${SOCIAL_PHRASE})(?: (?:${SOCIAL_FILLER}|${SOCIAL_PHRASE}))*$`,
  'i',
);

/**
 * Whether a user turn is purely social (greeting/thanks/ack/farewell).
 * Consumed by `chat-intent.buildHintedUserTurn` to suppress the per-turn hint
 * (same precedence as `hasExplicitFormatInstruction`) and by `inferAnswerShape`
 * to classify the turn `social`. Pure and deterministic.
 */
export function isSocialTurn(content: string): boolean {
  // Strip punctuation, apostrophes, and emoji to spaces so "Hello!", "what's
  // up?", and "thanks 🙏" normalize to their social core, then require the
  // WHOLE utterance to be social.
  const normalized = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return SOCIAL_RE.test(normalized);
}

// ─── Teaching signals ────────────────────────────────────────────────────────

/**
 * Teach/skill speech-acts: "teach me", "walk me through", "help me figure
 * out", "how do i get better at …", "where do i start".
 */
const TEACH_SPEECH_ACT_RE =
  /\b(?:teach me|show me how|walk me through|guide me (?:through|on)|help me (?:learn|figure out|understand|plan)|where (?:do|should) i (?:start|begin)|how (?:do|can|should) i\b.*\b(?:better|improve)|get(?:ting)? better at|improve my)\b/i;

/**
 * Goal-framing: "i want to learn spanish", "im trying to get into running"
 * (apostrophe optional — real users type "im"). Requires a learn/do verb
 * after the goal phrase so "i want to know who wrote 1984" stays a fact
 * lookup, not a course.
 */
const GOAL_FRAMING_RE =
  /\b(?:i(?:'?m| am)?\s+(?:want(?:ing)?\s+to|trying\s+to|hoping\s+to|looking\s+to)|i\s+wanna)\s+(?:\w+\s+)?(?:learn|start|get|improve|build|become|make|understand|master|pick up)\b/i;

/**
 * Plurality-of-options markers: "give me some tips on negotiating",
 * "what are some ways to …", "advice on …", "a plan for …".
 */
const PLURALITY_RE =
  /\b(?:(?:give me|any|some|a few|share) (?:\w+ )?(?:tips|ideas|suggestions|strategies|ways|steps|options)|(?:tips|ideas|suggestions|strategies|ways|steps|options) (?:on|for|to|about)|advice (?:on|for|about)|a plan (?:for|to))\b/i;

/** Long asks deserve depth (preserves the old >360-char catch-all-to-deep). */
const LONG_ASK_MIN_CHARS = 360;

// ─── Focused detection (observability only — same treatment as uncertain) ───

const INTERROGATIVE_OPENER_RE =
  /^(?:what(?:'?s)?|why|how|who(?:'?s)?|where|when|which|tell me|explain|is|are|was|were|does|do|did|can|could|should|will|would)\b/i;

// ─── Classifier ──────────────────────────────────────────────────────────────

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Classify the answer shape of one user turn. Pure and deterministic — the
 * SAME function runs at dispatch time and when history is re-rendered, so a
 * past turn always re-classifies identically (the KV strict-prefix contract
 * for hint re-attachment depends on this; see chat-intent.applyTurnHints).
 *
 * Order matters and is probe-pinned:
 *   1. explicit format/length instruction → brief (absolute — instructions win)
 *   2. single-fact interrogative → brief (the anti-padding guard)
 *   3. purely social turn → social (greeting/thanks/ack/farewell; suppresses
 *      the per-turn hint — checked before teaching/fragment so a full-match
 *      social utterance is never re-read as a task)
 *   4. teaching signals → teaching (explicit depth words are the strongest)
 *   5. short anaphoric follow-up → brief (register-matching)
 *   6. short fragment → brief (elliptical commands)
 *   7. interrogative shape → focused
 *   8. nothing fires → uncertain (focused treatment; never lecture on a guess)
 */
export function inferAnswerShape(content: string, context?: AnswerShapeContext): AnswerShape {
  const text = content.trim();
  const count = wordCount(text);

  if (EXPLICIT_BREVITY_RE.test(text) || POSITIONED_BREVITY_ADVERB_RE.test(text)) return 'brief';
  const unwrapped = text.replace(COURTESY_PREAMBLE_RE, '');
  if (
    count <= SINGLE_FACT_MAX_WORDS
    && SINGLE_FACT_OPENER_RE.test(unwrapped)
    && !SINGLE_FACT_VETO_RE.test(text)
  ) {
    return 'brief';
  }

  if (isSocialTurn(text)) return 'social';

  if (
    LONG_FORM_RE.test(text)
    || DEEP_RE.test(text)
    || TEACH_SPEECH_ACT_RE.test(text)
    || GOAL_FRAMING_RE.test(text)
    || PLURALITY_RE.test(text)
    || text.length > LONG_ASK_MIN_CHARS
  ) {
    return 'teaching';
  }

  if (context?.hasPriorTurns && count <= FOLLOW_UP_MAX_WORDS && ANAPHORA_RE.test(text)) {
    return 'brief';
  }
  if (count <= SHORT_FRAGMENT_MAX_WORDS) return 'brief';

  if (INTERROGATIVE_OPENER_RE.test(text) || /\?\s*$/.test(text)) return 'focused';
  return 'uncertain';
}
