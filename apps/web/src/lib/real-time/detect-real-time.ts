// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Real-time ask detection — "does answering this honestly require information
 * from right now?"
 *
 * WHY THIS EXISTS. An on-device model holds no live information at all: no
 * clock on the world, no traffic, no schedules, no prices. Measured on the
 * 24-prompt real-time pool (2026-09-09), the shipping models decline honestly
 * about two thirds of the time and invent a venue, a delay, a kickoff time or
 * a winner the rest of the time. The only honesty marker the host drew until
 * now was the "answered from memory" note, and that note is the Wikipedia
 * grounding matcher's shadow: it appears on the prompts that matcher happens
 * to claim (17 of 24), so five of the seven confident inventions rendered with
 * no marker at all — and where it did render it said the wrong thing, since
 * turning lookups on would fetch an encyclopedia article, never live data.
 *
 * So this is a separate, host-side, NETWORK-FREE check. It decides only what
 * the host draws under the reply (an honest note plus an outbound search link
 * the user may click). It never changes the prompt, never runs a tool, and
 * never sends anything anywhere.
 *
 * DELIBERATE HAND-WRITTEN HEURISTIC. The target architecture wants fewer
 * matchers like this one, not more. This one is accepted because it is
 * narrowly scoped to a single class of ask, it is pinned by the eval pool in
 * `src/local-ai/eval/real-time-probes.ts` (the unit test asserts every prompt
 * in that pool matches and that the known-answer / everyday-conversation /
 * quantum-trade pools produce zero matches), and it stands in until a
 * host-side check of a different kind — one that does not spend regexes on
 * vocabulary — exists.
 *
 * PRECISION OVER RECALL, same posture as the grounding matcher. A false
 * positive is the felt failure: an honest-sounding "Eco can't check live
 * information" under an answer that needed nothing live reads as a broken
 * product. A miss just leaves today's behaviour. So the detector abstains by
 * default and demands BOTH axes:
 *
 *   1. a TIME cue that points at the current or immediately surrounding
 *      period ("right now", "tonight", "this weekend", "last night"), and
 *   2. a SUBJECT cue naming something that actually CHANGES — live conditions,
 *      what is on or open in a place, or a schedule/result.
 *
 * One axis alone is never enough, and that is the whole design. "today" on its
 * own belongs to the deterministic date tool ("what date is 6 weeks from
 * today"); "game" on its own is a rules question ("how does the offside rule
 * work"). Only the pair is a real-time ask.
 */

/** A turn longer than this is a paste, not a question. Abstain rather than scan it. */
const MAX_ASK_CHARS = 280;

/**
 * Deny-set: turns that may carry both cues but are NOT asking about the world
 * right now. Mirrors the grounding matcher's layered-guard idiom — small,
 * focused, commented regexes, any one of which abstains.
 */
const DENY_PATTERNS: readonly RegExp[] = [
  // Creative / imperative authoring — "write a story about a game tonight".
  /\b(?:write|compose|draft|poem|story|stories|song|essay|joke|jokes|rap|haiku|lyrics|make up|made up|invent|imagine|pretend|roleplay|role-play)\b/i,
  // Editing the user's own text — nothing external is being asked for.
  /\b(?:proofread|rewrite|re-?write|reword|rephrase|summarize|summarise)\b/i,
  // Code / programming — "open", "queue", "running" and "wait" are all ordinary
  // programming vocabulary, so this screen matters more here than in grounding.
  /\b(?:function|regex|javascript|typescript|python|java|rust|golang|code|debug|compile|\bapi\b|sql|algorithm|variable|array|async|thread)\b/i,
  // Translation.
  /\b(?:translate|translation|in french|in spanish|in german|in italian|how do you say)\b/i,
  // Meta / self-referential — about Eco, not about the world.
  /\b(?:who are you|what are you|what can you do|what model|your name|how are you)\b/i,
  // Recommendations a local model CAN answer. "what's a good movie to watch
  // tonight" carries a time word and a media noun, but nothing about it needs
  // live information — the model's own knowledge of films is the whole answer,
  // and an "Eco can't check live information" note under a perfectly good
  // suggestion is exactly the felt false positive this module defends against.
  // The shape that separates them is the verb: watching, reading, playing and
  // cooking are things the person will do with the suggestion, whereas a real
  // real-time ask is about what is ON somewhere ("what movies are PLAYING near
  // me tonight").
  /\b(?:good|great|best|fun|favou?rite|nice|solid)\s+(?:\w+\s+){0,2}?to\s+(?:watch|read|play|binge|stream|listen|cook|make|bake|try)\b/i,
  /\bto\s+(?:watch|read|binge|stream|listen to)\b/i,
  /\bwhat should (?:i|we|they|you)\s+(?:watch|read|play|cook|make|listen|bake)\b/i,
  // Board/video/card games are objects, not fixtures.
  /\b(?:board|video|card|party|drinking)\s+games?\b/i,
  // Deterministic-tool asks that merely MENTION the present. The date and clock
  // tools answer these exactly; a "can't check live information" note under a
  // correct computed answer would be a plain lie. Kept explicit rather than
  // relying on the subject axis to miss them, because the cost of being wrong
  // here is a visibly self-contradicting reply.
  /\bwhat (?:day|date|month|year)\b/i,
  /\bwhat time is it\b/i,
  /\bhow many (?:days|weeks|months|years|hours|minutes)\b/i,
  /\b(?:weeks?|days?|months?|years?|hours?)\s+(?:from|until|till|before|after|ago)\b/i,
];

/**
 * TIME cues — the present, or the period immediately around it.
 *
 * "tomorrow" is deliberately absent: it reads as planning far more often than
 * as a live-state ask, and the pool contains none. Bare day names are admitted
 * only when anchored ("this saturday", "on saturday", "friday night"), never on
 * their own, so "which saturday is better for a wedding" carries no cue.
 */
const TIME_CUES: readonly RegExp[] = [
  /\b(?:right now|at the moment|currently|as of now|these days|nowadays)\b/i,
  /\btonight\b/i,
  /\btoday\b/i,
  /\blast night\b/i,
  /\bthis (?:weekend|week|month|year|morning|afternoon|evening|season)\b/i,
  // "this saturday", "on a friday", "next sunday", "last monday".
  /\b(?:this|next|last|on)\s+(?:a\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i,
  // "friday night", "sunday morning".
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\s+(?:night|morning|afternoon|evening)\b/i,
  // "when is the next home game" — the next occurrence of a recurring thing.
  /\bthe next\b/i,
];

/**
 * SUBJECT cues, grouped by the three shapes the pool is built from. Any one
 * group satisfies the second axis.
 *
 * Media and games are deliberately NOT here as bare nouns. "movie", "show" and
 * "game" name a THING as often as an OCCURRENCE, and the thing-sense belongs to
 * the model ("a good movie to watch tonight"). Only the occurrence-sense is a
 * real-time ask, so those nouns qualify only inside a venue/fixture form: what
 * is playing or showing somewhere, what is happening near me, tickets and
 * listings, or a game in an actual sports frame (a kickoff, a score, who won, a
 * home game, or a game pinned to a day).
 */
const SUBJECT_CUES: readonly RegExp[] = [
  // ── live state: conditions, transit, queues, markets ──
  /\b(?:traffic|weather|forecast|temperature|raining|snowing|delays?|delayed|cancell?ed|outage)\b/i,
  /\b(?:train|trains|subway|metro|bus|buses|ferry|flight|flights)\b/i,
  /\b(?:wait|queue|busy|crowded|packed|sold out)\b/i,
  /\b(?:price|prices|cost right now|stock price|exchange rate)\b/i,
  // "is X open / closed" and "open tonight" — the two shapes that are about
  // present state rather than the generic verb "open".
  /\b(?:is|are|will)\b[^?]{0,60}\b(?:open|closed)\b/i,
  /\b(?:open|closed)\s+(?:right now|now|today|tonight|late)\b/i,

  // ── plans: what is on, good, or worth doing in a place ──
  /\b(?:restaurants?|bars?|rooftop|cafes?|pubs?|clubs?|nightlife)\b/i,
  /\b(?:concerts?|festivals?|exhibits?|gigs?)\b/i,
  /\b(?:hike|hikes|day trip|night out|things to do|to do in|near me|happening|going on)\b/i,
  /\b(?:something|anything)\s+(?:fun|good|cool|new|interesting)\b/i,
  /\bplan me\b/i,
  // The occurrence form for media: on somewhere, rather than worth watching.
  /\b(?:playing|showing|screening|on)\s+(?:near me|nearby|tonight|today|this weekend|right now)\b/i,
  /\b(?:tickets?|listings?|showtimes?|line ?up)\b/i,

  // ── schedules and results ──
  // Fixture vocabulary that is unambiguous on its own.
  /\b(?:kickoff|playoffs?|super bowl|world series|world cup|home game|standings|scores?)\b/i,
  /\bwho (?:won|wins|is winning|is going to win|will win)\b/i,
  /\bwhat channel\b/i,
  // A schedule ask: "what time do the knicks play", "what time is the game".
  /\bwhat time (?:do|does|is|are)\b/i,
  // "game" only when pinned to a day — a fixture, not a pastime. Both orders,
  // since the day can lead ("tonight's game") or trail ("a game this weekend").
  /\bgames?\b[^?]{0,30}\b(?:tonight|today|this weekend|this week|last night|right now)\b/i,
  /\b(?:tonight|today|this weekend|this week|last night|right now)\b[^?]{0,30}\bgames?\b/i,
  // "…play tonight" — a fixture verb pinned to a day. The pastime sense
  // ("board games to play tonight") is screened by the deny set above.
  /\b(?:play|plays|playing)\b[^?]{0,25}\b(?:tonight|today|this weekend|last night|right now)\b/i,
];

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the turn asks about something that can only be answered with
 * information from right now — live conditions, what is on or open in a place,
 * or a schedule/result. Abstains by default; see the module comment for the
 * two-axis rule and why one axis alone never qualifies.
 *
 * Pure and network-free: it reads the string and nothing else.
 */
export function isRealTimeAsk(text: string): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const ask = text.trim();
  if (ask === "" || ask.length > MAX_ASK_CHARS) {
    return false;
  }
  if (matchesAny(DENY_PATTERNS, ask)) {
    return false;
  }
  return matchesAny(TIME_CUES, ask) && matchesAny(SUBJECT_CUES, ask);
}
