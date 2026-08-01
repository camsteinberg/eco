// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import catalog from "../../local-ai/catalog/catalog-data.json";
import {
  __profileModelIds,
  getLocalModelContextBudget,
  getLocalModelGenerationDefaults,
  isCjkSuppressionEnabled,
  type ChatIntentModelSlice,
} from "../local-model-generation-profiles";

// ─── Helpers ─────────────────────────────────────────────────────────────

const INTENTS = ["quick", "explain", "deep", "code", "writing", "file", "research"] as const;

function modelSlice(
  id: string,
  family: ChatIntentModelSlice["family"],
): ChatIntentModelSlice {
  return {
    id,
    family,
    qualityTier: "smart",
    maxNewTokens: { webgpu: 512 },
  };
}

// ─── Phi-3 Mini ──────────────────────────────────────────────────────────

describe("Phi-3 Mini generation profile", () => {
  const phi3 = modelSlice("local/phi3-mini-4k-q4f16", "phi");

  it("inherits default context budget for the quick intent (no per-model override)", () => {
    const budget = getLocalModelContextBudget(phi3, "quick");
    expect(budget).toBe(1024);
  });

  it("uses repetition_penalty >= 1.1 at the base level", () => {
    const defaults = getLocalModelGenerationDefaults(phi3);
    expect(defaults.repetitionPenalty).toBeGreaterThanOrEqual(1.1);
  });

  it("uses repetition_penalty >= 1.1 for the quick intent", () => {
    const defaults = getLocalModelGenerationDefaults(phi3, "quick");
    expect(defaults.repetitionPenalty).toBeGreaterThanOrEqual(1.1);
  });
});

// ─── Bonsai q4 ───────────────────────────────────────────────────────────

describe("Bonsai 1.7B q4 generation profile", () => {
  const bonsai = modelSlice("local/bonsai-1.7b-q1", "bonsai");

  it("has noRepeatNgramSize guard at base level", () => {
    const defaults = getLocalModelGenerationDefaults(bonsai);
    expect(defaults.noRepeatNgramSize).toBeGreaterThanOrEqual(3);
  });

  it("has repetitionPenalty >= 1.06 at base level", () => {
    const defaults = getLocalModelGenerationDefaults(bonsai);
    expect(defaults.repetitionPenalty).toBeGreaterThanOrEqual(1.06);
  });
});

// ─── LFM2.5 350M ────────────────────────────────────────────────────────

describe("LFM2.5 350M generation profile", () => {
  const lfm = modelSlice("candidate/lfm2.5-350m-onnx", "lfm2");

  // ★ ASSERTED AT EVERY INTENT, NOT JUST BASE. This ban lived on two layers — a
  // base n=3 and a `writing` n=4 — and `writing` is the intent that fires when
  // someone pastes their own words and asks for them back changed. Pinning base
  // alone would let the harmful half be reintroduced against a green suite.
  // Removal is measured, not preference: a real-model A/B (n=10) moved
  // `preservesUserText` past the pre-registered bar without the feared looping.
  it("applies no prompt-inclusive n-gram ban at base or at any intent", () => {
    expect(getLocalModelGenerationDefaults(lfm).noRepeatNgramSize).toBeUndefined();
    for (const intent of INTENTS) {
      expect(
        getLocalModelGenerationDefaults(lfm, intent).noRepeatNgramSize,
        `${intent} re-arms the n-gram ban that blocks giving the user their own words back`,
      ).toBeUndefined();
    }
  });

  it("has repetitionPenalty >= 1.08 at base level", () => {
    const defaults = getLocalModelGenerationDefaults(lfm);
    expect(defaults.repetitionPenalty).toBeGreaterThanOrEqual(1.08);
  });
});

// ─── Qwen3-era (qwen3 family — vendor rec genuinely is top_p 0.95) ───────
//
// The qwen3-era models stay on QWEN_GEN: their family's published thinking-mode
// recommendation really is top_p 0.95. They must NOT inherit the Qwen3.5
// top_p 0.8 ceiling — that vendor non-thinking rec is family-scoped to
// qwen3_5 only.

describe("Qwen3 0.6B generation profile", () => {
  const qwen = modelSlice("local/qwen3-0.6b", "qwen3");

  it("uses temperature 0.6 (Qwen3 thinking-mode default)", () => {
    const defaults = getLocalModelGenerationDefaults(qwen);
    expect(defaults.temperature).toBe(0.6);
  });

  it("uses topP 0.95 (Qwen3 thinking-mode default)", () => {
    const defaults = getLocalModelGenerationDefaults(qwen);
    expect(defaults.topP).toBe(0.95);
  });

  it("uses topK 20 (Qwen3 published default)", () => {
    const defaults = getLocalModelGenerationDefaults(qwen);
    expect(defaults.topK).toBe(20);
  });
});

describe("Qwen3 1.7B eval candidate keeps the qwen3-era top_p 0.95", () => {
  const qwen17 = modelSlice("candidate/qwen3-1.7b-onnx", "qwen3");

  it("uses topP 0.95 (qwen3 family — NOT the qwen3_5 0.8 ceiling)", () => {
    const defaults = getLocalModelGenerationDefaults(qwen17);
    expect(defaults.topP).toBe(0.95);
  });
});

// ─── Qwen3.5 (qwen3_5 family — vendor non-thinking ceiling, top_p 0.8) ───
//
// QWEN35_GEN holds the sampling tail at top_p 0.8 (the vendor non-thinking
// ceiling), kept on no-regression evidence — NOT as a CJK fix. The reproducible
// s1 CJK leak ("甲烷", the Chinese token for methane) is NOT fixed by sampling:
// a real-WebGPU A/B on 2026-06-11 (runs wave25-cjk-fix-r1/r2) showed it recurs
// at 0.8 — the token is high-probability in-slot for this multilingual model.
// Deterministic CJK suppression is the tracked fix (see the source rationale in
// local-model-generation-profiles.ts). The 2B is the shipping smart pick; the
// 4B is a dev-only eval-lane candidate — same vendor family, same rec, same
// slice. The s1 leak fired on the WRITING intent override, so that path is
// asserted explicitly below.

describe("Qwen3.5 2B generation profile (shipping smart pick)", () => {
  const qwen35 = modelSlice("candidate/qwen3.5-2b-onnx", "qwen3_5");

  it("narrows base topP to 0.8 (vendor non-thinking ceiling; held on no-regression evidence)", () => {
    const defaults = getLocalModelGenerationDefaults(qwen35);
    expect(defaults.topP).toBe(0.8);
  });

  it("keeps temperature 0.6 (the measured bake-off value)", () => {
    const defaults = getLocalModelGenerationDefaults(qwen35);
    expect(defaults.temperature).toBe(0.6);
  });

  it("keeps topK 20", () => {
    const defaults = getLocalModelGenerationDefaults(qwen35);
    expect(defaults.topK).toBe(20);
  });

  it("keeps repetitionPenalty 1.08 (TJS has no presence_penalty)", () => {
    const defaults = getLocalModelGenerationDefaults(qwen35);
    expect(defaults.repetitionPenalty).toBe(1.08);
  });

  it("caps the writing intent at topP 0.8 (the intent that leaked s1)", () => {
    const defaults = getLocalModelGenerationDefaults(qwen35, "writing");
    expect(defaults.topP).toBe(0.8);
  });

  it("caps the explain intent at topP 0.8", () => {
    const defaults = getLocalModelGenerationDefaults(qwen35, "explain");
    expect(defaults.topP).toBe(0.8);
  });
});

describe("Qwen3.5 4B eval candidate shares the qwen3_5 slice", () => {
  const qwen35_4b = modelSlice("candidate/qwen3.5-4b-onnx", "qwen3_5");

  it("narrows base topP to 0.8", () => {
    const defaults = getLocalModelGenerationDefaults(qwen35_4b);
    expect(defaults.topP).toBe(0.8);
  });

  it("caps the writing intent at topP 0.8", () => {
    const defaults = getLocalModelGenerationDefaults(qwen35_4b, "writing");
    expect(defaults.topP).toBe(0.8);
  });
});

// ─── QWEN35_GEN invariant: no intent override exceeds the base topP ──────
//
// The ceiling is the vendor-aligned sampling contract for this slice. Any
// intent override that raised topP above the base would silently diverge from
// the measured profile (the values the 2026-06-11 A/B validated as
// no-regression) — guard that no override exceeds the base.

describe("Qwen3.5 top_p ceiling invariant", () => {
  const INTENTS = ["quick", "explain", "deep", "code", "writing", "file", "research"] as const;
  const qwen35 = modelSlice("candidate/qwen3.5-2b-onnx", "qwen3_5");
  // Derive the ceiling from the resolved base so the invariant self-adjusts if
  // the base topP is ever retuned — the contract is "no intent override exceeds
  // the base", independent of the specific value. Fall back to -Infinity (not
  // Infinity) so a base that ever resolves to undefined fails the ceiling check
  // loudly rather than silently passing.
  const baseTopP = getLocalModelGenerationDefaults(qwen35).topP ?? -Infinity;

  // The deliberate-value pin lives separately (kept here so a retune is a
  // conscious edit, not a silent drift).
  it("has base topP 0.8", () => {
    expect(getLocalModelGenerationDefaults(qwen35).topP).toBe(0.8);
  });

  it.each(INTENTS)("never exceeds base topP for the %s intent", (intent) => {
    const defaults = getLocalModelGenerationDefaults(qwen35, intent);
    expect(defaults.topP).toBeLessThanOrEqual(baseTopP);
  });
});

// ─── Gemma 4 LiteRT ─────────────────────────────────────────────────────

describe("Gemma 4 LiteRT generation profile", () => {
  const gemmaOnnx = {
    ...modelSlice("candidate/gemma-4-e2b-onnx", "qwen3"),
    family: "gemma4",
  } as unknown as ChatIntentModelSlice;
  const gemmaE2bLiteRt = {
    ...modelSlice("candidate/gemma-4-e2b-litert", "qwen3"),
    family: "gemma4",
  } as unknown as ChatIntentModelSlice;
  const gemmaE4bLiteRt = {
    ...modelSlice("candidate/gemma-4-e4b-litert", "qwen3"),
    family: "gemma4",
  } as unknown as ChatIntentModelSlice;

  it.each([
    ["E2B", gemmaE2bLiteRt],
    ["E4B", gemmaE4bLiteRt],
  ] as const)("keeps only LiteRT-honored sampler controls on the %s runtime path", (_label, model) => {
    for (const intent of INTENTS) {
      const defaults = getLocalModelGenerationDefaults(model, intent);

      expect(defaults).toMatchObject({
        temperature: expect.any(Number),
        topP: expect.any(Number),
        topK: 64,
      });
      expect(defaults).not.toHaveProperty("repetitionPenalty");
      expect(defaults).not.toHaveProperty("noRepeatNgramSize");
    }
  });

  it("includes both LiteRT Gemma candidates in the explicit profile map", () => {
    expect(__profileModelIds).toContain("candidate/gemma-4-e2b-litert");
    expect(__profileModelIds).toContain("candidate/gemma-4-e4b-litert");
  });

  it.each([
    ["E2B", gemmaE2bLiteRt],
    ["E4B", gemmaE4bLiteRt],
  ] as const)("uses a tighter quick budget for LiteRT Gemma %s than generic Gemma ONNX", (_label, model) => {
    expect(getLocalModelContextBudget(model, "quick")).toBeLessThan(
      getLocalModelContextBudget(gemmaOnnx, "quick") ?? 0,
    );
  });

  it.each([
    ["E2B", gemmaE2bLiteRt],
    ["E4B", gemmaE4bLiteRt],
  ] as const)("pins LiteRT Gemma %s runtime-honest context budgets", (_label, model) => {
    expect(getLocalModelContextBudget(model)).toBe(1024);
    expect(getLocalModelContextBudget(model, "quick")).toBe(256);
    expect(getLocalModelContextBudget(model, "explain")).toBe(768);
    expect(getLocalModelContextBudget(model, "deep")).toBe(1536);
    expect(getLocalModelContextBudget(model, "code")).toBe(1024);
    expect(getLocalModelContextBudget(model, "research")).toBe(1536);
  });

  it.each([
    ["E2B", gemmaE2bLiteRt],
    ["E4B", gemmaE4bLiteRt],
  ] as const)("keeps enough deep budget for a fair quality pass on %s", (_label, model) => {
    expect(getLocalModelContextBudget(model, "deep")).toBeGreaterThanOrEqual(1024);
  });
});

// ─── Null / unknown model safety ─────────────────────────────────────────

describe("generation profile edge cases", () => {
  it("returns null context budget for null model", () => {
    expect(getLocalModelContextBudget(null)).toBeNull();
  });

  it("returns empty defaults for null model", () => {
    const defaults = getLocalModelGenerationDefaults(null);
    expect(Object.keys(defaults)).toHaveLength(0);
  });
});

// ─── Catalog ↔ profile coverage invariant ────────────────────────────────
//
// If a model lands in catalog-data.json without a profile entry, chat-intent
// will silently fall through to family fallback or default budgets — guard
// against that drift in CI.

type CatalogEntry = { id: string };

describe("catalog coverage invariant", () => {
  it("has a generation profile entry for every v1 catalog model id", () => {
    const catalogIds = (catalog as { models: CatalogEntry[] }).models.map(
      (m) => m.id,
    );
    const profileIds = new Set(__profileModelIds);

    const missing = catalogIds.filter((id) => !profileIds.has(id));
    expect(missing).toEqual([]);
  });
});

// ─── CJK suppression opt-in ──────────────────────────────────────────────
//
// Pins the blast radius: ONLY the Qwen3.5 family (measured s1 "甲烷" leak,
// sampling fix refuted) opts into the deterministic logits-level suppression.
// Every other model — especially the shipping everyday default — must stay
// out until it has its own measured leak + gated verification run.

describe("isCjkSuppressionEnabled", () => {
  it("is enabled for the Qwen3.5 shipping smart pick", () => {
    expect(isCjkSuppressionEnabled("candidate/qwen3.5-2b-onnx")).toBe(true);
  });

  it("is enabled for the Qwen3.5-4B eval candidate (shares the slice)", () => {
    expect(isCjkSuppressionEnabled("candidate/qwen3.5-4b-onnx")).toBe(true);
  });

  it.each([
    "candidate/lfm2.5-1.2b-instruct-onnx", // fast / low-memory fallback — must never pay the scan
    "candidate/lfm2.5-350m-onnx",
    "local/bonsai-1.7b-q1",
    "local/phi3-mini-4k-q4f16",
    "local/qwen3-0.6b", // qwen3 gen: shared vocab risk but NO measured leak — needs its own gated run
    "candidate/qwen3-1.7b-onnx",
    "candidate/lfm2-2.6b-onnx",
    "candidate/gemma-4-e2b-onnx",
    "candidate/gemma-4-e2b-qat-q4-onnx", // QAT-q4 Gemma — same vendor-anchored slice, no CJK leak class
    "candidate/gemma-4-e2b-litert", // LiteRT-runtime Gemma — no CJK leak class
    "candidate/gemma-4-e4b-litert", // eval-only LiteRT-runtime Gemma — no CJK leak class
    "candidate/qwen2.5-0.5b-mlc", // WebKit-mobile Qwen2.5 — generic Qwen slice, no measured CJK leak
  ])("is disabled for %s", (id) => {
    expect(isCjkSuppressionEnabled(id)).toBe(false);
  });

  it("is disabled for unknown model ids", () => {
    expect(isCjkSuppressionEnabled("candidate/some-future-model")).toBe(false);
  });
});
