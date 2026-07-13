// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { getCatalog } from "../../catalog/catalog";
import { getGenerationProfile } from "../../../lib/chat-intent";
import {
  EVAL_CANDIDATE_ARTIFACT_METADATA,
  getEvalCandidateModel,
  getEvalCandidateModels,
} from "../eval-candidates";

// Deliberately absent (graduated into the shipping catalog — catalog tests cover
// them now): Qwen3.5-2B (chat #7 bake-off winner, 2026-06-11) and
// gemma-4-e2b-litert (f16-less C2/C3 answer, model-offering overhaul 2026-06-29).
const CANDIDATE_IDS = [
  "candidate/qwen3-1.7b-onnx",
  "candidate/lfm2-2.6b-onnx",
  "candidate/qwen3.5-4b-onnx",
  "candidate/gemma-4-e2b-onnx",
  "candidate/gemma-4-e2b-qat-q4-onnx",
  "candidate/gemma-4-e4b-litert",
] as const;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

describe("eval-candidate lane (Phase 2 + chat #7 bake-off)", () => {
  it("exposes exactly the lane candidates (including eval-only Gemma 4 E4B LiteRT)", () => {
    expect(getEvalCandidateModels().map((m) => m.id).sort()).toEqual(
      [...CANDIDATE_IDS].sort(),
    );
  });

  it("the graduated Qwen3.5-2B is no longer a lane candidate (single source of truth)", () => {
    expect(getEvalCandidateModel("candidate/qwen3.5-2b-onnx")).toBeNull();
    expect(EVAL_CANDIDATE_ARTIFACT_METADATA["candidate/qwen3.5-2b-onnx"]).toBeUndefined();
  });

  it.each(CANDIDATE_IDS)("%s carries a valid pinned artifact", (id) => {
    const model = getEvalCandidateModel(id);
    expect(model).not.toBeNull();
    const artifact = model!.artifact;
    expect(artifact).toBeDefined();
    expect(artifact!.revision).toMatch(SHA1);
    expect(artifact!.files.length).toBeGreaterThan(0);
  });

  it.each(CANDIDATE_IDS)("%s metadata covers exactly its artifact files", (id) => {
    const model = getEvalCandidateModel(id)!;
    const metadata = EVAL_CANDIDATE_ARTIFACT_METADATA[id];
    expect(metadata).toBeDefined();

    const files = [...model.artifact!.files];
    // Every artifact file has a valid metadata entry.
    for (const file of files) {
      const meta = metadata![file];
      expect(meta, `${id} missing metadata for ${file}`).toBeDefined();
      expect(meta!.sizeBytes).toBeGreaterThan(0);
      expect(SHA1.test(meta!.oid) || SHA256.test(meta!.oid)).toBe(true);
    }
    // No EXTRA metadata keys beyond the artifact file list.
    expect(Object.keys(metadata!).sort()).toEqual(files.sort());
  });

  it.each(CANDIDATE_IDS)("%s is a predicted-tier candidate", (id) => {
    expect(getEvalCandidateModel(id)!.evidenceTier).toBe("predicted");
  });

  it.each(CANDIDATE_IDS)(
    "%s resolves a model-specific generation profile (id-keyed or family wiring)",
    (id) => {
      // A resolved profile (id-keyed PROFILE_BY_MODEL_ID entry or recognized
      // family) means chat-intent + the generation profile lookup return
      // model-specific sampling, not the baseline fallback (topP 0.9 /
      // repetitionPenalty 1.06 with no topK). Asserting a topK proves the
      // candidate resolved a real profile.
      const profile = getGenerationProfile("quick", true, id, {
        allowValidationModel: true,
      });
      expect(profile.topK).toBeGreaterThan(0);
    },
  );

  it("returns the model for a known id and null for an unknown id", () => {
    expect(getEvalCandidateModel("candidate/qwen3-1.7b-onnx")?.id).toBe(
      "candidate/qwen3-1.7b-onnx",
    );
    expect(getEvalCandidateModel("local/phi3-mini-4k-q4f16")).toBeNull();
    expect(getEvalCandidateModel("nonexistent")).toBeNull();
  });

  it("zero-leak guard: no candidate appears in the shipping catalog", () => {
    const catalogIds = new Set(getCatalog().map((m) => m.id));
    for (const id of CANDIDATE_IDS) {
      expect(catalogIds.has(id), `${id} must NOT be in the shipping catalog`).toBe(false);
    }
  });
});
