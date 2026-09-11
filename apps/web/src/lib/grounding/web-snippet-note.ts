// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The fenced web-snippet note a set of search results is handed to the model as.
 *
 * MOVED, UNCHANGED, from `local-ai/eval/real-time-fixture.ts` (2026-09-11). It was
 * written for the checked-in fixture arm and is what the s46 measurement actually
 * sent; the shipped web-search path now builds its note with the SAME code, so the
 * prompt a person sees is byte-identical to the measured one. Nothing here may be
 * "improved" without re-running that measurement.
 *
 * Snippets are third-party text, so they are wrapped in the same reference-data
 * fence every other retrieved-text note uses (`./fence`), with the marker tokens
 * stripped from the untrusted spans first.
 */

import {
  FENCE_CLOSE,
  FENCE_OPEN,
  FENCE_PREAMBLE,
  neutralizeFenceMarkers,
} from './fence';

/** One captured search result. `published` is absent when the source showed no date. */
export type WebSnippet = {
  readonly title: string;
  readonly snippet: string;
  readonly domain: string;
  readonly published?: string;
};

/** Every snippet captured for one probe id, with when they were captured. */
export type WebSnippetEntry = {
  readonly fetchedAt: string;
  readonly results: readonly WebSnippet[];
};

/**
 * Per-snippet character cap. 220 keeps a result line close to what a search
 * engine actually shows and keeps the whole note inside {@link NOTE_MAX_CHARS}
 * for a typical two-to-four-result entry.
 */
export const SNIPPET_MAX_CHARS = 220;

/**
 * Hard cap on the assembled note: ~1,400 chars ≈ 350 tokens at the harness-wide
 * chars/4 estimate. The note rides on top of the system prompt on a 2k–8k
 * context model, so an unbounded note would evict the conversation it is meant
 * to inform. The fence scaffolding is never dropped to meet the cap — snippets
 * shrink first, then trailing results fall away, and at least one result line
 * always survives.
 */
export const NOTE_MAX_CHARS = 1400;

/** Floor for the shrinking per-snippet cap; below this a snippet says nothing. */
const SNIPPET_MIN_CHARS = 40;

/** Marker appended to a snippet the cap cut short. */
const ELLIPSIS = '…';

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(1, max - 1)).trimEnd()}${ELLIPSIS}`;
}

/**
 * One numbered result line. The whole line is neutralized as a single span
 * AFTER truncation (the same ordering `buildFoundNote` uses in the Wikipedia
 * tool): neutralizing before truncation would let a cut land mid-replacement,
 * and neutralizing the assembled note would strip the genuine fence markers.
 */
function resultLine(index: number, snippet: WebSnippet, snippetMax: number): string {
  const tail = snippet.published !== undefined
    ? `(${snippet.domain}, ${snippet.published})`
    : `(${snippet.domain})`;
  const line = `${String(index + 1)}. ${truncate(snippet.title, SNIPPET_MAX_CHARS)} — ${truncate(snippet.snippet, snippetMax)} ${tail}`;
  return neutralizeFenceMarkers(line);
}

/**
 * The instruction closing the note. Deliberately NOT the fence module's own
 * `FENCE_ANSWER_INSTRUCTION`: that one tells the model to fall back on its own knowledge when the source
 * misses the answer, which is exactly the behaviour this measurement is trying
 * to observe rather than instruct. Here the honest fallback is to say so.
 * (Its no-URLs / no-source-mentions clause is kept, for the same reason it
 * exists there: a small model invents broken links once it starts citing.)
 */
const ANSWER_INSTRUCTION =
  'Answer from the sources above. If they do not contain the answer, say so plainly. ' +
  'Write plain prose with no source mentions and no URLs.';

function composeNote(fetchedLine: string, lines: string[]): string {
  return [FENCE_PREAMBLE, FENCE_OPEN, fetchedLine, ...lines, FENCE_CLOSE, ANSWER_INSTRUCTION].join(
    '\n',
  );
}

/**
 * Build the fenced web-snippet note for one probe's capture.
 *
 * `fetchedAt` is printed VERBATIM, as the ISO string the capture recorded. A
 * local-time rendering would depend on the machine's zone, and two runs of the
 * same fixture on two machines would then send two different prompts — which is
 * the one thing a fixture exists to prevent.
 */
export function buildWebSnippetNote(entry: WebSnippetEntry): string {
  const fetchedLine = neutralizeFenceMarkers(
    `[Source: web search, fetched ${entry.fetchedAt}]`,
  );

  // Shrink snippets first, then drop trailing results, never the fence. One
  // result line always survives: a fenced note with no data would measure
  // nothing while still looking like a grounded run.
  for (let count = entry.results.length; count >= 1; count--) {
    const kept = entry.results.slice(0, count);
    for (let max = SNIPPET_MAX_CHARS; max >= SNIPPET_MIN_CHARS; max -= 20) {
      const note = composeNote(
        fetchedLine,
        kept.map((snippet, i) => resultLine(i, snippet, max)),
      );
      if (note.length <= NOTE_MAX_CHARS) return note;
    }
  }

  // Single result, already at the floor, still over the cap (a pathological
  // title or domain): send it anyway rather than a fence around nothing. The
  // note stays well inside any model's context; the cap is a budget, not a
  // correctness bound.
  return composeNote(fetchedLine, [resultLine(0, entry.results[0]!, SNIPPET_MIN_CHARS)]);
}
