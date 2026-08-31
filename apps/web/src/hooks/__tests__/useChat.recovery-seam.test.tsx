// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The per-generation recovery seam: `streamResponse`'s `intent` /
 * `turnDirective` overrides and `regenerateMessage(id, overrides?)`.
 *
 * These render `useChat` via `renderHook` and mock the inference shim exactly
 * like the Phase-3 characterization net, then assert what reaches the model:
 *
 *   - with NO overrides the composed request is byte-identical to the one the
 *     ordinary send path produces (the baseline is captured in-test from a real
 *     dispatch, not from a stored snapshot);
 *   - a forced intent resolves generation options through the REAL per-model
 *     profile machinery for that intent (expected values are computed by
 *     calling it here, never transcribed);
 *   - a directive lands exactly once at the end of the final user turn;
 *   - nothing the directive adds is ever persisted;
 *   - sibling semantics (same parentId) are unchanged when overrides are passed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { Slot } from "../../local-ai/types";

// ─── Scripted-stream shim seam (mirrors the characterization net) ──────────

type GenerateCall = {
  messages: Array<{ role: string; content: string }>;
  modelId: string;
  options: Record<string, unknown> | undefined;
};

type StreamScript = { kind: "tokens"; tokens: string[] };

const shared = vi.hoisted(() => {
  const TEST_MODEL_ID = "candidate/lfm2.5-1.2b-instruct-onnx";
  const READY_FAST_MODEL = {
    id: TEST_MODEL_ID,
    friendlyName: "Eco Fast (test)",
  } as unknown as SlotState["model"];

  function makeReadyFastSlot(): SlotState {
    return {
      slot: "eco-fast" as Slot,
      modelId: TEST_MODEL_ID,
      model: READY_FAST_MODEL,
      status: "ready",
    };
  }

  function makeEmptySmartSlot(): SlotState {
    return {
      slot: "eco-smart" as Slot,
      modelId: null,
      model: null,
      status: "empty",
    };
  }

  return {
    TEST_MODEL_ID,
    makeReadyFastSlot,
    makeEmptySmartSlot,
    generateCalls: [] as GenerateCall[],
    scripts: [] as StreamScript[],
    lastUsage: null as
      | { promptTokens?: number; completionTokens?: number; maxTokens?: number }
      | null,
    lastTemplateName: null as string | null,
    fastSlotState: undefined as SlotState | undefined,
    smartSlotState: undefined as SlotState | undefined,
  };
});

const TEST_MODEL_ID = shared.TEST_MODEL_ID;
const makeReadyFastSlot = shared.makeReadyFastSlot;
const makeEmptySmartSlot = shared.makeEmptySmartSlot;
const generateCalls = shared.generateCalls;

vi.mock("../../local-ai/adapters/useChatLegacyShim", () => ({
  createLocalAiLegacyInference: () => ({
    generate: (
      messages: Array<{ role: string; content: string }>,
      modelId: string,
      options: Record<string, unknown> | undefined,
    ): ReadableStream<string> => {
      shared.generateCalls.push({ messages, modelId, options });
      const script = shared.scripts.shift();
      const tokens = script?.tokens ?? [];
      return new ReadableStream<string>({
        start(controller) {
          for (const t of tokens) controller.enqueue(t);
          controller.close();
        },
      });
    },
  }),
}));

vi.mock("../../local-ai/lifecycle/slots", () => ({
  SLOTS: ["eco-fast", "eco-smart"] as ReadonlyArray<Slot>,
  getSlot: (slot: Slot): SlotState => {
    shared.fastSlotState ??= shared.makeReadyFastSlot();
    shared.smartSlotState ??= shared.makeEmptySmartSlot();
    return slot === "eco-fast" ? shared.fastSlotState : shared.smartSlotState;
  },
  getSlotForModel: (modelId: string): Slot | null =>
    modelId === shared.TEST_MODEL_ID ? ("eco-fast" as Slot) : null,
  hasReadySlot: () => {
    shared.fastSlotState ??= shared.makeReadyFastSlot();
    return shared.fastSlotState.status === "ready";
  },
  setSlotStorage: () => {},
  setSlot: () => {},
  setSlotStatus: () => {},
  subscribe: () => () => {},
  getDemotedFrom: () => undefined,
}));

vi.mock("../../local-ai/runtime/usage-store", () => ({
  getLastUsage: () => shared.lastUsage,
  getLastTemplateName: () => shared.lastTemplateName,
  setLastUsage: (u: typeof shared.lastUsage) => {
    shared.lastUsage = u;
  },
  setLastTemplateName: (n: string | null) => {
    shared.lastTemplateName = n;
  },
  ranToCapFromUsage: (u: { completionTokens?: number; maxTokens?: number } | null | undefined) =>
    u?.completionTokens != null
    && u.maxTokens != null
    && u.maxTokens > 0
    && u.completionTokens >= u.maxTokens,
}));

vi.mock("../../local-ai/lifecycle/generation-receipt", () => ({
  recordGenerationReceipt: () => {},
  recordGenerationReceiptAsync: () => {},
  hashSystemPrompt: async () => "deadbeef",
}));

// Imports AFTER the mocks so the hook picks up the mocked seams.
import { useChat } from "../useChat";
import { useChatStore } from "../../stores/chatStore";
import {
  getGenerationProfile,
  type ChatIntent,
} from "../../lib/chat-intent";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const SUPPRESSING_DIRECTIVE = "Keep it short. Lead with the answer itself.";
const NON_SUPPRESSING_DIRECTIVE = "Be concise.";

const HINTED_PROMPT = "why do leaves change colour in the autumn";

// ─── Helpers ───────────────────────────────────────────────────────────────

function resetChatStore(): void {
  useChatStore.setState({
    messages: [],
    composerDraft: "",
    streamPhase: "idle",
    isStreaming: false,
    error: null,
    selectedModel: TEST_MODEL_ID,
    fileAttachments: [],
    approvedTools: [],
    activeToolCalls: [],
    localToolNoticeShown: false,
    routeRecommendationSnapshot: null,
  });
}

function setScripts(next: StreamScript[]): void {
  shared.scripts = next;
}

function lastAssistant() {
  const messages = useChatStore.getState().messages;
  return [...messages].reverse().find((m) => m.role === "assistant");
}

/** The composed request as the model sees it, minus the non-serializable hook. */
function dispatched(index: number): {
  messages: Array<{ role: string; content: string }>;
  options: Record<string, unknown>;
} {
  const call = generateCalls[index]!;
  const { onLifecycleEvent: _drop, ...options } = call.options ?? {};
  return { messages: call.messages, options };
}

function finalUserTurn(index: number): string {
  const { messages } = dispatched(index);
  return [...messages].reverse().find((m) => m.role === "user")!.content;
}

/**
 * What the REAL per-model profile machinery resolves for an intent, in the
 * option shape `buildLocalGenerationOptions` emits. Computed here rather than
 * transcribed so a profile change moves the expectation with it.
 */
function expectedOptionsFor(intent: ChatIntent): Record<string, unknown> {
  const profile = getGenerationProfile(intent, true, TEST_MODEL_ID);
  return {
    max_new_tokens: profile.maxTokens,
    temperature: profile.temperature,
    ...(profile.topP != null && { top_p: profile.topP }),
    ...(profile.topK != null && { top_k: profile.topK }),
    ...(profile.repetitionPenalty != null && { repetition_penalty: profile.repetitionPenalty }),
    ...(profile.noRepeatNgramSize != null && { no_repeat_ngram_size: profile.noRepeatNgramSize }),
  };
}

/** User turns pass through unchanged (per-turn hints removed in R1). */
function renderTurn(text: string): string {
  return text;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Send one prompt and regenerate the reply, so the caller can compare the
 * regenerate dispatch (call 1) against the send dispatch (call 0).
 */
async function sendThenRegenerate(
  prompt: string,
  overrides?: Parameters<ReturnType<typeof useChat>["regenerateMessage"]>[1],
): Promise<{ firstAssistantId: string }> {
  setScripts([{ kind: "tokens", tokens: ["first"] }, { kind: "tokens", tokens: ["second"] }]);
  const { result } = renderHook(() => useChat());
  await act(async () => {
    await result.current.sendMessage(prompt);
  });
  const first = lastAssistant()!;
  await act(async () => {
    await result.current.regenerateMessage(first.id, overrides);
  });
  return { firstAssistantId: first.id };
}

beforeEach(() => {
  shared.generateCalls.length = 0;
  shared.scripts = [];
  shared.lastUsage = null;
  shared.lastTemplateName = null;
  shared.fastSlotState = makeReadyFastSlot();
  shared.smartSlotState = makeEmptySmartSlot();
  resetChatStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════
// The fixture itself
// ═════════════════════════════════════════════════════════════════════════

describe("recovery seam — the instrument", () => {
  it("user turns pass through unchanged (no per-turn hints)", () => {
    expect(renderTurn(HINTED_PROMPT)).toBe(HINTED_PROMPT);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 1. No overrides ⇒ byte-identical to the ordinary path
// ═════════════════════════════════════════════════════════════════════════

describe("recovery seam — no overrides changes nothing", () => {
  it("regenerating with no options composes exactly what the send path composed", async () => {
    await sendThenRegenerate(HINTED_PROMPT);

    expect(generateCalls).toHaveLength(2);
    const baseline = dispatched(0);
    const regenerated = dispatched(1);
    // Byte-for-byte: same system prompt, same rendered turns, same sampling.
    expect(regenerated.messages).toEqual(baseline.messages);
    expect(regenerated.options).toEqual(baseline.options);
    expect(finalUserTurn(1)).toBe(renderTurn(HINTED_PROMPT));
  });

  it("passing an empty override object is the same as passing none", async () => {
    await sendThenRegenerate(HINTED_PROMPT, {});

    const baseline = dispatched(0);
    const regenerated = dispatched(1);
    expect(regenerated.messages).toEqual(baseline.messages);
    expect(regenerated.options).toEqual(baseline.options);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Forced intent ⇒ the real profile's resolution for that intent
// ═════════════════════════════════════════════════════════════════════════

describe("recovery seam — forced intent", () => {
  it("resolves generation options through the real profile for the forced intent", async () => {
    // quick vs deep must actually differ on this model, or the assertion below
    // would hold no matter which intent reached the profile.
    expect(expectedOptionsFor("quick")).not.toEqual(expectedOptionsFor("deep"));

    await sendThenRegenerate(HINTED_PROMPT, { intent: "quick" });
    expect(dispatched(1).options).toEqual(expectedOptionsFor("quick"));

    generateCalls.length = 0;
    resetChatStore();
    await sendThenRegenerate(HINTED_PROMPT, { intent: "deep" });
    expect(dispatched(1).options).toEqual(expectedOptionsFor("deep"));
  });

  it("leaves the composed messages alone — only sampling moves", async () => {
    await sendThenRegenerate(HINTED_PROMPT, { intent: "quick" });

    // Forcing an intent must not change the composed messages.
    expect(dispatched(1).messages).toEqual(dispatched(0).messages);
    expect(finalUserTurn(1)).toBe(renderTurn(HINTED_PROMPT));
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Directive placement
// ═════════════════════════════════════════════════════════════════════════

describe("recovery seam — turn directive", () => {
  it("lands exactly once at the end of the final user turn", async () => {
    await sendThenRegenerate(HINTED_PROMPT, { turnDirective: SUPPRESSING_DIRECTIVE });

    const turn = finalUserTurn(1);
    expect(turn).toBe(`${HINTED_PROMPT}\n\n${SUPPRESSING_DIRECTIVE}`);
    expect(countOccurrences(turn, SUPPRESSING_DIRECTIVE)).toBe(1);
  });

  it("appends the directive after the prompt text", async () => {
    await sendThenRegenerate(HINTED_PROMPT, { turnDirective: NON_SUPPRESSING_DIRECTIVE });

    const composed = `${HINTED_PROMPT}\n\n${NON_SUPPRESSING_DIRECTIVE}`;
    const turn = finalUserTurn(1);
    expect(turn).toBe(composed);
    expect(countOccurrences(turn, NON_SUPPRESSING_DIRECTIVE)).toBe(1);
  });

  it("leaves the system prompt and every earlier turn untouched", async () => {
    await sendThenRegenerate(HINTED_PROMPT, { turnDirective: SUPPRESSING_DIRECTIVE });

    const baseline = dispatched(0).messages;
    const withDirective = dispatched(1).messages;
    expect(withDirective).toHaveLength(baseline.length);
    expect(withDirective[0]).toEqual(baseline[0]); // system
    expect(withDirective.slice(0, -1)).toEqual(baseline.slice(0, -1));
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. The directive is never persisted
// ═════════════════════════════════════════════════════════════════════════

describe("recovery seam — persistence", () => {
  it("writes no directive text into the stored conversation", async () => {
    await sendThenRegenerate(HINTED_PROMPT, { turnDirective: SUPPRESSING_DIRECTIVE });

    // It reached the model on this one generation...
    expect(finalUserTurn(1)).toContain(SUPPRESSING_DIRECTIVE);
    // ...and nowhere else. The stored user turn is what the user typed.
    const stored = useChatStore.getState().messages;
    expect(stored.some((m) => m.content.includes(SUPPRESSING_DIRECTIVE))).toBe(false);
    expect(stored.find((m) => m.role === "user")!.content).toBe(HINTED_PROMPT);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Sibling semantics survive the overrides
// ═════════════════════════════════════════════════════════════════════════

describe("recovery seam — sibling semantics", () => {
  it("still produces a sibling with the same parentId when overrides are passed", async () => {
    const { firstAssistantId } = await sendThenRegenerate(HINTED_PROMPT, {
      intent: "quick",
      turnDirective: SUPPRESSING_DIRECTIVE,
    });

    const userMessage = useChatStore.getState().messages.find((m) => m.role === "user")!;
    const regenerated = lastAssistant()!;
    expect(regenerated.id).not.toBe(firstAssistantId);
    // Both assistants hang off the same user turn — a sibling, not a replacement.
    expect(regenerated.parentId).toBe(userMessage.id);
    expect(regenerated.content).toBe("second");
    expect(regenerated.status).toBe("complete");
  });
});
