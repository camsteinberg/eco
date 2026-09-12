// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Checked-in web snippets for the real-time probe set.
 *
 * WHY A FIXTURE. The real-time probes (`real-time-probes.ts`) measure what the
 * model does with a question it cannot answer from its weights. The next
 * question is what it does when the answer IS in front of it: does it read the
 * snippets and answer, does it still decline, does it blend the snippets with
 * an invention? Answering that needs the model to see live-looking text — but a
 * measurement whose input changes every time it runs measures nothing. So the
 * snippets are captured ONCE by hand, checked in here, and replayed byte for
 * byte on every run. This module makes NO network request, and neither does the
 * arm that uses it.
 *
 * WHAT IT IS NOT. The CAPTURE is an instrument, not a product path: nothing in
 * the shipped app reads `real-time-fixture.json`, which is imported only by the
 * harness and its tests. The NOTE BUILDER it used, on the other hand, is now the
 * shipped one — it lives in `lib/grounding/web-snippet-note.ts` and is re-exported
 * below, so the fixture arm and the real search path send the same prompt.
 */

import type { WebSnippet, WebSnippetEntry } from '../../lib/grounding/web-snippet-note';

import fixtureData from './real-time-fixture.json';

// The note builder and its shapes live in `lib/grounding/web-snippet-note` (the
// shipped web-search path builds its note with the same code, so the prompt is
// byte-identical to the measured one). Re-exported here so an arm that needs the
// capture and the builder keeps one import site.
export {
  NOTE_MAX_CHARS,
  SNIPPET_MAX_CHARS,
  buildWebSnippetNote,
} from '../../lib/grounding/web-snippet-note';
export type { WebSnippet, WebSnippetEntry } from '../../lib/grounding/web-snippet-note';

/** The whole checked-in capture: provenance plus one entry per probe id. */
export type RealTimeFixture = {
  /** When the capture pass ran, ISO 8601. */
  readonly capturedAt: string;
  /** Free text: where the snippets came from, and any caveat about them. */
  readonly source: string;
  readonly entries: Readonly<Record<string, WebSnippetEntry>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(what: string): never {
  throw new Error(`real-time-fixture.json: ${what}`);
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    bad(`\`${path}\` must be a non-empty string`);
  }
}

function assertSnippet(raw: unknown, path: string): asserts raw is WebSnippet {
  if (!isRecord(raw)) bad(`\`${path}\` must be an object`);
  assertNonEmptyString(raw.title, `${path}.title`);
  assertNonEmptyString(raw.snippet, `${path}.snippet`);
  assertNonEmptyString(raw.domain, `${path}.domain`);
  if (raw.published !== undefined) assertNonEmptyString(raw.published, `${path}.published`);
}

function assertEntry(raw: unknown, path: string): asserts raw is WebSnippetEntry {
  if (!isRecord(raw)) bad(`\`${path}\` must be an object`);
  assertNonEmptyString(raw.fetchedAt, `${path}.fetchedAt`);
  if (!Array.isArray(raw.results) || raw.results.length === 0) {
    bad(`\`${path}.results\` must be a non-empty array`);
  }
  raw.results.forEach((result, i) => {
    assertSnippet(result, `${path}.results[${String(i)}]`);
  });
}

/**
 * Validate the checked-in JSON at module load, the way the catalog does. A
 * malformed capture must fail loudly here rather than reach a model as a
 * half-built note and be read as a model result.
 */
function assertFixture(raw: unknown): asserts raw is RealTimeFixture {
  if (!isRecord(raw)) bad('must be an object');
  assertNonEmptyString(raw.capturedAt, 'capturedAt');
  assertNonEmptyString(raw.source, 'source');
  if (!isRecord(raw.entries)) bad('`entries` must be an object');
  for (const [id, entry] of Object.entries(raw.entries)) {
    assertEntry(entry, `entries["${id}"]`);
  }
}

assertFixture(fixtureData);

/** The checked-in capture, validated. */
export const REAL_TIME_FIXTURE: RealTimeFixture = fixtureData;

/**
 * The capture for one probe id, or `null` when the fixture has no entry for it.
 *
 * `null` is a caller's problem on purpose: a `fixture` run that silently fell
 * back to no snippets would record a row indistinguishable from a `none` row
 * and quietly corrupt the comparison. The harness turns `null` into a row
 * error instead.
 */
export function getFixtureEntry(promptId: string): WebSnippetEntry | null {
  return REAL_TIME_FIXTURE.entries[promptId] ?? null;
}

