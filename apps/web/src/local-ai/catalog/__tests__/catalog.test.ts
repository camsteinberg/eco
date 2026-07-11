// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase C catalog tests.
 *
 * The v1.0 user-facing catalog is exactly 7 models. Every entry must carry the
 * full ModelConfig surface. These tests are the guard against silent drift in
 * the catalog data (especially: someone adding a model without going through the
 * design review that locks the catalog).
 *
 * Source: docs/design/2026-05-16/vision-and-architecture.md §2.4
 * Qwen3.5-2B graduated 2026-06-11 (chat #7 smart-tier bake-off winner).
 */

import { describe, expect, it } from 'vitest';
import { getCatalog, getModel } from '../catalog';
import { getCapabilities } from '../capabilities';
import artifactMetadata from '../artifact-metadata.json';

const V1_CATALOG_IDS = [
  'local/phi3-mini-4k-q4f16',
  'local/bonsai-1.7b-q4',
  'local/qwen3-0.6b',
  'candidate/lfm2.5-1.2b-instruct-onnx',
  'candidate/lfm2.5-350m-onnx',
  'candidate/qwen3.5-2b-onnx',
  'candidate/gemma-4-e2b-litert',
] as const;

const TECHNICAL_ID_PATTERN = /q4f16|q4f|q4_1|webllm|onnx|fp16|q8|q4\b|q2f16|bnb4|mlc/i;

describe('local-ai catalog (Phase C)', () => {
  it('ships exactly 7 models', () => {
    expect(getCatalog()).toHaveLength(7);
  });

  it('ships the locked v1.0 catalog ids in source order', () => {
    expect(getCatalog().map((m) => m.id)).toEqual(V1_CATALOG_IDS);
  });

  it.each(V1_CATALOG_IDS)('exposes all required ModelConfig fields for %s', (id) => {
    const model = getModel(id);
    expect(model, id).not.toBeNull();
    expect(model!.id, `${id}.id`).toBe(id);
    expect(model!.friendlyName, `${id}.friendlyName`).toMatch(/\S/);
    expect(model!.vendor, `${id}.vendor`).toMatch(/\S/);
    expect(model!.sizeGB, `${id}.sizeGB`).toBeGreaterThan(0);
    expect(['transformers', 'litert']).toContain(model!.runtime);
    expect(['onnx-q4', 'onnx-q4f16', 'mlc-q4f16', 'litertlm']).toContain(model!.format);
    expect(model!.capabilities.intent.length, `${id}.capabilities.intent`).toBeGreaterThan(0);
    expect(model!.capabilities.tasks.length, `${id}.capabilities.tasks`).toBeGreaterThan(0);
    expect(model!.capabilities.contextTokens, `${id}.capabilities.contextTokens`).toBeGreaterThan(0);
    expect(model!.bestFor, `${id}.bestFor`).toMatch(/\S/);
    expect(model!.knownLimitation, `${id}.knownLimitation`).toMatch(/\S/);
    expect(['proven', 'predicted', 'experimental']).toContain(model!.evidenceTier);
  });

  // Context windows are per-model MEASURED values, not defaults: 8192 requires
  // real-WebGPU memory-headroom evidence for that exact model (LFM2.5-1.2B +
  // Qwen3.5-2B verified 2026-06-12; both are hybrid-attention = small KV).
  // The rest stay 4096 deliberately — Phi-3 is natively 4k, and the
  // small/legacy models haven't earned a measurement. Raising any value here
  // means a fresh headroom run first.
  it('pins the measured per-model context windows', () => {
    const expected: Record<(typeof V1_CATALOG_IDS)[number], number> = {
      'local/phi3-mini-4k-q4f16': 4096,
      'local/bonsai-1.7b-q4': 4096,
      'local/qwen3-0.6b': 4096,
      'candidate/lfm2.5-1.2b-instruct-onnx': 8192,
      'candidate/lfm2.5-350m-onnx': 4096,
      'candidate/qwen3.5-2b-onnx': 8192,
      // LiteRT web/CPU/GPU builds are 2048-context (model card; only the NPU
      // build is 4096). Passed as the engine's maxNumTokens.
      'candidate/gemma-4-e2b-litert': 2048,
    };
    for (const id of V1_CATALOG_IDS) {
      expect(getModel(id)!.capabilities.contextTokens, id).toBe(expected[id]);
    }
  });

  // Phase K invariant 10 (no technical IDs in user copy) starts to bite here —
  // the friendlyName + bestFor + knownLimitation are surfaced directly in UI.
  // Vendor strings are an exception (e.g., "MLC AI" is a real org name).
  it.each(V1_CATALOG_IDS)('uses a non-technical friendlyName for %s', (id) => {
    const model = getModel(id)!;
    expect(model.friendlyName, `${id}.friendlyName should not contain technical tokens`).not.toMatch(
      TECHNICAL_ID_PATTERN,
    );
  });

  it.each(V1_CATALOG_IDS)('keeps bestFor copy free of technical artifact tokens for %s', (id) => {
    const model = getModel(id)!;
    expect(model.bestFor, `${id}.bestFor should not contain technical tokens`).not.toMatch(
      TECHNICAL_ID_PATTERN,
    );
  });

  it('returns null for unknown model ids', () => {
    expect(getModel('local/does-not-exist')).toBeNull();
    expect(getModel('')).toBeNull();
  });

  it('returns null for lab-only model ids (catalog is the v1.0 set, not the universe)', () => {
    // smollm3-3b is in the lab, not the v1.0 catalog. Catalog must NOT surface it.
    expect(getModel('local/smollm3-3b')).toBeNull();
    expect(getModel('candidate/bitnet-b158')).toBeNull();
  });

  it('returns a frozen catalog snapshot — callers cannot mutate the source', () => {
    const snapshot = getCatalog();
    const original = snapshot[0]!;
    // Runtime check: Object.freeze refuses writes in strict mode.
    expect(() => {
      (original as { friendlyName: string }).friendlyName = 'tampered';
    }).toThrow();
    // And the array itself is a copy — mutating it doesn't break the next reader.
    snapshot.length = 0;
    expect(getCatalog()).toHaveLength(7);
  });

  // The catalog's artifact files must have corresponding entries in
  // artifact-metadata.json (the proxy's integrity-verification source).
  // Drift = 403 in production (the exact failure that prompted commit
  // bdb352ac). This invariant test catches drift at build time.
  it.each(V1_CATALOG_IDS)('artifact has complete file metadata for %s', (id) => {
    const model = getModel(id)!;
    expect(model.artifact, `${id}.artifact`).toBeDefined();
    const allMetadata = artifactMetadata as unknown as Record<string, Record<string, { sizeBytes: number; oid: string }> | undefined>;
    const metadata = allMetadata[id];
    expect(metadata, `${id} missing from artifact-metadata.json`).toBeDefined();
    for (const file of model.artifact!.files) {
      const entry = metadata![file];
      expect(entry, `${id} artifact-metadata.json missing entry for ${file}`).toBeDefined();
      expect(entry!.sizeBytes, `${id} ${file} sizeBytes`).toBeGreaterThan(0);
      expect(entry!.oid, `${id} ${file} oid`).toMatch(/^[0-9a-f]+$/);
    }
  });

  // Bootstrap reads model.artifact to build the DownloadPlan; the proxy
  // allowlist enforces the exact paths server-side. Mismatches surface as
  // 403s in production, so every catalog model MUST ship an artifact.
  it.each(V1_CATALOG_IDS)('ships a complete artifact block for %s', (id) => {
    const model = getModel(id)!;
    expect(model.artifact, `${id}.artifact`).toBeDefined();
    const artifact = model.artifact!;
    expect(artifact.hfId, `${id}.artifact.hfId`).toMatch(/^[\w.-]+\/[\w.-]+$/); // org/repo
    expect(artifact.revision, `${id}.artifact.revision`).toMatch(/^[0-9a-f]{40}$/); // pinned SHA
    expect(artifact.files.length, `${id}.artifact.files`).toBeGreaterThan(0);
    for (const file of artifact.files) {
      // file paths are HF-relative; no leading slash, no traversal.
      expect(file, `${id}.artifact.files contains a bad path`).toMatch(/^[\w./-]+$/);
      expect(file.startsWith('/'), `${id}.artifact.files entry starts with /`).toBe(false);
      expect(file.includes('..'), `${id}.artifact.files entry contains ..`).toBe(false);
    }
  });

  it('exposes capabilities via the dedicated capabilities surface', () => {
    const phi3 = getModel('local/phi3-mini-4k-q4f16')!;
    const caps = getCapabilities(phi3);
    expect(caps.intent).toEqual(phi3.capabilities.intent);
    expect(caps.tasks).toEqual(phi3.capabilities.tasks);
    expect(caps.contextTokens).toBe(phi3.capabilities.contextTokens);

    // capabilities returns copies — caller mutation doesn't poison the catalog.
    caps.intent.push('quality');
    expect(getCapabilities(phi3).intent).toEqual(phi3.capabilities.intent);
  });
});
