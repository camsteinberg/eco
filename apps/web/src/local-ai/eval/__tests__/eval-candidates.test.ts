// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { getCatalog, getModel, type CatalogModel } from "../../catalog/catalog";
import {
  getGenerationProfile,
  getMaxNewTokensCeiling,
  type ChatIntent,
} from "../../../lib/chat-intent";
import { webllmModelLibPathFor } from "../../runtime/webllm-config";
import type { ModelConfig } from "../../types";
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
// local/qwen3-0.6b's catalog artifact), and the Qwen3-0.6B MLC build
// (candidate/qwen3-0.6b-mlc, the desktop-Safari pick since 2026-09-22). The old
// single-file build stays here as candidate/qwen3-0.6b-q4f16-single, the paired
// A/B baseline. candidate/qwen3-0.6b-mlc-q0f16 is the unquantised MLC build of
// the same weights, a candidate for desktop Safari awaiting its real-Safari gate.
const CANDIDATE_IDS = [
  "candidate/qwen3-1.7b-onnx",
  "candidate/qwen3-0.6b-q4",
  "candidate/qwen3-0.6b-q4f16-single",
  "candidate/qwen3.5-4b-onnx",
  "candidate/gemma-4-e2b-onnx",
  "candidate/gemma-4-e2b-qat-q4-onnx",
  "candidate/gemma-4-e4b-litert",
  "candidate/qwen3-0.6b-mlc-q0f16",
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

  describe("the unquantised MLC Qwen3-0.6B cell (candidate/qwen3-0.6b-mlc-q0f16)", () => {
    const ID = "candidate/qwen3-0.6b-mlc-q0f16";
    const SHIPPING_SIBLING_ID = "candidate/qwen3-0.6b-mlc";
    const INTENTS: readonly ChatIntent[] = [
      "quick", "explain", "deep", "code", "writing", "file", "research",
    ];

    // Narrowing helpers, so a missing entry fails as an assertion, not a TypeError.
    const lane = (): ModelConfig => {
      const model = getEvalCandidateModel(ID);
      if (model === null) throw new Error(`${ID} is not in the eval lane`);
      return model;
    };
    const sibling = (): CatalogModel => {
      const model = getModel(SHIPPING_SIBLING_ID);
      if (model === null) throw new Error(`${SHIPPING_SIBLING_ID} is not in the catalog`);
      return model;
    };

    it("is the q0f16 build at the pinned revision, 29 weight shards", () => {
      const model = lane();
      expect(model.runtime).toBe("webllm");
      expect(model.format).toBe("mlc-q0f16");
      expect(model.artifact?.hfId).toBe("mlc-ai/Qwen3-0.6B-q0f16-MLC");
      expect(model.artifact?.revision).toBe("2d6c15b9dd8b99e021d978ada68faebbcfc12bb9");
      const shards = (model.artifact?.files ?? []).filter((f) => f.startsWith("params_shard_"));
      expect(shards).toEqual(Array.from({ length: 29 }, (_, i) => `params_shard_${String(i)}.bin`));
      expect(webllmModelLibPathFor(model)).toBe(
        "/webllm/v0_2_84/Qwen3-0.6B-q0f16_cs1k-webgpu.wasm",
      );
    });

    it("differs from the shipping q4f16_1 build only in weights and context window", () => {
      const model = lane();
      const shipped = sibling();
      // The one intended difference: with f16 weights, the sibling's 16384-token
      // KV cache no longer fits in Safari's memory (a tab kill in the real-Safari
      // walks), so this build runs a 4096-token window.
      expect(model.capabilities.contextTokens).toBe(4096);
      expect(shipped.capabilities.contextTokens).toBe(16384);
      expect({ ...model.capabilities, contextTokens: undefined }).toEqual({
        ...shipped.capabilities,
        contextTokens: undefined,
      });
      expect(model.generation).toEqual(shipped.generation);
      expect(model.maxNewTokens).toEqual(shipped.maxNewTokens);
      expect(model.quirks?.hasThinkingMode).toBe(true);
      expect(model.systemRoleSupport).toBe(shipped.systemRoleSupport);
      expect(model.license).toEqual(shipped.license);
      // Same device rules as the sibling, the notes aside.
      expect({ ...model.compat, _rationale: undefined }).toEqual({
        ...shipped.compat,
        _rationale: undefined,
      });
      expect(model.tier).toEqual({});
    });

    // An eval-lane entry's own `generation` block is not what the serving path
    // reads — the eval-lane rows in chat-intent.ts and
    // local-model-generation-profiles.ts are. Pin that the profile a harness run
    // resolves is the shipping sibling's, intent by intent.
    it.each(INTENTS)("resolves the shipping sibling's generation profile for %s", (intent) => {
      expect(getGenerationProfile(intent, true, ID, { allowValidationModel: true })).toEqual(
        getGenerationProfile(intent, true, SHIPPING_SIBLING_ID),
      );
    });

    it("resolves the shipping sibling's reply ceiling", () => {
      expect(getMaxNewTokensCeiling(ID, { allowValidationModel: true })).toBe(
        getMaxNewTokensCeiling(SHIPPING_SIBLING_ID),
      );
    });

    it("is not reachable through the shipping catalog", () => {
      expect(getModel(ID)).toBeNull();
    });
  });

  it("zero-leak guard: no candidate appears in the shipping catalog", () => {
    const catalogIds = new Set(getCatalog().map((m) => m.id));
    for (const id of CANDIDATE_IDS) {
      expect(catalogIds.has(id), `${id} must NOT be in the shipping catalog`).toBe(false);
    }
  });
});
