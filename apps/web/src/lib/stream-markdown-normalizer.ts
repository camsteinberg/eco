// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Host-side, model-independent markdown normalizer.
 *
 * Small on-device models (1–2B) emit a recurring set of formatting artifacts —
 * glued heading hashes (`#Heading`), glued list markers (`-item` / `1.item`),
 * pipe tables missing their separator row, doubled spaces, and stray spaces
 * before punctuation. None of that is the model's fault to fix at inference time;
 * it is deterministic to repair on the host. This module makes "formatting
 * determinism" real: every artifact that can be fixed without guessing is fixed
 * here, identically during streaming display and on the final persisted text.
 *
 * Design contract:
 * - PURE. No I/O, no globals. `(text, opts) -> text`.
 * - IDEMPOTENT. `normalize(normalize(x)) === normalize(x)` for all inputs — every
 *   rule is a fixpoint by construction (a normalized line never re-matches).
 * - CONSERVATIVE. Every rule must be provably safe; we prefer leaving text
 *   untouched over a risky transform. Fenced code, inline code, and KaTeX math
 *   are opaque and NEVER modified.
 * - STREAM-SAFE. With `complete: false` the trailing (still-arriving) line is
 *   passed through verbatim, and table-separator insertion only fires once two
 *   COMPLETE pipe rows exist — so already-displayed content never flickers.
 *
 * This module is intentionally decoupled from the chat pipeline. It runs ON
 * READ only — the renderer (live and final), copy, export and share — never on
 * the stored body. The stored assistant text is the model's raw output because
 * the next turn's prompt re-renders it and must match the worker's KV cache
 * token for token; a stored rewrite (the old finalize path) cost the 2.6B a
 * full re-prefill on every reply with a list. `<think>` handling stays with the
 * call sites: the display path receives think-stripped text (MessageBubble
 * extracts `<think>…</think>` before the renderer).
 */

export type NormalizeOptions = {
  /**
   * Whether the message has fully arrived. When `false` (streaming), the trailing
   * unterminated line is left untouched and table inference stays conservative.
   */
  complete: boolean;
};

/** A fence delimiter line: 3+ backticks or 3+ tildes at line start (indent allowed). */
const FENCE_DELIMITER = /^\s*(?:`{3,}|~{3,})/;

/**
 * Count of `$$` display-math delimiters on a line. A line containing an ODD
 * number toggles a multi-line display-math region (everything between an opening
 * `$$` line and its closer is opaque), mirroring fence tracking. Lines with an
 * even count (a self-contained `$$…$$`) are handled inline and don't toggle.
 */
function countDisplayMathDelimiters(line: string): number {
  return (line.match(/\$\$/g) ?? []).length;
}

/** Glued heading: 1–6 hashes at line start immediately followed by a non-space, non-`#` char. */
const GLUED_HEADING = /^(#{1,6})([^#\s].*)$/;

/** A standalone CSS hex color line (`#fff`, `#2d5a3d`) — must stay literal, not become a heading. */
const HEX_COLOR_ONLY = /^#[0-9a-fA-F]{3,8}$/;

/** Glued dash bullet: leading indent, a single `-`, then a non-space, non-`-` char. */
const GLUED_DASH_BULLET = /^(\s*)-([^\s-].*)$/;

/**
 * Glued ordered marker: leading indent, 1–9 digits, a dot, then a non-space,
 * non-digit char. The non-digit requirement is what keeps decimals (`3.14`,
 * `1.5 hours`) from being mistaken for list markers.
 */
const GLUED_ORDERED_MARKER = /^(\s*)(\d{1,9})\.([^\s\d].*)$/;

/**
 * A GFM table separator row: cells of dashes with optional alignment colons.
 * A single dash cell (`| --- |`) must match too — this regex is only ever
 * consulted on lines inside a pipe-table run (see `insertTableSeparators`),
 * where an all-dash line is unambiguously the separator; requiring two cells
 * here made single-column tables grow a duplicate separator per pass.
 */
const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Two+ spaces strictly between non-space chars → never leading indent or trailing hard-break. */
const INTERNAL_DOUBLE_SPACE = /(?<=\S) {2,}(?=\S)/g;

/**
 * A space (run) before sentence punctuation that is itself followed by whitespace
 * or end-of-line. The leading class excludes digits so decimals/number groupings
 * (`5 . 0`, `1 ,000`) are left alone, and the post-punctuation lookahead leaves
 * ellipses (`word ...`) intact.
 */
const SPACE_BEFORE_PUNCT = /([^\s\d]) +([,.;:!?])(?=\s|$)/g;

/**
 * Split a single line into [text, opaque, text, opaque, …] runs, where opaque runs
 * are inline code spans (`` `…` ``) and inline/display math (`$…$`, `$$…$$`).
 * Only text runs receive intra-line transforms; opaque runs pass through verbatim.
 *
 * Matching is deliberately simple and conservative: a backtick run opens a span
 * that closes on the next run of the SAME length; `$`/`$$` open a span that closes
 * on the next matching delimiter. An unterminated opener degrades to plain text,
 * which is safe (we just don't transform the remainder — we never corrupt it).
 */
function transformOutsideInlineSpans(line: string, transform: (text: string) => string): string {
  let out = "";
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i]!;

    if (ch === "`") {
      // Measure the opening backtick run.
      let j = i;
      while (j < n && line[j] === "`") j++;
      const ticks = line.slice(i, j);
      // Find a closing run of exactly the same length.
      const closeIdx = line.indexOf(ticks, j);
      if (closeIdx !== -1) {
        out += line.slice(i, closeIdx + ticks.length);
        i = closeIdx + ticks.length;
        continue;
      }
      // No closer on this line — treat the backtick run as plain text and keep going.
      out += ticks;
      i = j;
      continue;
    }

    if (ch === "$") {
      const isDisplay = line[i + 1] === "$";
      const delim = isDisplay ? "$$" : "$";
      const closeIdx = line.indexOf(delim, i + delim.length);
      if (closeIdx !== -1) {
        out += line.slice(i, closeIdx + delim.length);
        i = closeIdx + delim.length;
        continue;
      }
      // Unterminated math delimiter — emit it literally and continue scanning.
      out += delim;
      i += delim.length;
      continue;
    }

    // Accumulate a run of plain text up to the next span opener, then transform it.
    let j = i;
    while (j < n && line[j] !== "`" && line[j] !== "$") j++;
    out += transform(line.slice(i, j));
    i = j;
  }

  return out;
}

/** Apply the intra-line spacing fixes (collapse + punctuation) to a text run. */
function fixSpacing(text: string): string {
  return text
    .replace(INTERNAL_DOUBLE_SPACE, " ")
    .replace(SPACE_BEFORE_PUNCT, "$1$2");
}

/** Apply the line-anchored block fixes (heading + list markers) to a live line. */
function fixLineStructure(line: string): string {
  // Heading: `#Heading` → `# Heading`, but never a standalone CSS hex color.
  const heading = GLUED_HEADING.exec(line);
  if (heading) {
    const body = heading[2]!;
    if (!HEX_COLOR_ONLY.test(line)) {
      return `${heading[1]!} ${body}`;
    }
  }

  // Unordered bullet: `-item` → `- item` (dash only; `*`/`+` left alone — see module doc).
  const dash = GLUED_DASH_BULLET.exec(line);
  if (dash) {
    return `${dash[1]!}- ${dash[2]!}`;
  }

  // Ordered marker: `1.item` → `1. item` (non-digit after the dot guards decimals).
  const ordered = GLUED_ORDERED_MARKER.exec(line);
  if (ordered) {
    return `${ordered[1]!}${ordered[2]!}. ${ordered[3]!}`;
  }

  return line;
}

/** Heuristic: does a line look like a GFM table row? (leading+trailing pipe, or ≥2 pipes) */
function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1) {
    return true;
  }
  const pipes = (trimmed.match(/\|/g) ?? []).length;
  return pipes >= 2;
}

/** Build a separator row matching the header's column count, mirroring its pipe style. */
function buildSeparator(headerLine: string): string {
  const trimmed = headerLine.trim();
  const bounded = trimmed.startsWith("|");
  // Drop the empty boundary cells produced by leading/trailing pipes, count real cells.
  const cells = trimmed.split("|").filter((_, idx, arr) => {
    if (bounded && (idx === 0 || idx === arr.length - 1)) return false;
    return true;
  });
  const columnCount = Math.max(cells.length, 1);
  const dashes = Array.from({ length: columnCount }, () => "---");
  return bounded ? `| ${dashes.join(" | ")} |` : dashes.join(" | ");
}

/**
 * Second pass: insert a missing separator row after the first row of any run of
 * ≥2 consecutive table-row lines that has no separator. `opaqueState[i]` marks
 * lines inside a fence or math block (never table material). Operates on already
 * line-fixed text.
 */
function insertTableSeparators(lines: string[], opaqueState: boolean[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (opaqueState[i] || !looksLikeTableRow(line)) {
      out.push(line);
      i++;
      continue;
    }

    // Gather the maximal run of consecutive, non-opaque table rows.
    let end = i;
    while (
      end < lines.length &&
      !opaqueState[end] &&
      looksLikeTableRow(lines[end]!)
    ) {
      end++;
    }
    const run = lines.slice(i, end);
    const hasSeparator = run.some((l) => TABLE_SEPARATOR_ROW.test(l));

    if (run.length >= 2 && !hasSeparator) {
      out.push(run[0]!, buildSeparator(run[0]!), ...run.slice(1));
    } else {
      out.push(...run);
    }
    i = end;
  }

  return out;
}

/**
 * Normalize assistant markdown body text.
 *
 * @param text The body to normalize. Display callers pass think-stripped text;
 *   the finalize caller passes the full stored body (see module doc for the
 *   `ThinkTagFilter` dependency that makes that safe).
 * @param opts `complete: false` while streaming (trailing line preserved verbatim).
 */
export function normalizeStreamMarkdown(text: string, opts: NormalizeOptions): string {
  if (text.length === 0) return text;

  const lines = text.split("\n");

  // While streaming, the final element is the still-arriving tail line (when the
  // buffer does not end in "\n"). Peel it off and re-attach verbatim afterward.
  // When the buffer ends in "\n", split() yields a trailing "" element — that
  // empty tail is safe to "process" (it normalizes to itself) so completed table
  // rows above it are still considered.
  let tail: string | null = null;
  if (!opts.complete && lines.length > 0) {
    tail = lines.pop() ?? null;
  }

  // First pass: per-line structure + spacing fixes, tracking opaque regions
  // (fenced code blocks AND multi-line `$$` display-math blocks) so nothing
  // inside them is ever touched. `opaqueState[i]` also gates table inference.
  const opaqueState: boolean[] = [];
  let fenceOpen = false;
  let mathOpen = false;
  const fixed = lines.map((line) => {
    // Inside an open code fence, only the closing fence delimiter ends it; a
    // stray `$$` in code never opens math.
    //
    // DELIBERATE SIMPLIFICATION: any 3+ backtick-or-tilde run counts as the
    // closer. CommonMark is stricter (same delimiter char as the opener, at
    // least as long, no trailing info text). Worst case under this relaxation:
    // rare mixed/nested fences (e.g. a ~~~ line inside an open ``` block) end
    // the opaque region early, so a heading-looking line that was meant to stay
    // inside code could get normalized. Accepted — the strict-tracking cost
    // isn't worth it for chat output, and the failure mode is cosmetic.
    if (fenceOpen) {
      const closing = FENCE_DELIMITER.test(line);
      opaqueState.push(true);
      if (closing) fenceOpen = false;
      return line;
    }
    // Inside an open display-math block, only a `$$` delimiter line ends it.
    if (mathOpen) {
      opaqueState.push(true);
      if (countDisplayMathDelimiters(line) % 2 === 1) mathOpen = false;
      return line;
    }
    // A fence opener takes precedence and starts a code region.
    if (FENCE_DELIMITER.test(line)) {
      opaqueState.push(true);
      fenceOpen = true;
      return line;
    }
    // An odd number of `$$` on this line opens a multi-line display-math block.
    if (countDisplayMathDelimiters(line) % 2 === 1) {
      opaqueState.push(true);
      mathOpen = true;
      return line;
    }
    opaqueState.push(false);
    const structured = fixLineStructure(line);
    return transformOutsideInlineSpans(structured, fixSpacing);
  });

  // Second pass: table separators (only over non-opaque runs).
  const withTables = insertTableSeparators(fixed, opaqueState);

  let result = withTables.join("\n");
  if (tail !== null) {
    // Re-attach the untouched streaming tail. When no completed lines preceded it
    // (single still-arriving line), the tail IS the whole result — no leading "\n".
    result = withTables.length > 0 ? `${result}\n${tail}` : tail;
  }
  return result;
}
