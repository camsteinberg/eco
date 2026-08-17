// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  getLocalModelRegistryArtifact,
  getLocalModelRegistryEntries,
  getLocalModelRegistryEntry,
  getProxyAllowedLocalModelRegistryArtifacts,
  getValidationAllowedLocalModelRegistryArtifacts,
} from "../local-model-registry";

const V1_CATALOG_IDS = [
  "local/qwen3-0.6b",
  "candidate/lfm2.5-1.2b-instruct-onnx",
  "candidate/lfm2.5-1.2b-instruct-q4-onnx",
  "candidate/lfm2.5-350m-onnx",
  "candidate/qwen3.5-2b-onnx",
  "candidate/gemma-4-e2b-litert",
  "candidate/qwen2.5-0.5b-mlc",
  "candidate/granite-4.0-350m-onnx",
  "candidate/smollm2-360m-instruct-onnx",
  "candidate/lfm2-2.6b-onnx",
] as const;

describe("local model registry (v1 catalog)", () => {
  it("contains exactly the 10 v1 catalog models", () => {
    const entries = getLocalModelRegistryEntries();
    expect(entries).toHaveLength(10);
    expect(entries.map((e) => e.modelId)).toEqual(
      expect.arrayContaining([...V1_CATALOG_IDS]),
    );
  });

  it("returns undefined for non-catalog model ids", () => {
    expect(getLocalModelRegistryEntry("local/smollm3-3b")).toBeUndefined();
    expect(getLocalModelRegistryEntry("candidate/bitnet-b158")).toBeUndefined();
    expect(getLocalModelRegistryEntry("auto")).toBeUndefined();
  });

  it.each(V1_CATALOG_IDS)("builds a complete artifact for %s", (id) => {
    const entry = getLocalModelRegistryEntry(id);
    expect(entry).toBeDefined();
    expect(entry!.artifact).not.toBeNull();
    const artifact = entry!.artifact!;
    expect(artifact.hfId).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(artifact.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(artifact.files.length).toBeGreaterThan(0);
    expect(artifact.expectedBytes).toBeGreaterThan(0);
    expect(artifact.fileMetadata).toBeDefined();
    // Every file in the artifact must have metadata
    for (const file of artifact.files) {
      const meta = artifact.fileMetadata![file];
      expect(meta, `${id} missing metadata for ${file}`).toBeDefined();
      expect(meta!.sizeBytes).toBeGreaterThan(0);
      expect(meta!.oid).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("returns proxy-allowed artifacts for all catalog models with artifacts", () => {
    const proxyArtifacts = getProxyAllowedLocalModelRegistryArtifacts();
    expect(proxyArtifacts.length).toBeGreaterThanOrEqual(5);
    expect(proxyArtifacts.map((a) => a.hfId)).toEqual(
      expect.arrayContaining([
        "econetworkai/Qwen3-0.6B-ONNX-external-data",
        "LiquidAI/LFM2.5-1.2B-Instruct-ONNX",
        "onnx-community/LFM2.5-350M-ONNX",
        "onnx-community/Qwen3.5-2B-ONNX-OPT",
      ]),
    );
  });

  it("returns validation-allowed as a strict superset of proxy-allowed (proxy ∪ eval-candidates)", () => {
    const proxyHfIds = getProxyAllowedLocalModelRegistryArtifacts().map((a) => a.hfId);
    const validationHfIds = getValidationAllowedLocalModelRegistryArtifacts().map((a) => a.hfId);

    // Every proxy-allowed hfId is also validation-allowed.
    expect(validationHfIds).toEqual(expect.arrayContaining(proxyHfIds));
    // Validation-allowed is strictly larger (the remaining eval candidates).
    expect(validationHfIds.length).toBeGreaterThan(proxyHfIds.length);
    // Graduated candidates (LFM2.5-1.2B in #4 Phase 2, Qwen3.5-2B in chat #7, and
    // the deeper LFM2-2.6B on 2026-08-10) moved into the shipping catalog, so they
    // are now proxy-allowed.
    expect(proxyHfIds).toContain("LiquidAI/LFM2.5-1.2B-Instruct-ONNX");
    expect(proxyHfIds).toContain("onnx-community/Qwen3.5-2B-ONNX-OPT");
    expect(proxyHfIds).toContain("onnx-community/LFM2-2.6B-ONNX");
    // The dev-only lane candidates are validation-allowed but NOT proxy-allowed:
    // Qwen3-1.7B (parked non-viable), Qwen3.5-4B (high-mem option), Gemma 4 E2B
    // (eliminated). After the external-data graduation the OLD single-file
    // Qwen3-0.6B repo (onnx-community/Qwen3-0.6B-ONNX) joined the lane too — it
    // carries the q4 load-peak cell and the retained single-file baseline, but the
    // catalog now serves econetworkai/Qwen3-0.6B-ONNX-external-data instead.
    for (const laneHfId of [
      "onnx-community/Qwen3-1.7B-ONNX",
      "onnx-community/Qwen3-0.6B-ONNX",
      "onnx-community/Qwen3.5-4B-ONNX-OPT",
      "onnx-community/gemma-4-E2B-it-ONNX",
      "litert-community/gemma-4-E4B-it-litert-lm",
    ]) {
      expect(validationHfIds).toContain(laneHfId);
      expect(proxyHfIds).not.toContain(laneHfId);
    }
  });

  it("keeps the whole old single-file Qwen3-0.6B hfId validation-only after the external-data graduation", () => {
    // The catalog graduated to the external-data pair
    // (econetworkai/Qwen3-0.6B-ONNX-external-data). The old single-file repo
    // onnx-community/Qwen3-0.6B-ONNX is now delisted from the catalog entirely and
    // lives ONLY in the eval lane: the q4 load-peak cell (onnx/model_q4.onnx) and
    // the retained single-file q4f16 baseline (onnx/model_q4f16.onnx). Neither
    // file may be proxy-allowed — the whole hfId must be reachable only through
    // the validation lane and stay 403 in production. The catalog serves the
    // external-data pair (graph + .onnx_data) instead.
    const OLD_HF_ID = "onnx-community/Qwen3-0.6B-ONNX";
    const XD_HF_ID = "econetworkai/Qwen3-0.6B-ONNX-external-data";

    const proxyFilesForOldHfId = getProxyAllowedLocalModelRegistryArtifacts()
      .filter((a) => a.hfId === OLD_HF_ID)
      .flatMap((a) => a.files);
    const validationFilesForOldHfId = getValidationAllowedLocalModelRegistryArtifacts()
      .filter((a) => a.hfId === OLD_HF_ID)
      .flatMap((a) => a.files);

    // The whole old hfId is delisted from the proxy-allowed set.
    expect(proxyFilesForOldHfId).toEqual([]);
    // Both eval-lane builds stay reachable through the validation lane.
    expect(validationFilesForOldHfId).toContain("onnx/model_q4.onnx");
    expect(validationFilesForOldHfId).toContain("onnx/model_q4f16.onnx");

    // The catalog serves the external-data pair.
    const proxyFilesForXd = getProxyAllowedLocalModelRegistryArtifacts()
      .filter((a) => a.hfId === XD_HF_ID)
      .flatMap((a) => a.files);
    expect(proxyFilesForXd).toContain("onnx/model_q4f16.onnx");
    expect(proxyFilesForXd).toContain("onnx/model_q4f16.onnx_data");
  });

  it("centralizes reviewed artifact identity for Qwen3.5-2B (now an opt-in larger model)", () => {
    const artifact = getLocalModelRegistryArtifact("candidate/qwen3.5-2b-onnx");
    expect(artifact).toMatchObject({
      hfId: "onnx-community/Qwen3.5-2B-ONNX-OPT",
      revision: "2ea7886f48b926aca97de8b0e041ffca7e3ebaa9",
    });
    // Text-only consumption of a multimodal export: embed_tokens + decoder
    // sessions, no vision encoder files.
    expect(artifact!.files).toContain("onnx/decoder_model_merged_q4f16.onnx");
    expect(artifact!.files).toContain("onnx/decoder_model_merged_q4f16.onnx_data");
    expect(artifact!.files).toContain("onnx/embed_tokens_q4f16.onnx");
    expect(artifact!.files.some((f) => f.includes("vision"))).toBe(false);
  });

  it("centralizes reviewed artifact identity for Qwen", () => {
    const qwenArtifact = getLocalModelRegistryArtifact("local/qwen3-0.6b");
    expect(qwenArtifact).toMatchObject({
      hfId: "econetworkai/Qwen3-0.6B-ONNX-external-data",
      revision: "e059eaaf660ff62dbc8adcd1057488aa3ad0f5f9",
    });
    // External-data pair: the small graph file plus its .onnx_data weights blob.
    expect(qwenArtifact!.files).toContain("onnx/model_q4f16.onnx");
    expect(qwenArtifact!.files).toContain("onnx/model_q4f16.onnx_data");
  });

  it("has retired Phi-3 from the registry (MC-2) — no artifact identity remains", () => {
    expect(getLocalModelRegistryArtifact("local/phi3-mini-4k-q4f16")).toBeNull();
  });

  it("returns null artifact for unknown model ids", () => {
    expect(getLocalModelRegistryArtifact("local/unknown")).toBeNull();
  });
});
