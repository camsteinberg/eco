// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eval-only candidate lane — a VIEW over the catalog, not a second catalog.
 *
 * These models used to be declared here, inline, in a file whose header opened
 * with "This model is NOT in the shipping v1.0 catalog (catalog-data.json)".
 * That WAS the second catalog: a model's whole description depended on which of
 * two files it happened to live in, and graduating one meant retyping it. Both
 * lanes now live in catalog-data.json and are told apart by exactly one field —
 * `shipping`. A graduation is a `false` → `true` flip plus the blocks a shipping
 * entry owes (generation, maxNewTokens, compat, display, tier, license), which
 * `assertCatalogEntry` demands at load.
 *
 * What "eval-only" buys, and what actually enforces it:
 *   - `getCatalog()` returns `shipping: true` entries and ONLY those, so these
 *     never reach the recommendation engine, the ModelSelector, or any other
 *     user-facing surface. `eval-candidates.test.ts` pins that with a zero-leak
 *     assertion over every lane id.
 *   - The same-origin proxy resolves a normal user download from the
 *     proxy-allowed (shipping) set. These live only in the validation-allowed
 *     superset, which the proxy consults solely when
 *     `isValidationHarnessRequestAllowed(headers)` is true — an environment gate
 *     (loopback host + non-production). So they download on localhost dev and
 *     403 in production.
 *   - `loadModel(model)` (runtime/lifecycle.ts) takes a ModelConfig directly and
 *     never re-resolves through `getCatalog()`, so the harness loads them fine.
 *     The eval harness resolves catalog ∪ eval-candidates by default; see
 *     `harness.defaultGetModel`.
 *
 * Per-entry provenance — why a candidate is in the lane and what it measured —
 * travels with the entry as `_laneNote` in catalog-data.json.
 *
 * `EVAL_CANDIDATE_ARTIFACT_METADATA` is verified against the pinned HuggingFace
 * revision: the proxy SHA-256-verifies any file whose reviewed `oid` is 64 chars
 * (LFS) against the downloaded bytes; 40-char oids are git-blob and pass through
 * unverified. It sits in its own JSON file so `artifact-metadata.json` stays 1:1
 * with the shipping catalog, an invariant catalog.test.ts pins.
 */

import { getEvalLaneModels } from '../catalog/catalog';
import type { ModelConfig } from '../types';
import evalArtifactMetadata from '../catalog/artifact-metadata-eval.json';

type ArtifactFileMetadataEntry = { sizeBytes: number; oid: string };

const MODELS: readonly ModelConfig[] = Object.freeze(getEvalLaneModels());

const MODELS_BY_ID: ReadonlyMap<string, ModelConfig> = new Map(
  MODELS.map((model) => [model.id, model]),
);

// ─── Per-file artifact metadata ────────────────────────────────────────────

export const EVAL_CANDIDATE_ARTIFACT_METADATA: Readonly<
  Record<string, Record<string, ArtifactFileMetadataEntry>>
> = Object.freeze(
  evalArtifactMetadata.models as Record<string, Record<string, ArtifactFileMetadataEntry>>,
);

// ─── Accessors ──────────────────────────────────────────────────────────────

/** Return the eval-only candidate models (NOT in the shipping catalog). */
export function getEvalCandidateModels(): ModelConfig[] {
  return [...MODELS];
}

/** Look up an eval candidate by id, or null if it is not a candidate. */
export function getEvalCandidateModel(id: string): ModelConfig | null {
  return MODELS_BY_ID.get(id) ?? null;
}
