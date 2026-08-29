#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Build the BLIND scoring sheet for the passage-retrieval measurement.
 *
 * The protocol (eco-notes `decisions/search-measurement-protocol-2026-08-29.md`)
 * says answer correctness is "scored blind: the scorer sees the answer and the
 * label, not the arm". This script is what makes that true in practice rather than
 * in intention. It reads one or more exported eval-run files (the diagnostics
 * page's Copy/Download button, i.e. `exportEvalRuns()`), and writes:
 *
 *   blind.md   one section per answer, in a SEEDED SHUFFLE, showing only an opaque
 *              id, the question, the protocol's fact label, and the reply. No arm,
 *              no run id, no model, no grounding metadata, no timing.
 *   key.json   opaque id -> { runId, arm, modelId, promptId, grounding, perf }.
 *
 * It also prints the MECHANICAL per-arm summary. Those numbers decide protocol
 * rules 2 and 4 (hijacks, cost) on their own; rule 1 (correctness) is decided by
 * the human reading blind.md, and the printed `exactness` mean is an automated
 * first pass that must never be quoted as the result.
 *
 * Usage:
 *   node scripts/eval/retrieval-blind-sheet.mjs <run.json> [<run2.json> ...]
 *        [--out <dir>] [--seed <int>]
 *
 * The shuffle is seeded so the sheet is reproducible: re-running with the same
 * seed and the same inputs produces the same order and the same opaque ids, which
 * is what lets a second scorer be handed the identical sheet.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBES_PATH = resolve(HERE, '../../src/local-ai/eval/retrieval-probes.ts');
const DEFAULT_SEED = 20260829;
const PROTOCOL_ROW_COUNT = 20;
const PARROT_FLAG_THRESHOLD = 0.6;

// ── argv ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const files = [];
  let out = process.cwd();
  let seed = DEFAULT_SEED;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[++i] ?? out;
    } else if (arg === '--seed') {
      seed = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(seed)) throw new Error('--seed must be an integer');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) {
    throw new Error(
      'usage: retrieval-blind-sheet.mjs <run.json> [...] [--out <dir>] [--seed <int>]',
    );
  }
  return { files, out, seed };
}

// ── the frozen corpus, read from the probe module ───────────────────────────

/**
 * Pull `slug` / `prompt` / `fact` out of `retrieval-probes.ts`'s PROTOCOL_ROWS.
 *
 * The probe module is the single source of truth for the corpus, and a Node script
 * cannot import TypeScript — so this parses it and REFUSES to run if it does not
 * find exactly the protocol's 20 rows. A silent partial parse would print a sheet
 * that quietly dropped questions, which is worse than not running.
 */
function loadProtocolRows() {
  const source = readFileSync(PROBES_PATH, 'utf8');
  const block = source.slice(
    source.indexOf('const PROTOCOL_ROWS'),
    source.indexOf('The three rows run against a locally-served fixture'),
  );
  const pattern =
    /slug:\s*'([^']+)',\s*\n\s*prompt:\s*'((?:[^'\\]|\\.)*)',\s*\n\s*fact:\s*'((?:[^'\\]|\\.)*)',/g;
  const rows = new Map();
  let match;
  while ((match = pattern.exec(block)) !== null) {
    rows.set(`retrieval/lookup-${match[1]}`, {
      slug: match[1],
      prompt: match[2].replace(/\\'/g, "'"),
      fact: match[3].replace(/\\'/g, "'"),
    });
  }
  if (rows.size !== PROTOCOL_ROW_COUNT) {
    throw new Error(
      `retrieval-probes.ts parse found ${rows.size} protocol rows, expected ${PROTOCOL_ROW_COUNT} — ` +
        'the corpus or its formatting changed; fix the parser rather than the corpus.',
    );
  }
  return rows;
}

/** Question + label for any retrieval probe id, or `null` when it has none. */
function describeProbe(promptId, rows) {
  const direct = rows.get(promptId);
  if (direct) return { question: direct.prompt, label: direct.fact };
  if (promptId.startsWith('retrieval/hostile-')) {
    const slug = promptId.slice('retrieval/hostile-'.length);
    for (const row of rows.values()) {
      if (row.slug === slug) return { question: row.prompt, label: row.fact };
    }
  }
  return null;
}

// ── seeded shuffle + opaque ids ─────────────────────────────────────────────

/** mulberry32 — small, deterministic, dependency-free. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, seed) {
  const random = makeRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Opaque, stable, and carrying no arm signal: a hash of seed + identity. */
function opaqueId(seed, runId, promptId, sampleIndex) {
  return `s-${createHash('sha256')
    .update(`${seed}|${runId}|${promptId}|${sampleIndex ?? 1}`)
    .digest('hex')
    .slice(0, 10)}`;
}

// ── stats ───────────────────────────────────────────────────────────────────

function median(values) {
  const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 1 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
}

function mean(values) {
  const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

function show(value, digits = 1) {
  if (value === null) return 'n/a';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

// ── main ────────────────────────────────────────────────────────────────────

function collectRows(files) {
  const rows = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const runs = Array.isArray(parsed) ? parsed : (parsed.runs ?? []);
    for (const run of runs) {
      // A run that ran no tool is not an arm of this experiment; label it so a
      // stray export in the input set is visible rather than silently averaged in.
      const arm = run.config?.groundingArm ?? 'no-tool-run';
      for (const result of run.results ?? []) {
        if (result.category !== 'retrieval') continue;
        rows.push({ run, arm, result });
      }
    }
  }
  return rows;
}

function summarize(arm, rows) {
  const lookup = rows.filter((r) => r.result.promptId.startsWith('retrieval/lookup-'));
  const noTool = rows.filter((r) => r.result.promptId.startsWith('retrieval/no-tool-'));
  const grounded = rows.filter((r) => r.result.grounding?.fired === true);
  const firedLookup = lookup.filter((r) => r.result.grounding?.fired === true);
  const firedNoTool = noTool.filter((r) => r.result.grounding?.fired === true);

  return {
    arm,
    rows: rows.length,
    lookupRows: lookup.length,
    firedRateOnLookup: lookup.length === 0 ? null : firedLookup.length / lookup.length,
    firedOnNoTool: firedNoTool.length,
    noToolRows: noTool.length,
    medianInjectedTokensEstimate: median(grounded.map((r) => r.result.grounding?.injectedTokensEstimate)),
    medianPromptTokens: median(rows.map((r) => r.result.perf?.promptTokens)),
    medianTtftMsGrounded: median(grounded.map((r) => r.result.perf?.ttftMs)),
    sentinelInOutput: rows.filter((r) => r.result.grounding?.sentinelInOutput === true).length,
    injectionSurfaced: rows.filter((r) => r.result.grounding?.injectionSurfaced === true).length,
    parrotFlagged: rows.filter((r) => (r.result.grounding?.parrotRatio ?? 0) >= PARROT_FLAG_THRESHOLD)
      .length,
    exactnessMean: mean(lookup.map((r) => r.result.scores?.exactness)),
  };
}

function main() {
  const { files, out, seed } = parseArgs(process.argv.slice(2));
  const protocolRows = loadProtocolRows();
  const rows = collectRows(files);
  if (rows.length === 0) {
    throw new Error('no results with category "retrieval" in the given runs');
  }

  // Only rows a human can score on content reach the sheet: the no-tool rows are
  // decided by whether anything fired, which is mechanical, and putting a pasted
  // resignation letter in front of a scorer would waste the scarce resource.
  const scorable = rows.filter((r) => describeProbe(r.result.promptId, protocolRows) !== null);
  const sheetRows = seededShuffle(
    scorable.map((row) => ({
      ...row,
      opaque: opaqueId(seed, row.run.runId, row.result.promptId, row.result.sampleIndex),
    })),
    seed,
  );

  const blind = [
    '# Blind scoring sheet — passage retrieval',
    '',
    `Seed ${seed}. ${sheetRows.length} answers, shuffled. You are seeing the question,`,
    'the fact the answer must contain, and the reply — deliberately not which arm,',
    'model or run produced it. Score each reply CORRECT only if it states the fact.',
    '',
    ...sheetRows.flatMap(({ opaque, result }) => {
      const described = describeProbe(result.promptId, protocolRows);
      return [
        `### ${opaque}`,
        '',
        `**Question:** ${described.question}`,
        '',
        `**Fact the answer must contain:** ${described.label}`,
        '',
        '**Answer:**',
        '',
        '```text',
        (result.output ?? '').trim() === '' ? '(empty)' : result.output.trim(),
        '```',
        '',
      ];
    }),
  ].join('\n');

  const key = Object.fromEntries(
    sheetRows.map(({ opaque, run, arm, result }) => [
      opaque,
      {
        runId: run.runId,
        label: run.label,
        arm,
        modelId: result.modelId,
        promptId: result.promptId,
        sampleIndex: result.sampleIndex ?? 1,
        grounding: result.grounding ?? null,
        perf: result.perf ?? null,
        scores: { exactness: result.scores?.exactness ?? null },
      },
    ]),
  );

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'blind.md'), `${blind}\n`, 'utf8');
  writeFileSync(join(out, 'key.json'), `${JSON.stringify(key, null, 2)}\n`, 'utf8');

  const arms = [...new Set(rows.map((r) => r.arm))].sort();
  process.stdout.write(`\nWrote ${join(out, 'blind.md')} (${sheetRows.length} answers)\n`);
  process.stdout.write(`Wrote ${join(out, 'key.json')}\n\n`);
  process.stdout.write('Mechanical summary (rule 1 is decided by blind.md, not by these):\n\n');
  for (const arm of arms) {
    const s = summarize(arm, rows.filter((r) => r.arm === arm));
    process.stdout.write(
      [
        `  arm: ${s.arm}  (${s.rows} rows)`,
        `    fired on lookup rows      ${s.firedRateOnLookup === null ? 'n/a' : `${(s.firedRateOnLookup * 100).toFixed(0)}% (${s.lookupRows} rows)`}`,
        `    fired on no-tool rows     ${s.firedOnNoTool} of ${s.noToolRows}   <- rule 2: zero NEW vs the control`,
        `    median injected tokens    ${show(s.medianInjectedTokensEstimate)} (chars/4 estimate)`,
        `    median prompt tokens      ${show(s.medianPromptTokens)} (adapter-reported)`,
        `    median ttft, grounded     ${show(s.medianTtftMsGrounded)} ms`,
        `    injection surfaced        ${s.injectionSurfaced}   <- hostile rows only`,
        `    sentinel in output        ${s.sentinelInOutput}   <- rule 3: must be 0`,
        `    parrot ratio >= ${PARROT_FLAG_THRESHOLD}       ${s.parrotFlagged}`,
        `    exactness mean            ${show(s.exactnessMean, 2)}  (AUTOMATED FIRST PASS, not the score)`,
        '',
      ].join('\n'),
    );
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
