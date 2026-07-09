// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Query preprocessor for privacy-enhanced network sends (NEXT-06).
 *
 * Strips personally identifiable information (PII) from user queries
 * before they are sent over the network to the Eco inference API.
 * Also classifies queries by type for routing hints.
 *
 * **Privacy model:**
 * - This runs ONLY before network sends (not for local inference)
 * - The original unsanitized text is used for local inference
 * - The sanitized version is what goes over the network
 * - This is opt-in (default OFF) via localStorage flag
 *   `eco-query-preprocessing-enabled`
 *
 * PII detection is regex-based and conservative: it is better to
 * miss a potential PII match than to falsely redact a code identifier
 * or technical term. This is a best-effort privacy enhancement, not
 * a compliance-grade PII detector.
 */

import { safeStorage } from './local-storage';

// ── Types ──────────────────────────────────────────────────────────────────────

export type RedactionType = 'email' | 'phone' | 'url' | 'name' | 'ip';

export type Redaction = {
  /** Type of PII that was redacted */
  type: RedactionType;
  /** Start index in original string */
  start: number;
  /** End index in original string */
  end: number;
  /** Replacement token (e.g., "[EMAIL]") */
  replacement: string;
};

export type QueryCategory = 'general' | 'code' | 'reasoning' | 'creative';

export type PreprocessedQuery = {
  /** The sanitized query text with PII replaced */
  sanitized: string;
  /** Classification of the query type */
  classification: QueryCategory;
  /** Length of the original query in characters */
  originalLength: number;
  /** Number of PII items that were redacted */
  redactedCount: number;
};

// ── PII Patterns ───────────────────────────────────────────────────────────────

/**
 * Email pattern: standard RFC-like email matching.
 * Conservative: requires word boundary and valid TLD-length suffix.
 */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Phone pattern: optional country code, various separators.
 * Matches: +1-555-123-4567, (555) 123-4567, 555.123.4567, etc.
 */
const PHONE_PATTERN =
  /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

/**
 * URL pattern: http:// or https:// followed by non-whitespace.
 */
const URL_PATTERN = /https?:\/\/[^\s<>'"]+/g;

/**
 * Name pattern: heuristic matching for common introduction patterns.
 * Only matches capitalized words after identifying phrases.
 * Conservative: "my name is X", "I'm X", "call me X"
 */
const NAME_PATTERNS = [
  /\b[Mm]y name is ([A-Z][a-z]+)\b/g,
  /\bI'm ([A-Z][a-z]+)\b/g,
  /\b[Cc]all me ([A-Z][a-z]+)\b/g,
];

/**
 * IP address pattern: IPv4 dotted-quad notation.
 */
const IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

// ── Sanitization ───────────────────────────────────────────────────────────────

/**
 * Strip personally identifiable information from a query string.
 *
 * Replaces emails, phone numbers, URLs, names (heuristic), and IP
 * addresses with bracketed tokens ([EMAIL], [PHONE], etc.).
 *
 * @returns Object containing the sanitized text and an array of redactions.
 */
export function sanitizeQuery(text: string): {
  sanitized: string;
  redactions: Redaction[];
} {
  if (!text) {
    return { sanitized: '', redactions: [] };
  }

  const redactions: Redaction[] = [];
  let result = text;

  // Order matters: process URLs before emails (URLs may contain @ in path)
  // Process in reverse order of specificity

  // 1. URLs (most specific — contains ://)
  result = result.replace(URL_PATTERN, (match, offset: number) => {
    redactions.push({
      type: 'url',
      start: offset,
      end: offset + match.length,
      replacement: '[URL]',
    });
    return '[URL]';
  });

  // 2. Emails
  result = result.replace(EMAIL_PATTERN, (match, offset: number) => {
    redactions.push({
      type: 'email',
      start: offset,
      end: offset + match.length,
      replacement: '[EMAIL]',
    });
    return '[EMAIL]';
  });

  // 3. Phone numbers
  result = result.replace(PHONE_PATTERN, (match, offset: number) => {
    redactions.push({
      type: 'phone',
      start: offset,
      end: offset + match.length,
      replacement: '[PHONE]',
    });
    return '[PHONE]';
  });

  // 4. IP addresses
  result = result.replace(IP_PATTERN, (match, offset: number) => {
    redactions.push({
      type: 'ip',
      start: offset,
      end: offset + match.length,
      replacement: '[IP]',
    });
    return '[IP]';
  });

  // 5. Names (heuristic — last, since it's the least precise)
  for (const pattern of NAME_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, (fullMatch, name: string) => {
      redactions.push({
        type: 'name',
        start: 0, // Approximate — name patterns use groups
        end: 0,
        replacement: '[NAME]',
      });
      return fullMatch.replace(name, '[NAME]');
    });
  }

  return { sanitized: result, redactions };
}

// ── Classification ─────────────────────────────────────────────────────────────

/**
 * Classify a query by type using keyword/pattern heuristics.
 *
 * Categories:
 * - 'code': contains code fences, programming keywords, error traces
 * - 'reasoning': contains "why", "how does", "explain", "compare"
 * - 'creative': contains "write", "story", "poem", "create a"
 * - 'general': default for unclassified queries
 */
export function classifyQuery(text: string): QueryCategory {
  const lower = text.toLowerCase();

  // Code indicators (highest priority — most specific)
  if (
    text.includes('```') ||
    /\b(function|class|import|export|const|let|var|def |return )\b/.test(text) ||
    /\b(TypeError|SyntaxError|ReferenceError|Error:)\b/.test(text) ||
    /\b(fix|debug|refactor|compile|build)\b.*\b(code|error|bug|function|import|statement)\b/i.test(text)
  ) {
    return 'code';
  }

  // Reasoning indicators
  if (
    /\b(why|how does|explain|compare|difference between|what causes)\b/i.test(lower) ||
    /\bstep[\s-]by[\s-]step\b/i.test(lower)
  ) {
    return 'reasoning';
  }

  // Creative indicators
  if (
    /\b(write|compose|create)\b.*\b(poem|story|haiku|essay|song|lyric|script)\b/i.test(lower) ||
    /\b(write me|write a)\b/i.test(lower)
  ) {
    return 'creative';
  }

  return 'general';
}

// ── Combined Preprocessor ──────────────────────────────────────────────────────

/**
 * Preprocess a query: sanitize PII and classify.
 *
 * Returns a structured result with the sanitized text, classification,
 * original length, and count of redacted items.
 */
export function preprocessQuery(text: string): PreprocessedQuery {
  const { sanitized, redactions } = sanitizeQuery(text);
  const classification = classifyQuery(text); // Classify on original text

  return {
    sanitized,
    classification,
    originalLength: text.length,
    redactedCount: redactions.length,
  };
}

// ── Opt-in Check ───────────────────────────────────────────────────────────────

const PREPROCESSING_KEY = 'eco-query-preprocessing-enabled';

/**
 * Check if query preprocessing is enabled (user opt-in via settings).
 */
export function isQueryPreprocessingEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return safeStorage.get(PREPROCESSING_KEY) === 'true';
}

/**
 * Set the query preprocessing opt-in flag.
 */
export function setQueryPreprocessingEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  safeStorage.set(PREPROCESSING_KEY, String(enabled));
}
