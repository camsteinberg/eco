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
  "local/phi3-mini-4k-q4f16",
  "local/smollm2-1.7b-webllm-q4f16",
  "local/bonsai-1.7b-q4",
  "local/qwen3-0.6b",
  "candidate/lfm2.5-1.2b-instruct-onnx",
  "candidate/lfm2.5-350m-onnx",
  "candidate/qwen3.5-2b-onnx",
  "candidate/gemma-4-e2b-litert",
] as const;

describe("local model registry (v1 catalog)", () => {
  it("contains exactly the 8 v1 catalog models", () => {
    const entries = getLocalModelRegistryEntries();
    expect(entries).toHaveLength(8);
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
    expect(proxyArtifacts.length).toBeGreaterThanOrEqual(7);
    expect(proxyArtifacts.map((a) => a.hfId)).toEqual(
      expect.arrayContaining([
        "onnx-community/Qwen3-0.6B-ONNX",
        "onnx-community/Bonsai-1.7B-ONNX",
        "microsoft/Phi-3-mini-4k-instruct-onnx-web",
        "mlc-ai/SmolLM2-1.7B-Instruct-q4f16_1-MLC",
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
    // Graduated candidates (LFM2.5-1.2B in #4 Phase 2, Qwen3.5-2B in chat #7)
    // moved into the shipping catalog, so they are now proxy-allowed.
    expect(proxyHfIds).toContain("LiquidAI/LFM2.5-1.2B-Instruct-ONNX");
    expect(proxyHfIds).toContain("onnx-community/Qwen3.5-2B-ONNX-OPT");
    // The dev-only lane candidates are validation-allowed but NOT proxy-allowed:
    // Qwen3-1.7B (parked non-viable), LFM2-2.6B (beaten smart-tier incumbent),
    // Qwen3.5-4B (high-mem option), Gemma 4 E2B (eliminated).
    for (const laneHfId of [
      "onnx-community/Qwen3-1.7B-ONNX",
      "onnx-community/LFM2-2.6B-ONNX",
      "onnx-community/Qwen3.5-4B-ONNX-OPT",
      "onnx-community/gemma-4-E2B-it-ONNX",
      "litert-community/gemma-4-E4B-it-litert-lm",
    ]) {
      expect(validationHfIds).toContain(laneHfId);
      expect(proxyHfIds).not.toContain(laneHfId);
    }
  });

  it("centralizes reviewed artifact identity for the graduated Qwen3.5-2B smart pick", () => {
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
      hfId: "onnx-community/Qwen3-0.6B-ONNX",
      revision: "da1453100cf3ff33ef56d17983fc7a8648706db6",
    });
    expect(qwenArtifact!.files).toContain("onnx/model_q4f16.onnx");
  });

  it("centralizes reviewed artifact identity for Phi3", () => {
    const phi3Artifact = getLocalModelRegistryArtifact("local/phi3-mini-4k-q4f16");
    expect(phi3Artifact).toMatchObject({
      hfId: "microsoft/Phi-3-mini-4k-instruct-onnx-web",
      revision: "80a2792f5bf861528ce9b449b3230f1bd3fdc759",
    });
    expect(phi3Artifact!.files).toContain("onnx/model_q4f16.onnx");
    expect(phi3Artifact!.files).toContain("onnx/model_q4f16.onnx_data");
  });

  it("centralizes reviewed artifact identity for SmolLM2 (WebLLM)", () => {
    const smollm2Artifact = getLocalModelRegistryArtifact("local/smollm2-1.7b-webllm-q4f16");
    expect(smollm2Artifact).toMatchObject({
      hfId: "mlc-ai/SmolLM2-1.7B-Instruct-q4f16_1-MLC",
      revision: "84f57f8580a9d8d623266b600ad4273bb9fd84c1",
    });
    expect(smollm2Artifact!.files).toContain("params_shard_0.bin");
    expect(smollm2Artifact!.files).toContain("ndarray-cache.json");
  });

  it("returns null artifact for unknown model ids", () => {
    expect(getLocalModelRegistryArtifact("local/unknown")).toBeNull();
  });
});
