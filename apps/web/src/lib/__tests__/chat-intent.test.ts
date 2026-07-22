// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  applyTurnHints,
  buildHintedUserTurn,
  buildTurnQualityInstruction,
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
    expect(getGenerationProfile("code", false).temperature).toBeLessThan(
      getGenerationProfile("writing", false).temperature,
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
    // smollm3-3b is a lab/validation-harness model — its dedicated profile was
    // removed when PROFILE_BY_MODEL_ID trimmed to the v1 catalog. It now falls
    // through to the baseline path (no per-model overrides).
    expect(
      getGenerationProfile("writing", true, "local/smollm3-3b", {
        allowValidationModel: true,
      }),
    ).toMatchObject({
      temperature: 0.75,
    });
    expect(getGenerationProfile("writing", true, "local/qwen3-0.6b")).toMatchObject({
      temperature: 0.48,
      topP: 0.84,
      repetitionPenalty: 1.09,
      noRepeatNgramSize: 4,
    });
  });

  it("gives local deep intent the full premium-chat budget", () => {
    expect(getGenerationProfile("deep", true).maxTokens).toBe(2048);
  });

  it("gives local models enough budget for complete recipes and drafts", () => {
    // smollm3-3b lost its per-model profile when PROFILE_BY_MODEL_ID was trimmed
    // to the v1 catalog — it now falls back to the baseline writing budget.
    expect(
      getGenerationProfile("writing", true, "local/smollm3-3b", {
        allowValidationModel: true,
      }).maxTokens,
    ).toBe(1024);
    expect(getGenerationProfile("writing", true, "local/qwen3-0.6b").maxTokens).toBe(512);
  });

  it("returns empty string for quick intent (no scaffolding to leak)", () => {
    expect(buildTurnQualityInstruction("quick", true, "local/phi3-mini-4k-q4f16")).toBe("");
  });

  it("returns a working-code hint for code intent regardless of model", () => {
    const instruction = buildTurnQualityInstruction("code", true, "local/qwen3-0.6b");
    expect(instruction).toContain("working code");
  });

  it("returns format hint for writing intent without food content", () => {
    const instruction = buildTurnQualityInstruction("writing", true, "local/qwen3-0.6b");
    expect(instruction).toContain("format");
    expect(instruction).not.toContain("vegetarian");
    expect(instruction).not.toContain("recipe");
    expect(instruction).not.toContain("vegan");
    expect(instruction).not.toContain("broth");
  });

  it("keeps standard quality hints model-independent", () => {
    const local = buildTurnQualityInstruction("explain", true, "local/qwen3-0.6b");
    const network = buildTurnQualityInstruction("explain", false, undefined);
    expect(local).toBe(network);
  });

  it.each([
    "candidate/gemma-4-e2b-litert",
    "candidate/gemma-4-e4b-litert",
  ])("uses compact quick/explain/deep hints for Gemma LiteRT %s", (modelId) => {
    const explain = buildTurnQualityInstruction("explain", true, modelId);
    const deep = buildTurnQualityInstruction("deep", true, modelId);

    expect(explain).toContain("at most three concise paragraphs or bullets");
    expect(deep).toContain("at most three short sections");
    expect(deep).toContain("two bullets each");
    const quick = buildTurnQualityInstruction("quick", true, modelId);

    expect(quick).toContain("Answer directly and briefly");
    expect(quick).toContain("single factual question");
    expect(deep).not.toContain("concrete recommendations and tradeoffs");
    expect(deep).not.toContain("tradeoff");
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

  it("canary: no intent returns food, capability, or model-specific content", () => {
    const forbidden = [
      "vegetarian",
      "vegan",
      "plant-based",
      "broth",
      "legumes",
      "recipes",
      "plans, drafts",
      "running locally",
      "open source",
      "Bonsai",
      "experimental",
      "competitive chat assistant",
      "polished assistant response",
    ];
    const intents: Array<"quick" | "explain" | "deep" | "code" | "writing" | "file" | "research"> = [
      "quick", "explain", "deep", "code", "writing", "file", "research",
    ];
    for (const intent of intents) {
      const result = buildTurnQualityInstruction(intent, true, "local/qwen3-0.6b");
      for (const word of forbidden) {
        expect(result).not.toContain(word);
      }
    }
  });

  it("can use lab-only local model profiles inside validation harnesses", () => {
    expect(
      getGenerationProfile("writing", true, "local/bonsai-1.7b-q1", {
        allowValidationModel: true,
      }),
    ).toMatchObject({
      maxTokens: 512,
      temperature: 0.35,
      topP: 0.8,
      topK: 20,
      repetitionPenalty: 1.07,
      noRepeatNgramSize: 4,
    });
  });

  it("can use lab-only candidate model profiles inside benchmark harnesses", () => {
    // candidate/bitnet-b158 lost its per-model profile when PROFILE_BY_MODEL_ID
    // was trimmed to the v1 catalog. The bitnet family is also out of the v1
    // LocalModelFamily union, so lookup falls through to the baseline path —
    // the harness still resolves a usable profile, just without per-model overrides.
    expect(
      getGenerationProfile("quick", true, "candidate/bitnet-b158", {
        allowValidationModel: true,
      }),
    ).toMatchObject({
      maxTokens: 1024,
      temperature: 0.45,
    });
  });

  it("fails closed for hidden direct local model IDs before prompt-profile generation", () => {
    const hiddenProfile = getGenerationProfile("deep", true, "local/smollm3-3b");
    expect(hiddenProfile).toMatchObject({
      temperature: 0.55,
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

  it("gives deep/code their designed 2048 budgets", () => {
    expect(getGenerationProfile("deep", true, DEFAULT_MODEL).maxTokens).toBe(2048);
    expect(getGenerationProfile("code", true, DEFAULT_MODEL).maxTokens).toBe(2048);
  });

  it("keeps quick at 1024", () => {
    expect(getGenerationProfile("quick", true, DEFAULT_MODEL).maxTokens).toBe(1024);
  });
});

// ─── User-turn hint placement (Wave 2.6 Stage 1) ───────────────────────────
// Hints ride the END of user turns; history re-renders must reproduce them
// byte-identically (the KV strict-prefix contract — see PR #151 for the miss
// class a render asymmetry causes).

describe("user-turn hint placement", () => {
  const MODEL = "candidate/lfm2.5-1.2b-instruct-onnx";

  it("appends the per-intent hint after a blank line; empty hints are a no-op", () => {
    const deepHint = buildTurnQualityInstruction("deep", true, MODEL);
    expect(buildHintedUserTurn("give me some tips on negotiating a raise", "deep", true, MODEL))
      .toBe(`give me some tips on negotiating a raise\n\n${deepHint}`);
    // quick has no hint — the turn stays byte-identical.
    expect(buildHintedUserTurn("what is the capital of australia", "quick", true, MODEL))
      .toBe("what is the capital of australia");
  });

  it("applyTurnHints re-derives each user turn from its own text and position", () => {
    const messages = [
      { role: "user" as const, content: "how do i get better at cooking" },
      { role: "assistant" as const, content: "Practice the basics." },
      { role: "user" as const, content: "what is the capital of france" },
    ];
    const hinted = applyTurnHints(messages, true, MODEL);
    const deepHint = buildTurnQualityInstruction("deep", true, MODEL);
    // Turn 1 is teaching-shaped → deep hint appended.
    expect(hinted[0]!.content).toBe(`how do i get better at cooking\n\n${deepHint}`);
    // Assistant turns pass through untouched.
    expect(hinted[1]).toBe(messages[1]);
    // Turn 3 is a single fact → brief → quick → no hint.
    expect(hinted[2]!.content).toBe("what is the capital of france");
  });

  it("re-rendering the same raw history yields identical bytes (KV contract)", () => {
    const messages = [
      { role: "user" as const, content: "walk me through setting up a monthly budget" },
      { role: "assistant" as const, content: "First, list your income." },
      { role: "user" as const, content: "make day 3 harder" },
    ];
    const first = applyTurnHints(messages, true, MODEL);
    const second = applyTurnHints(messages, true, MODEL);
    expect(second).toEqual(first);
  });

  it("position feeds the follow-up guard: first turn vs in-thread", () => {
    // In-thread anaphoric follow-up → brief → quick.
    expect(inferTurnIntent("can you make that one shorter", true)).toBe("quick");
    // Same text opening a conversation → focused → explain.
    expect(inferTurnIntent("can you make that one shorter", false)).toBe("explain");
  });

  it("applyTurnHints is applied to RAW store content exactly once per dispatch", () => {
    // The transform is NOT idempotent by design (re-applying would re-append).
    // This pin documents the architecture: always transform from raw
    // apiMessages, never from already-hinted content.
    const messages = [{ role: "user" as const, content: "how do i get better at cooking" }];
    const once = applyTurnHints(messages, true, MODEL);
    const twice = applyTurnHints(once, true, MODEL);
    expect(twice[0]!.content).not.toBe(once[0]!.content);
  });
});

// ─── Hint suppression on explicit instructions (gates-run finding) ──────────

describe("hint suppression on explicit format instructions", () => {
  const MODEL = "candidate/lfm2.5-1.2b-instruct-onnx";

  it("never appends a hint after an explicit format/length instruction", () => {
    // Measured (wave26-stage1-gates, if3/LFM): a hint AFTER the instruction
    // wins by recency and broke "in exactly one sentence" into six. The
    // user's instruction is inviolable — the hint yields, whatever the intent.
    const ask = "Answer in exactly one sentence: why is the sky blue?";
    expect(buildHintedUserTurn(ask, "explain", true, MODEL)).toBe(ask);
    expect(buildHintedUserTurn(ask, "deep", true, MODEL)).toBe(ask);

    const teachingWithFormat = "give me tips on negotiating a raise, keep it short";
    expect(buildHintedUserTurn(teachingWithFormat, "deep", true, MODEL)).toBe(teachingWithFormat);
  });

  it("suppression flows through applyTurnHints history re-renders", () => {
    const messages = [
      { role: "user" as const, content: "explain photosynthesis in 2 sentences" },
      { role: "assistant" as const, content: "Plants convert light to energy. That fuels growth." },
      { role: "user" as const, content: "how do i get better at cooking" },
    ];
    const hinted = applyTurnHints(messages, true, MODEL);
    // The instruction turn stays raw on re-render…
    expect(hinted[0]!.content).toBe("explain photosynthesis in 2 sentences");
    // …while the ordinary teaching turn still gets its hint.
    expect(hinted[2]!.content).toContain("\n\n");
  });
});

// ─── Social-turn hint suppression (root cause #1: greeting instruction-echo) ─
// A social turn (greeting/thanks/ack/farewell) carries no task to apply a
// hint to, so appending one is nonsense — and the Gemma-LiteRT quick hint made
// the model parrot the instruction on "Hello". The hint is suppressed for
// social turns on EVERY model; the suppression is a pure function of the turn's
// own text, so the KV re-render contract holds. This is root cause #1 from the
// prompt-persona quality pass.

describe("social-turn hint suppression", () => {
  const DEFAULT_MODEL = "candidate/lfm2.5-1.2b-instruct-onnx";
  const GEMMA_LITERT = "candidate/gemma-4-e2b-litert";

  it.each([DEFAULT_MODEL, GEMMA_LITERT])(
    "never appends a hint to a social turn for %s",
    (modelId) => {
      for (const social of ["Hello", "hi", "thanks!", "good morning", "ok cool", "bye"]) {
        expect(buildHintedUserTurn(social, "quick", true, modelId), social).toBe(social);
      }
    },
  );

  it("Gemma-LiteRT would otherwise append its non-empty quick hint — social is what suppresses it", () => {
    // The regression: the Gemma quick hint is non-empty, so without the social
    // guard "Hello" would become "Hello\n\n<instruction>" and the model echoes it.
    const factualQuick = "who wrote the great gatsby";
    // A genuine factual-quick ask KEEPS the Gemma hint (do not weaken it).
    expect(buildHintedUserTurn(factualQuick, "quick", true, GEMMA_LITERT)).toContain("\n\n");
    // …while the greeting is left untouched.
    expect(buildHintedUserTurn("Hello", "quick", true, GEMMA_LITERT)).toBe("Hello");
  });

  it("social suppression flows through applyTurnHints and re-renders byte-identically", () => {
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi! How can I help?" },
      { role: "user" as const, content: "how do i get better at cooking" },
      { role: "assistant" as const, content: "Practice the basics." },
      { role: "user" as const, content: "thanks!" },
    ];
    const first = applyTurnHints(messages, true, GEMMA_LITERT);
    // Social turns pass through untouched (identity, not a new object).
    expect(first[0]).toBe(messages[0]);
    expect(first[4]).toBe(messages[4]);
    // The teaching turn still gets its hint.
    expect(first[2]!.content).toContain("\n\n");
    // Re-rendering the same raw history yields identical bytes (KV contract).
    const second = applyTurnHints(messages, true, GEMMA_LITERT);
    expect(second).toEqual(first);
  });
});
