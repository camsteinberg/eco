// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Stage-1 retrieval GATE benchmark (headless Node, NOT wired into pnpm qa/test).
 *
 * Decides one thing: does an embeddings (MiniLM cosine) retriever rank the right
 * document ENOUGH better than the shipped LEXICAL keyword/coverage gate to justify
 * building a retrieval lever? Objective ranking evidence only — it cannot judge
 * answer quality.
 *
 * Run:  node apps/web/scripts/retrieval-stage1-bench.mjs
 *   (from anywhere; ESM resolves @huggingface/transformers via apps/web).
 *
 * First run downloads ~90MB (Xenova/all-MiniLM-L6-v2) to the transformers .cache;
 * reruns are fully offline. Embeddings run on the onnxruntime-node CPU EP.
 */

import { pipeline, env } from '@huggingface/transformers';
import { CORPUS, QUERIES } from '../src/local-ai/retrieval-bench/corpus.mjs';
import {
  indexCorpusLexical,
  lexicalRank,
  lexicalGate,
} from '../src/local-ai/retrieval-bench/lexical-ranker.mjs';
import { cosineRank, cosineGate } from '../src/local-ai/retrieval-bench/cosine-ranker.mjs';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
// A-priori gate threshold for the cosine arm (not tuned to the labels). MiniLM
// normalized cosine: ~0.5+ = closely related, ~0.3 = loosely related, <0.2 = off.
const COSINE_GATE_THRESHOLD = 0.35;
const COSINE_SWEEP = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55];

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function embedAll(extractor, texts) {
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  return out.tolist(); // number[][]
}

/** rank position (1-based) of the gold doc in a ranked list; Infinity if absent. */
function rankOf(ranked, docId) {
  const i = ranked.findIndex((r) => r.docId === docId);
  return i === -1 ? Infinity : i + 1;
}

/** gate precision/recall/F1 where positive = shouldGround. */
function gateStats(rows, fired) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  rows.forEach((q, i) => {
    const pos = q.shouldGround;
    const pred = fired[i];
    if (pos && pred) tp += 1;
    else if (!pos && pred) fp += 1;
    else if (pos && !pred) fn += 1;
    else tn += 1;
  });
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = (tp + tn) / rows.length;
  return { tp, fp, fn, tn, precision, recall, f1, accuracy };
}

async function main() {
  console.log('='.repeat(78));
  console.log('Stage-1 retrieval gate benchmark');
  console.log('='.repeat(78));
  console.log(`corpus: ${CORPUS.length} docs   queries: ${QUERIES.length}`);
  const longTail = QUERIES.filter((q) => q.shouldGround);
  const goldDocQueries = QUERIES.filter((q) => q.correctDocId !== null);
  console.log(`  should-retrieve (long-tail, shouldGround=true): ${longTail.length}`);
  console.log(`  queries with a gold doc (long-tail + common-knowledge): ${goldDocQueries.length}`);
  console.log(`  should-NOT-retrieve (shouldGround=false): ${QUERIES.length - longTail.length}`);

  // ── embeddings ────────────────────────────────────────────────────────────
  console.log(`\nloading ${MODEL_ID} (CPU EP)...  cache=${env.cacheDir}`);
  const t0 = Date.now();
  const extractor = await pipeline('feature-extraction', MODEL_ID);
  console.log(`pipeline ready in ${Date.now() - t0} ms`);

  const docTexts = CORPUS.map((d) => `${d.title}. ${d.text}`);
  const tE = Date.now();
  const docVecArrays = await embedAll(extractor, docTexts);
  const queryVecArrays = await embedAll(extractor, QUERIES.map((q) => q.text));
  console.log(
    `embedded ${CORPUS.length} docs + ${QUERIES.length} queries in ${Date.now() - tE} ms ` +
      `(dim=${docVecArrays[0].length})`,
  );

  const docVecs = CORPUS.map((d, i) => ({ docId: d.id, vec: docVecArrays[i] }));
  const lexIndex = indexCorpusLexical(CORPUS);

  // ── per-query ranking + gate ──────────────────────────────────────────────
  const rows = QUERIES.map((q, i) => {
    const lexRanked = lexicalRank(q.text, lexIndex);
    const cosRanked = cosineRank(queryVecArrays[i], docVecs);
    return {
      q,
      lexTop: lexRanked[0]?.docId ?? null,
      cosTop: cosRanked[0]?.docId ?? null,
      lexRankOfGold: q.correctDocId ? rankOf(lexRanked, q.correctDocId) : null,
      cosRankOfGold: q.correctDocId ? rankOf(cosRanked, q.correctDocId) : null,
      lexFired: lexicalGate(q.text),
      cosFired: cosineGate(cosRanked, COSINE_GATE_THRESHOLD),
      cosTopScore: cosRanked[0]?.score ?? 0,
    };
  });

  // ── ranking accuracy@1 ────────────────────────────────────────────────────
  const acc1 = (subset, arm) => {
    const rs = rows.filter((r) => subset(r.q));
    const hit = rs.filter((r) => (arm === 'lex' ? r.lexTop : r.cosTop) === r.q.correctDocId).length;
    return { hit, total: rs.length, acc: rs.length ? hit / rs.length : 0 };
  };
  const isLong = (q) => q.shouldGround;
  const hasGold = (q) => q.correctDocId !== null;

  const lexLong = acc1(isLong, 'lex');
  const cosLong = acc1(isLong, 'cos');
  const lexGold = acc1(hasGold, 'lex');
  const cosGold = acc1(hasGold, 'cos');

  // ── end-to-end overall accuracy@1 (gate + rank) ───────────────────────────
  const endToEnd = (arm) => {
    let correct = 0;
    for (const r of rows) {
      const fired = arm === 'lex' ? r.lexFired : r.cosFired;
      const top = arm === 'lex' ? r.lexTop : r.cosTop;
      if (r.q.shouldGround) {
        if (fired && top === r.q.correctDocId) correct += 1;
      } else if (!fired) {
        correct += 1;
      }
    }
    return { correct, total: rows.length, acc: correct / rows.length };
  };
  const lexE2E = endToEnd('lex');
  const cosE2E = endToEnd('cos');

  // ── gate precision/recall ─────────────────────────────────────────────────
  const lexGate = gateStats(QUERIES, rows.map((r) => r.lexFired));
  const cosGateStats = gateStats(QUERIES, rows.map((r) => r.cosFired));

  // ── long-tail per-query rank comparison ───────────────────────────────────
  console.log('\n' + '-'.repeat(78));
  console.log('LONG-TAIL per-query rank of the gold doc (1 = ranked #1; lower is better)');
  console.log('-'.repeat(78));
  console.log(`${pad('query id', 20)} ${padL('lexRank', 8)} ${padL('cosRank', 8)}  ${pad('cosTopSim', 10)} winner`);
  for (const r of rows.filter((x) => x.q.shouldGround)) {
    const lw = r.lexRankOfGold === 1;
    const cw = r.cosRankOfGold === 1;
    const winner = lw && cw ? 'both' : lw ? 'LEX' : cw ? 'COS' : (r.lexRankOfGold < r.cosRankOfGold ? 'lex>' : r.cosRankOfGold < r.lexRankOfGold ? 'cos>' : 'tie/none');
    console.log(
      `${pad(r.q.id, 20)} ${padL(r.lexRankOfGold === Infinity ? '-' : r.lexRankOfGold, 8)} ` +
        `${padL(r.cosRankOfGold === Infinity ? '-' : r.cosRankOfGold, 8)}  ${pad(r.cosTopScore.toFixed(3), 10)} ${winner}`,
    );
  }

  // ── headline comparison table ─────────────────────────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('COMPARISON  (LEXICAL = shipped keyword/coverage gate | COSINE = MiniLM)');
  console.log('='.repeat(78));
  const row = (label, l, c) => console.log(`${pad(label, 46)} ${padL(l, 14)} ${padL(c, 14)}`);
  row('metric', 'LEXICAL', 'COSINE');
  console.log('-'.repeat(78));
  row(`ranking acc@1 — long-tail (n=${lexLong.total})`, `${pct(lexLong.acc)} (${lexLong.hit})`, `${pct(cosLong.acc)} (${cosLong.hit})`);
  row(`ranking acc@1 — all gold-doc (n=${lexGold.total})`, `${pct(lexGold.acc)} (${lexGold.hit})`, `${pct(cosGold.acc)} (${cosGold.hit})`);
  row(`overall end-to-end acc@1 (n=${lexE2E.total})`, `${pct(lexE2E.acc)} (${lexE2E.correct})`, `${pct(cosE2E.acc)} (${cosE2E.correct})`);
  console.log('-'.repeat(78));
  console.log(`gate (positive = shouldGround; cosine threshold=${COSINE_GATE_THRESHOLD})`);
  row('gate precision', pct(lexGate.precision), pct(cosGateStats.precision));
  row('gate recall', pct(lexGate.recall), pct(cosGateStats.recall));
  row('gate F1', pct(lexGate.f1), pct(cosGateStats.f1));
  row('gate accuracy', pct(lexGate.accuracy), pct(cosGateStats.accuracy));
  row('gate TP/FP/FN/TN', `${lexGate.tp}/${lexGate.fp}/${lexGate.fn}/${lexGate.tn}`, `${cosGateStats.tp}/${cosGateStats.fp}/${cosGateStats.fn}/${cosGateStats.tn}`);

  // ── cosine gate threshold sweep (honesty: no label-tuning in the headline) ─
  console.log('\n' + '-'.repeat(78));
  console.log('COSINE gate threshold sweep (shows the gate is threshold-sensitive)');
  console.log('-'.repeat(78));
  console.log(`${pad('threshold', 12)} ${padL('precision', 11)} ${padL('recall', 9)} ${padL('F1', 8)} ${padL('acc', 8)}`);
  for (const th of COSINE_SWEEP) {
    const fired = rows.map((r) => cosineGate(cosineRank(queryVecArrays[QUERIES.indexOf(r.q)], docVecs), th));
    const s = gateStats(QUERIES, fired);
    console.log(`${pad(th.toFixed(2), 12)} ${padL(pct(s.precision), 11)} ${padL(pct(s.recall), 9)} ${padL(pct(s.f1), 8)} ${padL(pct(s.accuracy), 8)}`);
  }

  // ── where lexical FALSE-POSITIVE gates (fired on shouldGround=false) ───────
  console.log('\n' + '-'.repeat(78));
  console.log('Gate FALSE POSITIVES (fired although shouldGround=false)');
  console.log('-'.repeat(78));
  for (const r of rows.filter((x) => !x.q.shouldGround)) {
    const flags = [];
    if (r.lexFired) flags.push('LEX');
    if (r.cosFired) flags.push('COS');
    if (flags.length) console.log(`  ${pad(r.q.id, 20)} [${r.q.category}] fired: ${flags.join(', ')}`);
  }

  console.log('\nDONE');
}

main().catch((err) => {
  console.error('BENCH FAILED:', err);
  process.exit(1);
});
