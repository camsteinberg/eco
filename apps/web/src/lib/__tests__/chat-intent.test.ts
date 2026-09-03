// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  getGenerationProfile,
  inferChatIntent,
  inferTurnIntent,
} from "../chat-intent";

describe("chat intent quality helpers", () => {
  it("classifies code requests", () => {
    expect(inferChatIntent("debug this React component")).toBe("code");
  });

  it("does not treat every build request as code", () => {
    expect(inferChatIntent("build me a sandwich")).toBe("quick");
  });

  it("classifies writing requests", () => {
    expect(inferChatIntent("draft a warm email")).toBe("writing");
  });

  it("classifies detailed recipes as deep tasks instead of quick answers", () => {
    expect(inferChatIntent("Give me a detailed dinner recipe for chili")).toBe("deep");
  });

  it("uses research mode when enabled", () => {
    expect(inferChatIntent("tell me about batteries", { researchMode: true })).toBe("research");
  });

  it("uses lower temperature for code than writing", () => {
    expect(getGenerationProfile("code", true, "local/qwen3-0.6b").temperature).toBeLessThan(
      getGenerationProfile("writing", true, "local/qwen3-0.6b").temperature,
    );
  });

  it("adds local model-specific sampling controls", () => {
    expect(getGenerationProfile("explain", true, "local/qwen3-0.6b")).toMatchObject({
      topP: 0.84,
      topK: 20,
      repetitionPenalty: 1.06,
    });
  });

  it("applies intent overrides from local model quality profiles", () => {
    // An id in neither lane falls through to the baseline path (no per-model
    // overrides).
    expect(
      getGenerationProfile("writing", true, "local/not-a-real-model", {
        allowValidationModel: true,
      }),
    ).toMatchObject({
      temperature: 0.5,
    });
    expect(getGenerationProfile("writing", true, "local/qwen3-0.6b")).toMatchObject({
      temperature: 0.48,
      topP: 0.84,
      repetitionPenalty: 1.09,
    });
  });

  it("never bans n-grams on the intent that has to reuse the user's words", () => {
    // `writing` fires when someone pastes their own text and asks for it back
    // changed. Transformers.js applies the n-gram ban across the prompt as well
    // as the completion, so arming it here forbids the model from reproducing
    // any four-token span of what the user just wrote — on the one task class
    // whose whole requirement is reproducing what the user just wrote.
    //
    // This assertion previously pinned `noRepeatNgramSize: 4` as correct. It was
    // not; `repetitionPenalty` is the loop guard for these instruction-tuned
    // models. `candidate/lfm2.5-350m-onnx` is excluded deliberately — its ban is
    // a BASE setting pending a measured A/B, and its `writing` override is looser
    // than that base rather than tighter (see local-model-generation-profiles.ts).
    for (const modelId of [
      "local/qwen3-0.6b",
      "candidate/qwen3.5-2b-onnx",
      "candidate/lfm2.5-1.2b-instruct-onnx",
    ]) {
      expect(
        getGenerationProfile("writing", true, modelId).noRepeatNgramSize,
        `${modelId} would be unable to quote the user back`,
      ).toBeUndefined();
    }
  });

  it("gives local deep intent the full premium-chat budget", () => {
    expect(getGenerationProfile("deep", true).maxTokens).toBe(2048);
  });

  it("gives local models enough budget for complete recipes and drafts", () => {
    // An id in neither lane resolves nothing per-model and falls back to the
    // baseline writing budget — the intended behaviour for an unknown model.
    expect(
      getGenerationProfile("writing", true, "local/not-a-real-model", {
        allowValidationModel: true,
      }).maxTokens,
    ).toBe(1536);
    expect(getGenerationProfile("writing", true, "local/qwen3-0.6b").maxTokens).toBe(512);
  });

  it("uses a runtime-honest validation profile for Gemma E4B LiteRT", () => {
    const profile = getGenerationProfile("quick", true, "candidate/gemma-4-e4b-litert", {
      allowValidationModel: true,
    });

    expect(profile).toMatchObject({
      maxTokens: 256,
      topK: 64,
    });
    expect(profile).not.toHaveProperty("repetitionPenalty");
    expect(profile).not.toHaveProperty("noRepeatNgramSize");
  });

  it("can use eval-lane model profiles inside validation harnesses", () => {
    // The eval lane resolves per-model sampling of its own — an id-keyed row in
    // local-model-generation-profiles.ts, or the chat-intent `family` fallback.
    expect(
      getGenerationProfile("quick", true, "candidate/qwen3-1.7b-onnx", {
        allowValidationModel: true,
      }),
    ).toMatchObject({
      // From the qwen3 family slice, not the baseline (which carries no topK).
      topK: 20,
      maxTokens: 512,
    });
  });

  it("falls through to the baseline path for an id in neither lane", () => {
    // No per-model row and no recognized family, so the harness still resolves a
    // usable profile — just without per-model overrides.
    expect(
      getGenerationProfile("quick", true, "candidate/not-a-real-model", {
        allowValidationModel: true,
      }),
    ).toMatchObject({
      maxTokens: 1024,
      temperature: 0.5,
    });
  });

  it("fails closed for hidden direct local model IDs before prompt-profile generation", () => {
    const hiddenProfile = getGenerationProfile("deep", true, "local/not-a-real-model");
    expect(hiddenProfile).toMatchObject({
      temperature: 0.5,
      maxTokens: 2048,
    });
    expect(hiddenProfile).not.toHaveProperty("topP");
    expect(hiddenProfile).not.toHaveProperty("topK");
    expect(hiddenProfile).not.toHaveProperty("repetitionPenalty");
  });
});

// ─── Conversational shape routing (chat #7 / Wave 2.6 Stage 1) ─────────────
// Real users type lowercase conversational asks. The shape classifier
// (lib/answer-shape.ts) arbitrates the depth family: teaching-shaped asks get
// the deep treatment, single facts stay brief, the focused middle rides
// explain. Grounded in the Stage-0 shape-routing measurements.

describe("conversational shape routing", () => {
  it("routes skill-improvement how-do-i asks to deep (teaching shape)", () => {
    // Stage-0 measured: these never reached deep; the explicit-phrasing
    // premium is now the default treatment for teach-shaped asks.
    expect(inferChatIntent("how do i get better at public speaking")).toBe("deep");
    expect(inferChatIntent("how can i sleep better")).toBe("deep");
  });

  it("routes tell-me-about asks to explain (focused shape)", () => {
    expect(inferChatIntent("tell me about the roman empire")).toBe("explain");
  });

  it("routes difference asks to explain (with and without apostrophe)", () => {
    expect(inferChatIntent("whats the difference between a virus and bacteria")).toBe("explain");
    expect(inferChatIntent("what's the difference between tea and coffee")).toBe("explain");
  });

  it("keeps single-fact lookups brief (the anti-padding fix), why-asks focused", () => {
    // Stage-0 measured: explain-routed single facts padded ~2× (and the
    // padding is hallucination surface on Qwen). Brief shape → quick.
    expect(inferChatIntent("where was mark zuckerberg born")).toBe("quick");
    expect(inferChatIntent("who was cleopatra")).toBe("quick");
    expect(inferChatIntent("when did the berlin wall fall")).toBe("quick");
    // A why-question is an explanation ask, not a fact lookup.
    expect(inferChatIntent("why is the sky orange at sunset")).toBe("explain");
  });

  it("keeps greetings and short factual fragments in quick", () => {
    expect(inferChatIntent("hi")).toBe("quick");
    expect(inferChatIntent("thanks!")).toBe("quick");
    expect(inferChatIntent("capital of france?")).toBe("quick");
  });

  it("preserves code/writing precedence over the shape patterns", () => {
    expect(inferChatIntent("how do i debug a typescript function")).toBe("code");
    expect(inferChatIntent("how do i write a poem for my mom")).toBe("writing");
  });

  it("routes short anaphoric follow-ups brief only inside a thread", () => {
    expect(inferChatIntent("what about doing it in an apartment?", { hasPriorTurns: true })).toBe("quick");
    expect(inferChatIntent("what about doing it in an apartment?")).toBe("explain");
  });
});

// ─── Default-model token budgets (chat #7) ─────────────────────────────────
// The webgpu cap was raised 1024 → 2048 so the per-intent budgets actually
// differentiate (they were all flattened to 1024 before).

describe("LFM2.5-1.2B default-model token budgets", () => {
  const DEFAULT_MODEL = "candidate/lfm2.5-1.2b-instruct-onnx";

  it("gives explain its designed 1536 budget (no longer flattened to 1024)", () => {
    expect(getGenerationProfile("explain", true, DEFAULT_MODEL).maxTokens).toBe(1536);
  });

  // deep/code are authored at 2048 but clamp to the model's reply ceiling,
  // lowered to 1536 on 2026-09-02 (s40) after two measured ten-turn chats: the
  // 2048 reserve halved the 4096 window and evicted history from turn 4–5,
  // while no reply exceeded 656 tokens. See catalog-data.json provenance.
  it("gives deep/code the reply ceiling (1536), above explain's 1536 floor and quick's 1024", () => {
    expect(getGenerationProfile("deep", true, DEFAULT_MODEL).maxTokens).toBe(1536);
    expect(getGenerationProfile("code", true, DEFAULT_MODEL).maxTokens).toBe(1536);
  });

  it("keeps quick at 1024", () => {
    expect(getGenerationProfile("quick", true, DEFAULT_MODEL).maxTokens).toBe(1024);
  });
});

// ─── Turn intent (position-aware routing) ───────────────────────────────────

describe("turn intent routing", () => {
  it("position feeds the follow-up guard: first turn vs in-thread", () => {
    // In-thread anaphoric follow-up → brief → quick.
    expect(inferTurnIntent("can you make that one shorter", true)).toBe("quick");
    // Same text opening a conversation → focused → explain.
    expect(inferTurnIntent("can you make that one shorter", false)).toBe("explain");
  });
});
