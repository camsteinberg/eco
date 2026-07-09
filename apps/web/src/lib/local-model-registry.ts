// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Local model registry — v1 catalog adapter for the proxy infrastructure.
 *
 * Sources from the v1 catalog (local-ai/catalog/catalog.ts) and
 * artifact-metadata.json. Consumers are the proxy route
 * (app/api/local-models/[...slug]/route.ts) and the manifest route
 * (app/api/local-models/manifest/[...modelId]/route.ts).
 */

import { getCatalog } from "../local-ai/catalog/catalog";
import type { ModelConfig } from "../local-ai/types";
import rawArtifactMetadata from "../local-ai/catalog/artifact-metadata.json";
import {
  EVAL_CANDIDATE_ARTIFACT_METADATA,
  getEvalCandidateModels,
} from "../local-ai/eval/eval-candidates";

type ArtifactFileMetadataEntry = { sizeBytes: number; oid: string };

const artifactMetadata = rawArtifactMetadata as Record<
  string,
  Record<string, ArtifactFileMetadataEntry> | undefined
>;

// ─── Public types (consumed by proxy route) ─────────────────────────────

export type LocalModelRegistryArtifact = {
  hfId: string;
  revision: string;
  files: string[];
  fileMetadata?: Partial<Record<string, ArtifactFileMetadataEntry>>;
  format: string;
  quantization?: string;
  expectedBytes: number;
};

export type LocalModelRegistryEntry = {
  modelId: string;
  displayName: string;
  artifact: LocalModelRegistryArtifact | null;
};

// ─── Internal helpers ────────────────────────────────────────────────────

function sumFileMetadataBytes(
  metadata: Record<string, ArtifactFileMetadataEntry> | undefined,
): number {
  if (!metadata) return 0;
  return Object.values(metadata).reduce(
    (total, entry) => total + (entry?.sizeBytes ?? 0),
    0,
  );
}

function buildArtifact(
  model: ModelConfig,
  metadata: Record<string, ArtifactFileMetadataEntry> | undefined,
): LocalModelRegistryArtifact | null {
  const artifact = model.artifact;
  if (!artifact) return null;

  return {
    hfId: artifact.hfId,
    revision: artifact.revision,
    files: [...artifact.files],
    fileMetadata: metadata,
    format: model.format,
    quantization: model.format.replace(/^(onnx|mlc)-/, ""),
    expectedBytes:
      sumFileMetadataBytes(metadata) || Math.round(model.sizeGB * 1_073_741_824),
  };
}

function buildRegistryEntry(model: ModelConfig): LocalModelRegistryEntry {
  return {
    modelId: model.id,
    displayName: model.friendlyName,
    artifact: buildArtifact(model, artifactMetadata[model.id]),
  };
}

// ─── Cached entries ──────────────────────────────────────────────────────

let _entries: LocalModelRegistryEntry[] | null = null;

function getEntries(): LocalModelRegistryEntry[] {
  if (!_entries) {
    _entries = getCatalog().map(buildRegistryEntry);
  }
  return _entries;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Return the full set of registry entries (one per v1 catalog model).
 */
export function getLocalModelRegistryEntries(): LocalModelRegistryEntry[] {
  return getEntries();
}

/**
 * Look up a single registry entry by model id.
 */
export function getLocalModelRegistryEntry(
  modelId: string,
): LocalModelRegistryEntry | undefined {
  return getEntries().find((entry) => entry.modelId === modelId);
}

/**
 * Return the artifact block for a given model, or null.
 */
export function getLocalModelRegistryArtifact(
  modelId: string,
): LocalModelRegistryArtifact | null {
  return getLocalModelRegistryEntry(modelId)?.artifact ?? null;
}

/**
 * Artifacts allowed through the same-origin proxy for normal user downloads.
 * In v1 every catalog model with an artifact is proxy-allowed.
 */
export function getProxyAllowedLocalModelRegistryArtifacts(): LocalModelRegistryArtifact[] {
  return getEntries().flatMap((entry) =>
    entry.artifact ? [entry.artifact] : [],
  );
}

/**
 * Artifacts allowed through the same-origin proxy for validation-harness
 * requests. This is a strict SUPERSET of the proxy-allowed set:
 *   proxy-allowed (the shipping catalog models) ∪ the eval-lane candidates
 *   (local-ai/eval/eval-candidates.ts).
 *
 * The proxy only consults this set when `isValidationHarnessRequestAllowed`
 * (an environment gate: loopback host + non-production) is true, so the eval
 * candidates are downloadable on localhost dev and 403 in production. They are
 * intentionally NOT in the shipping catalog, the ModelSelector, or the
 * recommendation engine — only this dev-only harness path can reach them.
 */
export function getValidationAllowedLocalModelRegistryArtifacts(): LocalModelRegistryArtifact[] {
  const candidateArtifacts = getEvalCandidateModels().flatMap((model) => {
    const artifact = buildArtifact(
      model,
      EVAL_CANDIDATE_ARTIFACT_METADATA[model.id],
    );
    return artifact ? [artifact] : [];
  });
  return [...getProxyAllowedLocalModelRegistryArtifacts(), ...candidateArtifacts];
}
