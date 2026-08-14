// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * COSINE arm — pure ranking + gate over PRECOMPUTED embedding vectors. This
 * module never imports the model: the benchmark script owns the transformers.js
 * feature-extraction pipeline (CPU EP in Node), computes mean-pooled + normalized
 * MiniLM vectors once, and hands them here. Keeping the ranker pure means it has
 * no browser/node coupling and is trivially testable.
 *
 * Vectors are assumed L2-normalized (the pipeline is called with
 * `{ pooling: 'mean', normalize: true }`), so cosine similarity is a plain dot
 * product. We do NOT re-normalize — if a caller passes un-normalized vectors the
 * ranking order is still correct, only the gate threshold's meaning shifts.
 *
 * @typedef {{ docId: string, score: number }} RankedDoc
 */

/**
 * Cosine similarity of two equal-length numeric vectors (dot product for
 * normalized inputs).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

/**
 * Rank docs by cosine similarity to the query vector, best-first. Ties break on
 * docId for determinism.
 * @param {ArrayLike<number>} queryVec
 * @param {ReadonlyArray<{ docId: string, vec: ArrayLike<number> }>} docVecs
 * @returns {RankedDoc[]}
 */
export function cosineRank(queryVec, docVecs) {
  const scored = docVecs.map(({ docId, vec }) => ({ docId, score: cosine(queryVec, vec) }));
  scored.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
  return scored;
}

/**
 * Gate decision for the cosine arm: fire when the best doc's similarity clears a
 * threshold. This is deliberately the naive similarity gate — a bare threshold is
 * a poor task-type signal (it cannot tell "rewrite this" from a fact lookup), and
 * the report reads the gate comparison with that caveat. The threshold is a
 * parameter so the script can report a fixed a-priori value AND a sensitivity
 * sweep rather than silently tuning it to the labels.
 * @param {RankedDoc[]} ranked  Output of {@link cosineRank}.
 * @param {number} threshold
 * @returns {boolean}
 */
export function cosineGate(ranked, threshold) {
  return ranked.length > 0 && ranked[0].score >= threshold;
}
