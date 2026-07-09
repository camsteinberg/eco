#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Invariant 12 (build-output variant) — assert apps/web/src/lab/ files
 * do not appear in any production chunk after `next build`.
 *
 * Complements the static source-grep test in
 * apps/web/src/local-ai/__tests__/invariants.test.ts. The source grep
 * proves no file imports from lab/ at the TypeScript level. This
 * script proves the bundler honored that — defense in depth against
 * a future transformer that could pull lab/ in via some metadata path.
 *
 * Usage (from apps/web/):
 *   pnpm build && pnpm verify:no-lab-bundle
 *
 * Exits 0 when no lab/ references are found in any chunk or its
 * source map. Exits 1 with a list of offending files otherwise.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB_ROOT = join(import.meta.dirname, '..');
const NEXT_DIR = join(WEB_ROOT, '.next');
const CHUNKS_DIR = join(NEXT_DIR, 'static', 'chunks');

// Lab file paths we look for. The source-grep test already enforces that
// no TypeScript file outside lab/ imports from it, so any match here
// indicates either a build transform leak or a test artifact.
const LAB_PATH_PATTERNS = [
  'apps/web/src/lab/',
  'apps\\\\web\\\\src\\\\lab\\\\', // Windows path escape edge case
  '/src/lab/',
  '/lab/candidates',
];

/**
 * Recursively yield every `.js` and `.js.map` file in `dir`.
 */
function* walkBundle(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walkBundle(full);
      continue;
    }
    if (entry.endsWith('.js') || entry.endsWith('.js.map') || entry.endsWith('.mjs')) {
      yield full;
    }
  }
}

function main() {
  // If there's no .next build, fail fast with a clear message rather than
  // silently passing — the script should never be misread as "we built and
  // checked" when in fact we never built.
  try {
    statSync(CHUNKS_DIR);
  } catch {
    console.error(
      `[verify-no-lab-bundled] No build output at ${CHUNKS_DIR}. `
      + 'Run `pnpm --filter @eco/web build` first.',
    );
    process.exit(2);
  }

  const offenders = [];
  let scanned = 0;
  for (const file of walkBundle(CHUNKS_DIR)) {
    scanned++;
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const hits = [];
    for (const pattern of LAB_PATH_PATTERNS) {
      if (content.includes(pattern)) hits.push(pattern);
    }
    if (hits.length > 0) {
      offenders.push({ file: file.replace(WEB_ROOT, ''), patterns: hits });
    }
  }

  if (scanned === 0) {
    console.error(`[verify-no-lab-bundled] Walked ${CHUNKS_DIR} but found 0 chunks — unexpected.`);
    process.exit(2);
  }

  if (offenders.length > 0) {
    console.error(
      `[verify-no-lab-bundled] FAIL — apps/web/src/lab/ references found in ${offenders.length} chunk(s):`,
    );
    for (const o of offenders) {
      console.error(`  - ${o.file}  (matched: ${o.patterns.join(', ')})`);
    }
    process.exit(1);
  }

  console.log(
    `[verify-no-lab-bundled] OK — scanned ${scanned} chunk(s) under .next/static/chunks/. `
    + 'No lab/ references found.',
  );
  process.exit(0);
}

main();
