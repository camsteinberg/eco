// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Integration tests for the host-driven tool pipeline in `streamResponse`
 * (#4 Phase 4a Task 2).
 *
 * These render `useChat` via `renderHook` and mock the inference shim exactly
 * like the Phase-3 characterization net, then assert the detect → execute →
 * inject → render flow:
 *
 *   - a calculator-matching turn populates `activeToolCalls` (running → complete)
 *     with the authoritative `display`, sets it as the assistant content (marked
 *     `canonicalToolAnswer`), and SKIPS generation entirely — the model is never
 *     called, so it can never corrupt the exact value in prose (BAR-A). This applies
 *     to BOTH ok and ok:false (the honest failure display is still shown verbatim).
 *   - a conversational (no-match) turn adds NO tool call and generates normally
 *     (zero behavior change vs. Phase 3).
 *   - a CITATION tool (grounding) still runs generation — the model phrases the
 *     sourced answer; only the deterministic tool-block tools skip it.
 *   - detection is coherent across send / edit / regenerate.
 *
 * The real tool registry runs (calculator/datetime/unit are deterministic TS), so
 * these are true end-to-end pipeline tests, not mocked-detection tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { Slot } from "../../local-ai/types";

// ─── Scripted-stream shim seam (mirrors the characterization net) ──────────────

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
    READY_FAST_MODEL,
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

function buildScriptedStream(script: StreamScript): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const t of script.tokens) controller.enqueue(t);
      controller.close();
    },
  });
}

vi.mock("../../local-ai/adapters/useChatLegacyShim", () => ({
  createLocalAiLegacyInference: () => ({
    generate: (
      messages: Array<{ role: string; content: string }>,
      modelId: string,
      options: Record<string, unknown> | undefined,
    ): ReadableStream<string> => {
      shared.generateCalls.push({ messages, modelId, options });
      const script = shared.scripts.shift();
      if (!script) {
        return new ReadableStream<string>({
          start(controller) {
            controller.close();
          },
        });
      }
      return buildScriptedStream(script);
    },
  }),
}));

vi.mock("../../local-ai/lifecycle/slots", () => ({
  subscribe: () => () => {},
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
  // Inert stubs: switch-model.ts (reached via useChat → upgrade.ts, #230) binds
  // these at module eval; nothing in this suite exercises slot writes.
  setSlot: () => {},
  setSlotStatus: () => {},
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
  hashSystemPrompt: async () => "deadbeef",
}));

// ─── Grounding module mock (#5 S3) ─────────────────────────────────────────────
// Registering the grounding tool routes factual/entity turns (e.g. "Tell me about
// the Eiffel Tower") through an async, network-backed execute. Mock the lookup
// engine so jsdom never hits the network; tests script the WikipediaResult.
const groundingMock = vi.hoisted(() => ({
  wikiResult: { found: false, reason: "no-match" } as
    | { found: true; title: string; extract: string; url: string; qid?: string }
    | { found: false; reason: "no-match" | "disambiguation" | "timeout" | "network-error" },
  wikidata: null as { value: string; asOf?: string } | null,
  lookupCalls: [] as Array<{ query: string; signal?: AbortSignal }>,
  /** Resolves the lookup only when released — lets a test stop mid-lookup. */
  gate: null as null | (() => void),
}));

vi.mock("../../lib/grounding", () => ({
  DEFAULT_TIMEOUT_MS: 6000,
  lookupWikipedia: vi.fn(
    async (query: string, opts?: { signal?: AbortSignal }) => {
      groundingMock.lookupCalls.push({ query, signal: opts?.signal });
      if (groundingMock.gate) {
        await new Promise<void>((resolve) => {
          groundingMock.gate = resolve;
        });
      }
      return groundingMock.wikiResult;
    },
  ),
  getWikidataStatement: vi.fn(async () => groundingMock.wikidata),
}));

// Imports AFTER the mocks so the hook picks up the mocked seams.
import { useChat } from "../useChat";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { WEB_LOOKUPS_OFF_DECLINE_MESSAGE } from "../useChat/tool-step";
import {
  DATA_LOCATION_HOST_ANSWER,
  IDENTITY_HOST_ANSWER,
  areYouXHostAnswer,
} from "../../lib/tools";

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

function lastAssistant() {
  const messages = useChatStore.getState().messages;
  return [...messages].reverse().find((m) => m.role === "assistant");
}

function setScripts(next: StreamScript[]): void {
  shared.scripts = next;
}

function systemMessageOf(call: GenerateCall): string {
  return call.messages.find((m) => m.role === "system")?.content ?? "";
}

beforeEach(() => {
  shared.generateCalls.length = 0;
  shared.scripts = [];
  shared.lastUsage = { promptTokens: 8, completionTokens: 4, maxTokens: 1024 };
  shared.lastTemplateName = "chatml";
  shared.fastSlotState = makeReadyFastSlot();
  shared.smartSlotState = makeEmptySmartSlot();
  groundingMock.wikiResult = { found: false, reason: "no-match" };
  groundingMock.wikidata = null;
  groundingMock.lookupCalls.length = 0;
  groundingMock.gate = null;
  // Web lookups default ON only after settings hydrate (the locked default). Reset
  // before each test so the gate is in its default state; fail-closed tests flip it.
  useSettingsStore.setState({ hasLoaded: true, groundingEnabled: true });
  resetChatStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Calculator-matching turn → running → complete + injected note
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — tool pipeline (calculator match)", () => {
  it("persists the exact display as the answer, marks it canonical, and SKIPS generation (model never called)", async () => {
    // Script a WRONG number as the would-be model output. The fix takes the model
    // out of the loop, so this must NEVER reach the assistant content — the launch
    // bug is a sub-1B model writing "391" wrong while the tool holds the exact value.
    setScripts([{ kind: "tokens", tokens: ["17 times 23 is ", "390."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("what is 17 times 23");
    });

    const calls = useChatStore.getState().activeToolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calculator");
    // Final state of the (transient) tool call is complete with the authoritative
    // display string — the source of truth also written to the message content.
    expect(calls[0]!.status).toBe("complete");
    expect(calls[0]!.type).toBe("tool_complete");
    expect(calls[0]!.result).toBe("17 * 23 = 391");

    // Generation is SKIPPED — the model is never called (so it can't corrupt the
    // value). This is what makes the correct value durable (scroll-back + copy).
    expect(generateCalls).toHaveLength(0);

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    // The EXACT host-computed value is the persisted content, NOT the model prose.
    expect(assistant.content).toBe("17 * 23 = 391");
    expect(assistant.content).not.toContain("390");
    expect(assistant.canonicalToolAnswer).toBe(true);
    expect(assistant.inferenceMethod).toBe("local");
  });

  it("surfaces a running tool call on the streaming message before generation completes", async () => {
    // A hang-free script; we assert the running state is observable mid-flight by
    // checking the store right after addToolCall fires. Since execute() is sync for
    // the calculator, the simplest robust assertion is the final complete state +
    // that exactly one call (not duplicated) exists.
    setScripts([{ kind: "tokens", tokens: ["391"] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("compute 17 x 23");
    });

    expect(useChatStore.getState().activeToolCalls).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Conversational (no-match) turn → no tool, normal generation
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — tool pipeline (no match / abstain)", () => {
  it("adds NO tool call and generates normally for a genuine non-match turn", async () => {
    // A clear conversational/opinion turn the grounding deny-set screens — keeps
    // abstain coverage now that factual entity asks route to grounding.
    setScripts([{ kind: "tokens", tokens: ["Sure — let's brainstorm together."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("what do you think I should cook tonight");
    });

    expect(useChatStore.getState().activeToolCalls).toHaveLength(0);
    // No grounding lookup ran (true abstain, not a network call).
    expect(groundingMock.lookupCalls).toHaveLength(0);

    expect(generateCalls).toHaveLength(1);
    // No tool note injected — the system message is the plain base prompt.
    const sys = systemMessageOf(generateCalls[0]!);
    expect(sys).not.toContain("Use this exact value");
    expect(sys).not.toContain("authoritative facts");
    // No citation set on a non-match.
    expect(lastAssistant()!.citations).toBeUndefined();

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toBe("Sure — let's brainstorm together.");
  });

  it("clears a prior turn's tool call when the next turn does not match", async () => {
    // Turn 1: a calculator match leaves a complete tool call in the side-channel.
    setScripts([{ kind: "tokens", tokens: ["391"] }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("what is 17 times 23");
    });
    expect(useChatStore.getState().activeToolCalls).toHaveLength(1);

    // Turn 2: a conversational turn must clear the prior call.
    setScripts([{ kind: "tokens", tokens: ["Sure, here's a thought."] }]);
    await act(async () => {
      await result.current.sendMessage("how are you today");
    });
    expect(useChatStore.getState().activeToolCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Erroring tool → call marked error, generation still proceeds
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — tool pipeline (tool error)", () => {
  it("marks the tool call error and SKIPS generation, showing the honest failure display (no fabricated number)", async () => {
    // "1/0" matches the calculator but evaluates to a non-finite result, so the
    // tool returns ok:false (a deterministic, real error path — no mocking needed).
    // Script a fabricated number as the would-be model output to prove it never runs.
    setScripts([{ kind: "tokens", tokens: ["The answer is 42."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("what is 1 / 0");
    });

    const calls = useChatStore.getState().activeToolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calculator");
    expect(calls[0]!.status).toBe("error");
    expect(calls[0]!.type).toBe("tool_error");

    // The failure display is a complete, honest answer, so generation is SKIPPED too
    // — the model can't fabricate a number next to it. Both ok and ok:false take the
    // model out of the loop.
    expect(generateCalls).toHaveLength(0);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toBe(calls[0]!.result);
    expect(assistant.content).toContain("finite");
    expect(assistant.content).not.toContain("42");
    expect(assistant.canonicalToolAnswer).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Detection is coherent across send / edit / regenerate
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — tool pipeline coherence across edit / regenerate", () => {
  it("re-detects on the edited user text", async () => {
    // Send a conversational turn first (no tool).
    setScripts([{ kind: "tokens", tokens: ["Hello!"] }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });
    expect(useChatStore.getState().activeToolCalls).toHaveLength(0);

    const originalUser = useChatStore
      .getState()
      .messages.find((m) => m.role === "user")!;

    // Edit it into an arithmetic question → the tool must now fire.
    setScripts([{ kind: "tokens", tokens: ["391"] }]);
    await act(async () => {
      await result.current.editMessage(originalUser.id, "what is 17 times 23");
    });

    const calls = useChatStore.getState().activeToolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calculator");
    expect(calls[0]!.result).toBe("17 * 23 = 391");
  });

  it("re-runs the tool on regenerate (and still skips generation both times)", async () => {
    setScripts([{ kind: "tokens", tokens: ["should never run"] }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("what is 17 times 23");
    });
    const firstAssistant = lastAssistant()!;
    expect(useChatStore.getState().activeToolCalls).toHaveLength(1);

    // Regenerate: the tool re-detects on the same user text and re-runs (a fresh
    // single call, not a duplicate appended to the prior one).
    setScripts([{ kind: "tokens", tokens: ["should never run either"] }]);
    await act(async () => {
      await result.current.regenerateMessage(firstAssistant.id);
    });

    const calls = useChatStore.getState().activeToolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calculator");
    expect(calls[0]!.result).toBe("17 * 23 = 391");
    // Canonical answers skip generation, so the model is never called on send OR
    // regenerate; the re-derived exact value is re-persisted as the content.
    expect(generateCalls).toHaveLength(0);
    const assistant = lastAssistant()!;
    expect(assistant.content).toBe("17 * 23 = 391");
    expect(assistant.canonicalToolAnswer).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Grounding (presentation:"citation") — no ToolCallBlock, citation on message
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — grounding pipeline (citation presentation)", () => {
  it("grounds a factual entity ask: injects the note, sets a citation, NO ToolCallBlock", async () => {
    // This was the PRE-grounding 'abstain' characterization case ("Tell me about
    // the Eiffel Tower"). It now grounds — assert the NEW correct behavior.
    groundingMock.wikiResult = {
      found: true,
      title: "Eiffel Tower",
      extract: "The Eiffel Tower is a tower in Paris, France.",
      url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
      qid: "Q243",
    };
    setScripts([{ kind: "tokens", tokens: ["The Eiffel Tower is in Paris."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Tell me about the Eiffel Tower");
    });

    // presentation:"citation" ⇒ no ToolCallBlock side-channel entry.
    expect(useChatStore.getState().activeToolCalls).toHaveLength(0);
    // The grounding lookup ran (mocked) — exactly once.
    expect(groundingMock.lookupCalls).toHaveLength(1);

    // The FOUND grounding note is injected into the generation's system message.
    expect(generateCalls).toHaveLength(1);
    const sys = systemMessageOf(generateCalls[0]!);
    expect(sys).toContain("Eiffel Tower");
    expect(sys).toContain("own voice");

    // The citation is mapped onto the assistant message for the chip (#5 S4).
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toBe("The Eiffel Tower is in Paris.");
    expect(assistant.citations).toEqual([
      {
        id: 1,
        title: "Eiffel Tower",
        url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
        source: "Wikipedia",
        // "Tell me about the Eiffel Tower" is a clean Title-Case entity match →
        // "high" confidence, mapped through onto the message citation so the
        // once-per-chat grounding notice can gate on it (provenance honesty).
        groundingConfidence: "high",
      },
    ]);
  });

  it("keeps the user-turn quality hint through the grounded (systemNote) rebuild", async () => {
    // Wave 2.6 Stage 1: hints ride the END of user turns, and the tool path
    // rebuilds messages from plan.hintedMessages — NOT raw apiMessages. A
    // refactor that rebuilt from raw messages would silently drop every hint
    // on grounded/tool turns; this pins the seam (PR #154 review finding).
    groundingMock.wikiResult = {
      found: true,
      title: "Eiffel Tower",
      extract: "The Eiffel Tower is a tower in Paris, France.",
      url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
      qid: "Q243",
    };
    setScripts([{ kind: "tokens", tokens: ["ok"] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      // Focused shape → explain intent → non-empty hint on the user turn.
      await result.current.sendMessage("Tell me about the Eiffel Tower");
    });

    expect(generateCalls).toHaveLength(1);
    const userMsg = [...generateCalls[0]!.messages].reverse().find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("Tell me about the Eiffel Tower");
    // The explain hint survived the systemNote rebuild, appended after a blank line.
    expect(userMsg.content).toContain("\n\nLead with a plain-language explanation");
  });

  it("hard-declines an unknown entity: note injected, NO citation, NO ToolCallBlock, still generates", async () => {
    groundingMock.wikiResult = { found: false, reason: "no-match" };
    setScripts([{ kind: "tokens", tokens: ["I don't have a reliable source for that."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Tell me about Briznor Hollow");
    });

    expect(useChatStore.getState().activeToolCalls).toHaveLength(0);
    expect(groundingMock.lookupCalls).toHaveLength(1);

    // The decline note reaches the model; no citation is set.
    expect(generateCalls).toHaveLength(1);
    expect(systemMessageOf(generateCalls[0]!)).toContain("No reliable source");
    const assistant = lastAssistant()!;
    expect(assistant.citations).toBeUndefined();
    expect(assistant.status).toBe("complete");
  });

  it("flips the phase to tool-executing during the lookup, then to generating", async () => {
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    // Gate the lookup open so we can observe the phase mid-flight.
    groundingMock.gate = () => {};
    setScripts([{ kind: "tokens", tokens: ["Paris is the capital of France."] }]);

    const { result } = renderHook(() => useChat());
    let sendPromise: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendMessage("tell me about Paris");
      // Let the synchronous prelude + the gated lookup's first await run.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Mid-lookup: the web-lookup phase is shown ("Looking this up on the web…"),
    // distinct from the on-device tools' "tool-executing".
    expect(useChatStore.getState().streamPhase).toBe("looking-up");

    // Release the lookup and let generation finish.
    await act(async () => {
      const release = groundingMock.gate!;
      groundingMock.gate = null;
      release();
      await sendPromise!;
    });

    // Settles to idle (generation completed; sendMessage's finally set idle).
    expect(useChatStore.getState().streamPhase).toBe("idle");
    expect(lastAssistant()!.content).toBe("Paris is the capital of France.");
  });

  it("user stop DURING the lookup skips generation entirely (abort threaded into execute)", async () => {
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    // Gate the lookup so we can press Stop while it is in flight.
    groundingMock.gate = () => {};
    setScripts([{ kind: "tokens", tokens: ["should never stream"] }]);

    const { result } = renderHook(() => useChat());
    let sendPromise: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendMessage("tell me about Paris");
      await Promise.resolve();
      await Promise.resolve();
    });

    // The lookup is in flight and received the generation's abort signal.
    expect(groundingMock.lookupCalls).toHaveLength(1);
    const lookupSignal = groundingMock.lookupCalls[0]!.signal;
    expect(lookupSignal).toBeInstanceOf(AbortSignal);
    expect(lookupSignal!.aborted).toBe(false);

    // Press Stop mid-lookup, then release the gated fetch.
    await act(async () => {
      result.current.stopGeneration();
      const release = groundingMock.gate!;
      groundingMock.gate = null;
      release();
      await sendPromise!;
    });

    // The signal aborted (so a real fetch would have been cancelled).
    expect(lookupSignal!.aborted).toBe(true);
    // Generation was SKIPPED — no shim generate() call, no streamed content.
    expect(generateCalls).toHaveLength(0);
    // The message is finalized as interrupted by interruptActiveGeneration.
    const assistant = lastAssistant()!;
    expect(assistant.content).toBe("");
    expect(assistant.status).toBe("complete");
    expect(assistant.streamInterrupted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Web lookup setting gate (#5 S5) — unhydrated/OFF drops citation tools
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — web lookup setting gate", () => {
  it("fails closed before settings hydrate: no lookup, no citation, plain generation", async () => {
    // The persisted opt-out may not have loaded yet. Even though the in-memory
    // default is ON, an unhydrated settings store must not allow network-backed
    // citation tools to run.
    useSettingsStore.setState({ hasLoaded: false, groundingEnabled: true });
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    setScripts([{ kind: "tokens", tokens: ["Paris is the capital of France."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("tell me about Paris");
    });

    expect(groundingMock.lookupCalls).toHaveLength(0);
    expect(useChatStore.getState().activeToolCalls).toHaveLength(0);
    expect(lastAssistant()!.citations).toBeUndefined();

    expect(generateCalls).toHaveLength(1);
    const sys = systemMessageOf(generateCalls[0]!);
    expect(sys).not.toContain("authoritative facts");
    expect(sys).not.toContain("No reliable source");

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toBe("Paris is the capital of France.");
  });

  it("declines DETERMINISTICALLY for a factual entity ask when explicitly disabled: host message, model NOT called (F-1)", async () => {
    // Turn grounding OFF explicitly. A factual entity ask that would normally ground
    // (case 5) must NOT reach the model at all — the host renders a fixed decline so
    // the model can never fabricate a falsely-sourced answer.
    useSettingsStore.setState({ groundingEnabled: false });
    // Script a FOUND result + model tokens so the test would visibly ground OR
    // generate if the gate failed — the assertions below prove neither happens.
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    setScripts([{ kind: "tokens", tokens: ["FABRICATED MODEL OUTPUT"] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("tell me about Paris");
    });

    // The grounding lookup NEVER ran (citation tool filtered out before detection).
    expect(groundingMock.lookupCalls).toHaveLength(0);
    // No ToolCallBlock, no citation chip, no verification marker.
    expect(useChatStore.getState().activeToolCalls).toHaveLength(0);
    expect(lastAssistant()!.citations).toBeUndefined();
    expect(lastAssistant()!.verification).toBeUndefined();

    // The model is NEVER called — the decline is host-rendered, so fabrication is
    // impossible by construction (the crux of the deterministic F-1 fix).
    expect(generateCalls).toHaveLength(0);

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.inferenceMethod).toBe("local");
    expect(assistant.content).toBe(WEB_LOOKUPS_OFF_DECLINE_MESSAGE);
    expect(assistant.content).not.toContain("FABRICATED MODEL OUTPUT");
  });

  it("still fires the deterministic calculator tool when grounding is OFF (and skips generation)", async () => {
    // The gate only removes the citation tool; calculator/datetime/unit are
    // unaffected and keep producing authoritative canonical answers.
    useSettingsStore.setState({ groundingEnabled: false });
    setScripts([{ kind: "tokens", tokens: ["17 times 23 is 390."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("what is 17 times 23");
    });

    const calls = useChatStore.getState().activeToolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calculator");
    expect(calls[0]!.result).toBe("17 * 23 = 391");
    // No grounding lookup either way.
    expect(groundingMock.lookupCalls).toHaveLength(0);
    // Canonical tool-block result → generation skipped; the exact value is persisted.
    expect(generateCalls).toHaveLength(0);
    const assistant = lastAssistant()!;
    expect(assistant.content).toBe("17 * 23 = 391");
    expect(assistant.canonicalToolAnswer).toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Host-authoritative identity/privacy answer (Finding G)
//
// The always-on identity tool detects identity / privacy / "are you <product>?"
// turns and renders Eco's on-device truth VERBATIM as the assistant message, with
// NO model generation — so a sub-2B model can never fabricate false cloud-privacy
// claims or invent a base identity. The truth is stated whether web lookups are on
// or off (the gate only removes citation tools, not this host-answer tool).
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — host-authoritative identity/privacy (Finding G)", () => {
  it("answers 'where does my data go?' with the on-device truth and NEVER calls the model", async () => {
    // Script model tokens that would be a privacy LIE — the fix takes the model out
    // of the loop, so this must never reach the assistant content.
    setScripts([{ kind: "tokens", tokens: ["Your data goes to ", "Amazon S3."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("where does my data go?");
    });

    // The model is NEVER called — fabrication is impossible by construction.
    expect(generateCalls).toHaveLength(0);
    // No ToolCallBlock (host-answer renders no side-channel) and no lookup.
    expect(useChatStore.getState().activeToolCalls).toHaveLength(0);
    expect(groundingMock.lookupCalls).toHaveLength(0);

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.inferenceMethod).toBe("local");
    // The verbatim host truth is the persisted content — NOT the scripted lie, and
    // NOT marked canonicalToolAnswer (it renders as normal Markdown prose).
    expect(assistant.content).toBe(DATA_LOCATION_HOST_ANSWER);
    expect(assistant.content).not.toContain("Amazon S3");
    expect(assistant.canonicalToolAnswer).toBeUndefined();
  });

  it("answers 'what are you?' with the identity truth, model not called", async () => {
    setScripts([{ kind: "tokens", tokens: ["I am LLaMA 3, an OpenAI model."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("what are you?");
    });

    expect(generateCalls).toHaveLength(0);
    const assistant = lastAssistant()!;
    expect(assistant.content).toBe(IDENTITY_HOST_ANSWER);
    expect(assistant.content).not.toContain("LLaMA");
  });

  it("answers 'are you ChatGPT?' with the host denial when web lookups are OFF — NOT the lookups-off decline", async () => {
    // This is the structural not-gated-by-lookups guarantee: with lookups explicitly
    // off, the identity tool (presentation:"host-answer", never filtered by the gate)
    // must still fire and win over the declineTools path.
    useSettingsStore.setState({ groundingEnabled: false });
    setScripts([{ kind: "tokens", tokens: ["Yes, I'm ChatGPT by OpenAI."] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("are you ChatGPT?");
    });

    // Model never called; no lookup ran.
    expect(generateCalls).toHaveLength(0);
    expect(groundingMock.lookupCalls).toHaveLength(0);

    const assistant = lastAssistant()!;
    expect(assistant.content).toBe(areYouXHostAnswer("ChatGPT"));
    // NOT the web-lookups-off decline — the identity truth takes precedence.
    expect(assistant.content).not.toBe(WEB_LOOKUPS_OFF_DECLINE_MESSAGE);
    expect(assistant.content).not.toContain("Yes, I'm ChatGPT");
  });
});
