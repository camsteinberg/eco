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
// them now): Qwen3.5-2B (chat #7 bake-off winner, 2026-06-11), gemma-4-e2b-litert
// (f16-less C2/C3 answer, model-offering overhaul 2026-06-29), LFM2-2.6B (the deeper
// eco-smart pick, by-eye graduation 2026-08-10), and the Qwen3-0.6B external-data
// pair (candidate/qwen3-0.6b-q4f16-xd, graduated 2026-07-17 — it became
// local/qwen3-0.6b's catalog artifact). The old single-file build stays here as
// candidate/qwen3-0.6b-q4f16-single, the paired A/B baseline.
const CANDIDATE_IDS = [
  "candidate/qwen3-1.7b-onnx",
  "candidate/qwen3-0.6b-q4",
  "candidate/qwen3-0.6b-q4f16-single",
  "candidate/qwen3.5-4b-onnx",
  "candidate/gemma-4-e2b-onnx",
  "candidate/gemma-4-e2b-qat-q4-onnx",
  "candidate/gemma-4-e4b-litert",
  "candidate/qwen3-0.6b-mlc",
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

  it("the graduated LFM2-2.6B is no longer a lane candidate (deeper eco-smart pick, 2026-08-10)", () => {
    expect(getEvalCandidateModel("candidate/lfm2-2.6b-onnx")).toBeNull();
    expect(EVAL_CANDIDATE_ARTIFACT_METADATA["candidate/lfm2-2.6b-onnx"]).toBeUndefined();
  });

  it("the graduated Qwen3-0.6B external-data cell is no longer a lane candidate", () => {
    // It moved to the shipping catalog as local/qwen3-0.6b's artifact (2026-07-17);
    // a model must never live in both sets.
    expect(getEvalCandidateModel("candidate/qwen3-0.6b-q4f16-xd")).toBeNull();
    expect(EVAL_CANDIDATE_ARTIFACT_METADATA["candidate/qwen3-0.6b-q4f16-xd"]).toBeUndefined();
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
    expect(getEvalCandidateModel("local/qwen3-0.6b")).toBeNull();
    expect(getEvalCandidateModel("nonexistent")).toBeNull();
  });

  it("the A-3 q4 load-peak cell selects the fp32-initializer artifact", () => {
    const model = getEvalCandidateModel("candidate/qwen3-0.6b-q4");
    expect(model).not.toBeNull();
    // format 'onnx-q4' → dtype 'q4' → TJS requests onnx/model_q4.onnx (the whole
    // point: fp32 initializers, no fp16 cast at ORT session-build).
    expect(model!.format).toBe("onnx-q4");
    expect(model!.artifact!.files).toContain("onnx/model_q4.onnx");
    expect(model!.artifact!.files).not.toContain("onnx/model_q4f16.onnx");
    // Same shipping Qwen3-0.6B weights (pinned revision as the catalog entry).
    expect(model!.artifact!.hfId).toBe("onnx-community/Qwen3-0.6B-ONNX");
    expect(model!.artifact!.revision).toBe(
      "da1453100cf3ff33ef56d17983fc7a8648706db6",
    );
    const meta = EVAL_CANDIDATE_ARTIFACT_METADATA["candidate/qwen3-0.6b-q4"];
    expect(meta?.["onnx/model_q4.onnx"]).toEqual({
      sizeBytes: 919096585,
      oid: "d43d836fc5e240df9013733ccd214972c5d21bd9ec47e574e4f1e359cf90aed0",
    });
  });

  it("the A-3 single-file baseline cell retains the pre-graduation build", () => {
    const model = getEvalCandidateModel("candidate/qwen3-0.6b-q4f16-single");
    expect(model).not.toBeNull();
    // Same q4f16 dtype/weights as the graduated catalog external-data pair, but
    // in the ORIGINAL single-file packaging (onnx/model_q4f16.onnx) — kept so the
    // single-file load transient can be A/B'd against the shipping external-data
    // build in a paired measurement on the same machine.
    expect(model!.format).toBe("onnx-q4f16");
    expect(model!.artifact!.files).toContain("onnx/model_q4f16.onnx");
    expect(model!.artifact!.files).not.toContain("onnx/model_q4f16.onnx_data");
    // The pre-graduation shipping artifact (onnx-community/Qwen3-0.6B-ONNX@da14531).
    expect(model!.artifact!.hfId).toBe("onnx-community/Qwen3-0.6B-ONNX");
    expect(model!.artifact!.revision).toBe(
      "da1453100cf3ff33ef56d17983fc7a8648706db6",
    );
    const meta = EVAL_CANDIDATE_ARTIFACT_METADATA["candidate/qwen3-0.6b-q4f16-single"];
    expect(meta?.["onnx/model_q4f16.onnx"]).toEqual({
      sizeBytes: 569789750,
      oid: "9e33a5911974174761d0dfdcc0bec975d9c45af0eae5e9eb647b8ba9442a8f91",
    });
  });

  it("zero-leak guard: no candidate appears in the shipping catalog", () => {
    const catalogIds = new Set(getCatalog().map((m) => m.id));
    for (const id of CANDIDATE_IDS) {
      expect(catalogIds.has(id), `${id} must NOT be in the shipping catalog`).toBe(false);
    }
  });
});
