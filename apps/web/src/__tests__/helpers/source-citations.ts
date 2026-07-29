// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Does a written explanation actually point at the code it describes?
 *
 * ★ WHY THIS EXISTS. Two suites pin their findings as named mechanisms with a
 * prose explanation each, and both guarded that prose with `length > 200`. A
 * character count wearing the name "explains" is satisfied by padding with
 * filler — it is the same defect those suites were built to catch, sitting in
 * their own instrument. This replaces it with something checkable: a mechanism
 * must cite at least one file or symbol that RESOLVES against the source tree,
 * and every FILE it names must exist.
 *
 * Second benefit, and the reason to prefer this over any prose heuristic: it
 * fails loudly when a mechanism goes stale. Rename `PLURALITY_RE` or delete
 * `answer-shape.ts` and every explanation still citing them breaks by name,
 * instead of quietly describing code that no longer exists.
 *
 * ★ WHAT IT DOES NOT MEASURE, stated plainly. The cheapest change that satisfies
 * this without helping a reader is to cite a real but IRRELEVANT file — append
 * "see chat-intent.ts" to any padding and it passes. That is accepted: it is a
 * large improvement over a character count, it cannot be satisfied by prose
 * alone, and a guard that tried to judge relevance would be a prose heuristic
 * again. Read this as "the explanation points at real code", never as "the
 * explanation is correct".
 *
 * RESOLUTION RULES, so they can be argued with:
 *   - A FILE reference is any `*.ts` / `*.tsx` token. It resolves when a file
 *     with that basename exists anywhere under `src/`. Files are the strict
 *     class: EVERY file named must resolve, because a filename is unambiguously
 *     a citation and a stale one is a defect.
 *   - A SYMBOL reference is a backticked identifier or a bare SCREAMING_SNAKE
 *     token. It resolves when the source tree DECLARES it — `const` / `let` /
 *     `var` / `function` / `class` / `type` / `interface` / `enum`.
 *   - Object properties and string literals deliberately do NOT count as
 *     declarations. Without that restriction `` `deep` `` and `` `explain` ``
 *     would resolve, because they appear as keys in the per-intent budget
 *     tables — and an intent VALUE is not a citation of a mechanism. Requiring a
 *     declaration is what keeps this from degenerating into "this word appears
 *     somewhere in the repo", which almost any English word does.
 *   - Symbols are the loose class: only ONE reference of any kind has to
 *     resolve. A backticked span is often an intent value or a quoted phrase
 *     rather than a symbol, so requiring all of them to resolve would fail every
 *     mechanism ever written.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * MODULE-SCOPE declarations only — anchored at column 0, no leading whitespace.
 *
 * ★ THIS ANCHORING IS LOAD-BEARING and was added after the first version of this
 * helper reported everything green for the wrong reason. Allowing indentation
 * matched LOCAL variables inside function bodies, and since the index covers the
 * whole tree that meant a `const deep = …` on line 136 of `chat-intent.test.ts`
 * made the bare word `deep` "resolve". Four mechanisms passed on nothing but
 * intent VALUES — `quick`, `explain`, `deep`, `shorter` — which is precisely the
 * degeneracy the rules above say must not count. A local in some other file is
 * not a citable symbol.
 */
const DECLARATION_RE =
  /(?:^|\n)(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;

const FILE_REFERENCE_RE = /\b[\w.-]+\.tsx?\b/g;
/** Backticked identifiers: `inferAnswerShape`, `PLURALITY_RE`. */
const BACKTICKED_RE = /`([A-Za-z_$][\w$]*)`/g;
/** Bare SCREAMING_SNAKE, which the prose often writes unquoted: LONG_ASK_MIN_CHARS. */
const SCREAMING_SNAKE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

type SourceIndex = {
  readonly basenames: ReadonlySet<string>;
  readonly declarations: ReadonlySet<string>;
};

let cachedIndex: SourceIndex | null = null;

/**
 * Collect production sources, skipping tests and fixtures.
 *
 * A mechanism describes a defect in the PRODUCT, so it must cite product code.
 * Indexing tests let a symbol resolve against a test's own local scaffolding —
 * see DECLARATION_RE — and would also let a mechanism cite a fixture that
 * exists only to describe the defect, which is circular.
 */
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__mocks__") {
        continue;
      }
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

/** Built once per process — the whole `src/` tree is ~5MB, read a single time. */
function sourceIndex(): SourceIndex {
  if (cachedIndex !== null) {
    return cachedIndex;
  }
  const files: string[] = [];
  walk(SRC_ROOT, files);
  const basenames = new Set<string>();
  const declarations = new Set<string>();
  for (const file of files) {
    basenames.add(path.basename(file));
    const contents = readFileSync(file, "utf8");
    for (const match of contents.matchAll(DECLARATION_RE)) {
      const name = match[1];
      if (name !== undefined) {
        declarations.add(name);
      }
    }
  }
  cachedIndex = { basenames, declarations };
  return cachedIndex;
}

export type CitationCheck = {
  /** Every reference that resolved, file or symbol. Empty ⇒ the prose cites nothing real. */
  readonly resolved: readonly string[];
  /** File references that do NOT exist — always a defect, however many others resolved. */
  readonly staleFiles: readonly string[];
};

/**
 * Resolve the code references in one block of prose.
 *
 * Pure apart from the memoized source read, so a caller can assert on both
 * fields and report precisely which citation went stale.
 */
export function checkSourceCitations(prose: string): CitationCheck {
  const { basenames, declarations } = sourceIndex();

  const fileRefs = [...new Set(prose.match(FILE_REFERENCE_RE) ?? [])];
  const symbolRefs = [
    ...new Set([
      ...[...prose.matchAll(BACKTICKED_RE)].map((m) => m[1] ?? ""),
      ...(prose.match(SCREAMING_SNAKE_RE) ?? []),
    ]),
  ].filter((name) => name !== "");

  const staleFiles = fileRefs.filter((ref) => !basenames.has(ref));
  const resolved = [
    ...fileRefs.filter((ref) => basenames.has(ref)),
    ...symbolRefs.filter((name) => declarations.has(name)),
  ];

  return { resolved, staleFiles };
}
