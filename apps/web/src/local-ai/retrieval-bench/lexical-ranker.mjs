// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * LEXICAL arm — a faithful port of the SHIPPED keyword/coverage grounding gate
 * (apps/web/src/lib/tools/wikipedia-grounding-tool.ts), adapted from "search
 * Wikipedia" to "rank this local corpus". Nothing here is a strawman: the gate
 * decision copies the shipped guards (deny-set, factual-cue requirement, entity /
 * keyword extraction), and the ranker reuses the shipped significant-token folding
 * (`foldTokens`) and the same stopword / connector / qualifier sets so a query's
 * "content tokens" are exactly what the shipped `buildKeywordQuery` would keep.
 *
 * RANKING is coverage-based, mirroring the shipped inverted coverage gate
 * (`userTextCoversTitle`): score a doc by how many of the query's content tokens
 * it covers, weighting title matches above body matches (the shipped tool matches
 * article TITLES). This is deliberately faithful to the shipped mechanism, which
 * has NO IDF and NO length normalization — read results as "today's shipped gate",
 * not "the strongest possible lexical retriever".
 *
 * Pure module: no browser imports, no network, no model.
 *
 * @typedef {import('./corpus.mjs').BenchDoc} BenchDoc
 * @typedef {{ docId: string, score: number }} RankedDoc
 */

// ───────────────────────── shared token sets (ported) ──────────────────────

/** @see wikipedia-grounding-tool.ts ENTITY_STOPWORDS */
const ENTITY_STOPWORDS = new Set(
  [
    'Who', 'What', 'Whats', 'When', 'Where', 'Why', 'Which', 'Whose', 'How',
    'Is', 'Are', 'Was', 'Were', 'Do', 'Does', 'Did', 'Can', 'Could', 'Should',
    'Would', 'Will', 'Tell', 'Write', 'Explain', 'Give', 'List', 'Describe',
    'Please', 'Make', 'Show', 'Help', 'The', 'A', 'An', 'Of', 'In', 'On',
    'If', 'While', 'Although', 'Though', 'Since', 'Because', 'After', 'Before',
    'Once', 'Unless', 'Whether', 'And', 'But', 'So', 'Also', 'Then', 'Now',
    'Today', 'Tomorrow', 'Yesterday', 'Just', 'Maybe', 'Perhaps',
    'I', 'My', 'Me', 'We', 'Our', 'You', 'Your', 'He', 'She', 'It', 'They',
    'Them', 'His', 'Her', 'Its', 'Their', 'This', 'That', 'These', 'Those',
  ].map((w) => w.toLowerCase()),
);

/** @see wikipedia-grounding-tool.ts ENTITY_CONNECTORS */
const ENTITY_CONNECTORS = new Set([
  'of', 'the', 'and', 'de', 'von', 'der', 'da', 'del', 'la', 'le', 'el',
]);

/** @see wikipedia-grounding-tool.ts QUERY_QUALIFIER_WORDS */
const QUERY_QUALIFIER_WORDS = new Set([
  'many', 'much', 'tall', 'old', 'far', 'big', 'high', 'long', 'large', 'deep',
  'populous',
]);

const MIN_QUERY_TOKENS = 2;
const MAX_QUERY_TOKENS = 8;

// Combining diacritics U+0300-U+036F (pure-ASCII source, file convention).
const COMBINING_DIACRITICS = new RegExp(
  `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`,
  'g',
);

/**
 * Significant-token tokenizer — a direct port of the shipped `foldTokens`:
 * NFD-fold, strip combining diacritics, lowercase, split on non-alphanumerics,
 * drop empties and {@link ENTITY_CONNECTORS}.
 * @param {string} text
 * @returns {string[]}
 */
export function foldTokens(text) {
  return text
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== '' && !ENTITY_CONNECTORS.has(token));
}

/**
 * The query's CONTENT tokens — exactly the shipped `buildKeywordQuery` filter
 * (drop stopwords + qualifier tails + single-char debris) but without the digit
 * rejection and 2..8 count bound, because for RANKING we want the content tokens
 * even on a one-token or long query. Used only for scoring, never for the gate.
 * @param {string} text
 * @returns {string[]}
 */
export function queryContentTokens(text) {
  return foldTokens(text).filter(
    (tok) =>
      tok.length >= 2 &&
      !ENTITY_STOPWORDS.has(tok) &&
      !QUERY_QUALIFIER_WORDS.has(tok),
  );
}

// ───────────────────────── gate: ported guards ─────────────────────────────

/** @see INTERROGATIVE_CUE */
const INTERROGATIVE_CUE = /\b(?:who|what|whats|what's|where|when|which|whose|how)\b/i;
/** @see FACTUAL_ATTRIBUTE */
const FACTUAL_ATTRIBUTE =
  /\b(?:population|capital|located|location|founded|established|born|died|height|area|currency|languages?|elevation|nationality|invented|discovered|author|director|president|prime minister)\b/i;
/** @see LOOKUP_LEAD */
const LOOKUP_LEAD =
  /\b(?:tell me about|what(?:'s| is| are)|whats|who(?:'s| is| are|s)|where(?:'s| is)|when (?:was|were|did|is))\b/i;

/** @see DENY_PATTERNS */
const DENY_PATTERNS = [
  /\b(?:write|compose|draft|poem|story|stories|song|essay|joke|jokes|rap|haiku|lyrics|make up|made up|invent|imagine|pretend|roleplay|role-play)\b/i,
  /\b(?:proofread|rewrite|re-?write|reword|rephrase|retype)\b/i,
  /\b(?:fix|correct|check|improve|polish|clean up|tidy up)\b[^.?!\n]{0,30}\b(?:spelling|grammar|typos?|punctuation|mistakes?|wording|phrasing|errors?)\b/i,
  /\b(?:spelling|grammar|typos?|punctuation|wording|phrasing)\b[^.?!\n]{0,30}\b(?:fix|correct|check|improve|polish)\b/i,
  /\b(?:what do you think|do you think|your opinion|in your opinion|should i|is it worth|worth it|recommend|suggest|best (?:place|restaurant|book|movie|city|time|way))\b/i,
  /(?:\bbetter than\b|\s+vs\.?\s+|\bversus\b)/i,
  /\b(?:function|regex|javascript|typescript|python|java|rust|golang|code|debug|compile|\bapi\b|sql|algorithm)\b/i,
  /\b(?:translate|translation|in french|in spanish|in german|in italian|how do you say)\b/i,
  /\b(?:who are you|what are you|what can you do|what model|your name|how are you)\b/i,
];

const ATTRIBUTE_ONLY_ASK_MAX_CHARS = 120;
const SHORT_TURN_MAX_CHARS = 280;
const ENTITY_MAX_CHARS = 80;
const ENTITY_MAX_WORDS = 6;

const PATH_OR_CODE_LIKE =
  /[/\\@]|::|\.(?:py|js|mjs|cjs|ts|tsx|jsx|rs|go|java|rb|swift|kt|c|cc|cpp|h|hpp|cs|php|json|ya?ml|toml|ini|log|txt|md|sh|sql|html?|css|xml)\b/i;
const DEMONSTRATIVE_HEAD = /^(?:this|that|these|those|my|your|our|their|his|her|its)\b/i;

/** @see isAskingAQuestion */
function isAskingAQuestion(ask) {
  if (ask.includes('?')) return true;
  const match = INTERROGATIVE_CUE.exec(ask);
  if (match === null) return false;
  return ask.slice(0, match.index).trim() === '';
}

/** @see extractQuotedSpan */
function extractQuotedSpan(text) {
  const TYPO_DOUBLE = new RegExp('“([^“”]+)”');
  const TYPO_SINGLE = new RegExp('‘([^‘’]+)’');
  const m = /"([^"]+)"/.exec(text) ?? TYPO_DOUBLE.exec(text) ?? TYPO_SINGLE.exec(text);
  const inner = m?.[1]?.trim();
  return inner !== undefined && inner !== '' ? inner : null;
}

/** @see extractTitleCaseEntity */
function extractTitleCaseEntity(text) {
  const tokens = text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  const isCapitalized = (tok) => /^\p{Lu}[\p{L}\p{N}]*(?:-[\p{L}\p{N}]+)*$/u.test(tok);
  const isConnector = (tok) => ENTITY_CONNECTORS.has(tok.toLowerCase());
  const isStopword = (tok) => ENTITY_STOPWORDS.has(tok.toLowerCase());

  let best = [];
  let current = [];
  const flush = () => {
    let last = current[current.length - 1];
    while (last !== undefined && isConnector(last)) {
      current.pop();
      last = current[current.length - 1];
    }
    if (current.length > best.length) best = current;
    current = [];
  };
  for (const tok of tokens) {
    if (tok === '') { flush(); continue; }
    if (isCapitalized(tok)) {
      if (current.length === 0 && isStopword(tok)) continue;
      current.push(tok);
      continue;
    }
    if (current.length > 0 && isConnector(tok)) { current.push(tok); continue; }
    flush();
  }
  flush();
  if (best.length === 0) return null;
  return best.join(' ').trim();
}

const LOWERCASE_LEAD =
  /\b(?:who(?:'s| is| was| are)|where(?:'s| is| was)|what(?:'s| is| are| was)|when (?:was|did|is)|how (?:old|tall|big|far) (?:is|was)|tell me about|teach me about)\s+(.+)$/i;
const ATTRIBUTE_PREFIX =
  /^(?:the\s+)?(?:population|capital|height|area|currency|president|prime minister|elevation|location|history|age|founder|ceo|author|director)\s+of\s+/i;
const TRAILING_QUALIFIER =
  /\s+(?:born|from|located|founded|established|made|invented|discovered|now|today|currently|about|like)\s*$/i;

/** @see extractLowercaseEntity */
function extractLowercaseEntity(text) {
  const m = LOWERCASE_LEAD.exec(text);
  const raw = m?.[1]?.trim();
  if (raw === undefined || raw === '') return null;
  let span = raw.replace(/[?!.]+\s*$/g, '').trim();
  span = span.replace(ATTRIBUTE_PREFIX, '');
  span = span.replace(TRAILING_QUALIFIER, '');
  span = span.replace(/^(?:the|a|an)\s+/i, '').trim();
  const words = span.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0 || words.length > 5) return null;
  if (!/\p{L}/u.test(span)) return null;
  if (/\d/.test(span)) return null;
  if (words.every((w) => ENTITY_STOPWORDS.has(w.toLowerCase()))) return null;
  return span;
}

/** @see isPlausibleEntity (single-token sentence-casing rule omitted: queries are typed asks, not pasted prose) */
function isPlausibleEntity(span) {
  const s = span.trim();
  if (s === '' || s.length > ENTITY_MAX_CHARS) return false;
  if (/[\n\r]/.test(s)) return false;
  if (PATH_OR_CODE_LIKE.test(s)) return false;
  if (s.split(/\s+/).filter((w) => w !== '').length > ENTITY_MAX_WORDS) return false;
  if (DEMONSTRATIVE_HEAD.test(s)) return false;
  return true;
}

/** @see buildKeywordQuery */
function buildKeywordQuery(text) {
  if (typeof text !== 'string' || /\d/.test(text)) return null;
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (tok) =>
        tok.length >= 2 &&
        !ENTITY_STOPWORDS.has(tok) &&
        !QUERY_QUALIFIER_WORDS.has(tok),
    );
  if (tokens.length < MIN_QUERY_TOKENS || tokens.length > MAX_QUERY_TOKENS) return null;
  return tokens.join(' ');
}

/**
 * The shipped gate decision, ported: would grounding fire for this turn?
 * Deny-set short-circuit -> factual-cue requirement -> extract an entity
 * (quoted / Title-Case / lowercase recovery) OR a zero-entity keyword query.
 * Queries here are short typed asks (< 280 chars) so the ask window is the whole
 * turn; the full paste-windowing path is not exercised.
 * @param {string} userText
 * @returns {boolean} true = the lexical arm decides to ground.
 */
export function lexicalGate(userText) {
  if (typeof userText !== 'string' || userText.trim() === '') return false;
  for (const deny of DENY_PATTERNS) {
    if (deny.test(userText)) return false;
  }
  const ask = userText.trim();
  if (ask.length > SHORT_TURN_MAX_CHARS) return false; // paste path — out of scope here

  const hasCue =
    (INTERROGATIVE_CUE.test(ask) && isAskingAQuestion(ask)) ||
    LOOKUP_LEAD.test(ask) ||
    (FACTUAL_ATTRIBUTE.test(ask) && ask.length <= ATTRIBUTE_ONLY_ASK_MAX_CHARS);
  if (!hasCue) return false;

  const quoted = extractQuotedSpan(ask);
  const titled = extractTitleCaseEntity(ask);
  const entity =
    (quoted !== null && isPlausibleEntity(quoted) ? quoted : null) ??
    (titled !== null && isPlausibleEntity(titled) ? titled : null);
  if (entity !== null && entity.trim() !== '') return true;

  const recovered = extractLowercaseEntity(ask);
  if (recovered !== null && isPlausibleEntity(recovered)) return true;

  // zero-entity keyword path (FULLTEXT_LEAD is a subset of INTERROGATIVE cues we
  // already required; the decisive test is a buildable 2..8-token keyword query).
  return buildKeywordQuery(ask) !== null;
}

// ───────────────────────── ranking: coverage ───────────────────────────────

const TITLE_WEIGHT = 2;
const BODY_WEIGHT = 1;

/**
 * Precompute a doc's folded title-token and full-token sets once.
 * @param {readonly BenchDoc[]} corpus
 */
export function indexCorpusLexical(corpus) {
  return corpus.map((doc) => ({
    id: doc.id,
    titleTokens: new Set(foldTokens(doc.title)),
    allTokens: new Set(foldTokens(`${doc.title} ${doc.text}`)),
  }));
}

/**
 * Rank docs by query-keyword coverage, weighting title hits above body hits —
 * the local-corpus analog of the shipped inverted coverage gate. Ties break on
 * title-coverage fraction, then on fewer total doc tokens (prefer the focused
 * matching doc). Docs with zero coverage keep score 0 and sort last.
 * @param {string} query
 * @param {ReturnType<typeof indexCorpusLexical>} index
 * @returns {RankedDoc[]} sorted best-first
 */
export function lexicalRank(query, index) {
  const qTokens = queryContentTokens(query);
  const qSet = new Set(qTokens);
  const scored = index.map((doc) => {
    let score = 0;
    let titleHits = 0;
    for (const t of qSet) {
      const inTitle = doc.titleTokens.has(t);
      const inBody = doc.allTokens.has(t);
      if (inTitle) { score += TITLE_WEIGHT; titleHits += 1; }
      else if (inBody) { score += BODY_WEIGHT; }
    }
    const titleCoverage = qSet.size === 0 ? 0 : titleHits / qSet.size;
    return { docId: doc.id, score, titleCoverage, docSize: doc.allTokens.size };
  });
  scored.sort((a, b) =>
    b.score - a.score ||
    b.titleCoverage - a.titleCoverage ||
    a.docSize - b.docSize ||
    a.docId.localeCompare(b.docId),
  );
  return scored.map(({ docId, score }) => ({ docId, score }));
}
