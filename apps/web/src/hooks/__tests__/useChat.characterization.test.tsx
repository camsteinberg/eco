// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Characterization safety net for the on-device generation hot path
 * (`useChat.ts` / `streamResponse`). #4 Phase 3 Task 1.
 *
 * These tests PIN the CURRENT observable behavior of the generation path so
 * the Task 2 refactor (per-generation object, `runGeneration()` extraction,
 * `streamResponse` split) can prove it changed no behavior. They are written
 * against the CURRENT code and must stay green through the refactor.
 *
 * Strategy:
 *   - Mock the `slots` seam so a concrete local model reads as "ready" (so the
 *     readiness guards pass without a real runtime / WebGPU).
 *   - Mock the `useChatLegacyShim` seam: `createLocalAiLegacyInference()` returns
 *     a `generate()` that emits a SCRIPTED token stream via a real
 *     `ReadableStream<string>`. This exercises the actual reader/cancel path
 *     that `interruptActiveGeneration` depends on.
 *   - Mock the `usage-store` seam so `getLastUsage` / `getLastTemplateName`
 *     return deterministic values for the completion/usage assertions.
 *   - Everything else (chat store, system-prompt, chat-intent, constraints,
 *     receipts) runs real.
 *
 * jsdom note: `requestAnimationFrame` is undefined in jsdom, so the token
 * batcher never auto-flushes during streaming — only the post-loop
 * `flushSync()` flushes. The FINAL content is therefore deterministic because
 * the production code always calls `flushSync()` at the end of every stream.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { LocalInferenceStreamError } from "../../local-ai/runtime/errors";
import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { Slot } from "../../local-ai/types";

// ─── Scripted-stream shim seam ─────────────────────────────────────────────

type GenerateCall = {
  messages: Array<{ role: string; content: string }>;
  modelId: string;
  options: Record<string, unknown> | undefined;
};

/**
 * Controls what each `generate()` call streams. Tests push one
 * `StreamScript` per expected `generate()` invocation (FIFO). A script either
 * yields a list of tokens then closes, or errors after yielding tokens.
 */
type StreamScript =
  | { kind: "tokens"; tokens: string[] }
  | { kind: "error"; tokens: string[]; error: unknown }
  | {
      // A stream that yields its tokens then BLOCKS forever (until cancelled),
      // used to characterize the user-stop / abort path. The onCancel callback
      // fires when the consumer cancels the reader.
      kind: "hang";
      tokens: string[];
      onCancel?: () => void;
    };

/**
 * Shared mutable test state + the slot fixtures live in a `vi.hoisted` block
 * so they are created BEFORE any `vi.mock` factory (which are hoisted to the
 * top) or any imported module evaluates. The chat store reads `getSlot()` /
 * `hasReadySlot()` eagerly at import time, so `TEST_MODEL_ID`, the fixture
 * factories, and the slot state must all already exist by then — top-level
 * `const`/`function` declarations would still be in their temporal dead zone
 * at that point.
 */
const shared = vi.hoisted(() => {
  const TEST_MODEL_ID = "candidate/lfm2.5-1.2b-instruct-onnx";
  const GEMMA_LITERT_MODEL_ID = "candidate/gemma-4-e2b-litert";
  const READY_FAST_MODEL = {
    id: TEST_MODEL_ID,
    friendlyName: "Eco Fast (test)",
  } as unknown as SlotState["model"];
  const READY_GEMMA_MODEL = {
    id: GEMMA_LITERT_MODEL_ID,
    friendlyName: "Gemma E2B LiteRT (test)",
  } as unknown as SlotState["model"];

  function makeReadyFastSlot(): SlotState {
    return {
      slot: "eco-fast" as Slot,
      modelId: TEST_MODEL_ID,
      model: READY_FAST_MODEL,
      status: "ready",
    };
  }

  function makeReadyGemmaSlot(): SlotState {
    return {
      slot: "eco-fast" as Slot,
      modelId: GEMMA_LITERT_MODEL_ID,
      model: READY_GEMMA_MODEL,
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
    GEMMA_LITERT_MODEL_ID,
    READY_FAST_MODEL,
    makeReadyFastSlot,
    makeReadyGemmaSlot,
    makeEmptySmartSlot,
    generateCalls: [] as GenerateCall[],
    scripts: [] as StreamScript[],
    recordedReceipts: [] as Array<{
      status: string;
      generationId: string;
      generationRole?: string;
      errorCode?: string;
      systemPromptHash?: string;
      samplingProfile?: Record<string, unknown>;
      events?: Array<{ at: number; phase: string }>;
      ranToCap?: boolean;
      maxInterTokenGapMs?: number | null;
    }>,
    lastUsage: null as
      | {
          promptTokens?: number;
          completionTokens?: number;
          maxTokens?: number;
          maxInterTokenGapMs?: number | null;
        }
      | null,
    lastTemplateName: null as string | null,
    contextSafetyCalls: [] as Array<{
      modelContextLength: number;
      requestedNewTokens: number;
    }>,
    fastSlotState: undefined as SlotState | undefined,
    smartSlotState: undefined as SlotState | undefined,
  };
});

// Top-level aliases for readability in the test bodies (safe — these read the
// hoisted values, which are initialized before any test body runs).
const TEST_MODEL_ID = shared.TEST_MODEL_ID;
const GEMMA_LITERT_MODEL_ID = shared.GEMMA_LITERT_MODEL_ID;
const READY_FAST_MODEL = shared.READY_FAST_MODEL;
const makeReadyFastSlot = shared.makeReadyFastSlot;
const makeReadyGemmaSlot = shared.makeReadyGemmaSlot;
const makeEmptySmartSlot = shared.makeEmptySmartSlot;
const generateCalls = shared.generateCalls;
const recordedReceipts = shared.recordedReceipts;

function buildScriptedStream(script: StreamScript): ReadableStream<string> {
  if (script.kind === "tokens") {
    return new ReadableStream<string>({
      start(controller) {
        for (const t of script.tokens) controller.enqueue(t);
        controller.close();
      },
    });
  }
  if (script.kind === "error") {
    // Deliver the tokens BEFORE erroring: `controller.error()` discards any
    // chunks still queued, so erroring in start() would never let the consumer
    // see the partial words the real runtime delivers before a fault.
    const pending = [...script.tokens];
    return new ReadableStream<string>({
      pull(controller) {
        const next = pending.shift();
        if (next !== undefined) controller.enqueue(next);
        else controller.error(script.error);
      },
    });
  }
  // hang: emit tokens, then stay open until the consumer cancels the reader.
  return new ReadableStream<string>({
    start(controller) {
      for (const t of script.tokens) controller.enqueue(t);
      // Intentionally never close — the consumer must cancel().
    },
    cancel() {
      script.onCancel?.();
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
      // Mirror the real adapters: every generation emits its own lifecycle
      // breadcrumbs. A repair turn runs generate() TWICE, so this is what
      // proves each receipt's trail belongs to its own generation.
      const onLifecycleEvent = options?.onLifecycleEvent as
        | ((event: { phase: string; at: number }) => void)
        | undefined;
      onLifecycleEvent?.({ phase: "first-token", at: Date.now() });
      const script = shared.scripts.shift();
      if (!script) {
        // No script left — emit an empty closed stream so the loop completes.
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

// ─── Slots seam ────────────────────────────────────────────────────────────
// The chat store also imports `getSlotForModel` / `hasReadySlot`; provide them
// so the store keeps loading. `getSlot` returns our mutable fixtures, which are
// initialized lazily on first read so the module-eval-time store read works.

vi.mock("../../local-ai/lifecycle/slots", () => ({
  SLOTS: ["eco-fast", "eco-smart"] as ReadonlyArray<Slot>,
  getSlot: (slot: Slot): SlotState => {
    shared.fastSlotState ??= shared.makeReadyFastSlot();
    shared.smartSlotState ??= shared.makeEmptySmartSlot();
    return slot === "eco-fast" ? shared.fastSlotState : shared.smartSlotState;
  },
  // Mirror the real implementation: resolve by actual slot BINDING (not a
  // hardwired eco-fast) so eco-smart-bound models exercise the same
  // reverse-lookup path production does.
  getSlotForModel: (modelId: string): Slot | null => {
    shared.fastSlotState ??= shared.makeReadyFastSlot();
    shared.smartSlotState ??= shared.makeEmptySmartSlot();
    if (shared.fastSlotState.modelId === modelId) return "eco-fast" as Slot;
    if (shared.smartSlotState.modelId === modelId) return "eco-smart" as Slot;
    return null;
  },
  hasReadySlot: () => {
    shared.fastSlotState ??= shared.makeReadyFastSlot();
    return shared.fastSlotState.status === "ready";
  },
  setSlotStorage: () => {},
  // No-ops so the switch-model graph reachable via lifecycle/upgrade (imported
  // by useChat for isUpgradeInFlight) resolves its named slot imports. These
  // tests never drive a swap, so the setters are never invoked.
  setSlot: () => {},
  setSlotStatus: () => {},
  subscribe: () => () => {},
}));

// ─── Usage-store seam ──────────────────────────────────────────────────────

vi.mock("../../local-ai/runtime/usage-store", () => ({
  getLastUsage: () => shared.lastUsage,
  getLastTemplateName: () => shared.lastTemplateName,
  setLastUsage: (u: typeof shared.lastUsage) => {
    shared.lastUsage = u;
  },
  setLastTemplateName: (n: string | null) => {
    shared.lastTemplateName = n;
  },
  // Faithful copy of the real helper (the receipt build calls it; without it the
  // build closure throws and recordGenerationReceiptAsync silently drops the row).
  ranToCapFromUsage: (u: { completionTokens?: number; maxTokens?: number } | null | undefined) =>
    u?.completionTokens != null
    && u.maxTokens != null
    && u.maxTokens > 0
    && u.completionTokens >= u.maxTokens,
}));

// ─── Receipt seam ──────────────────────────────────────────────────────────
// Capture receipts so we can assert the fire-and-forget recording at
// complete / aborted / error. We keep `hashSystemPrompt` real-ish (sync stub)
// so the receipt promise resolves deterministically.

type CapturedReceipt = {
  status: string;
  generationId: string;
  generationRole?: string;
  errorCode?: string;
  systemPromptHash?: string;
  samplingProfile?: Record<string, unknown>;
  events?: Array<{ at: number; phase: string }>;
  ranToCap?: boolean;
  maxInterTokenGapMs?: number | null;
};

vi.mock("../../local-ai/lifecycle/generation-receipt", () => ({
  recordGenerationReceipt: (receipt: CapturedReceipt) => {
    shared.recordedReceipts.push(receipt);
  },
  // Keeps the real function's microtask gap between "caller hands off" and
  // "receipt is built". Without that gap a lazily-built receipt body would
  // read the same state a snapshotted one does, and the tests asserting
  // per-generation attribution would pass even with the scope bug present.
  recordGenerationReceiptAsync: (
    prompt: string,
    build: (sph: string) => CapturedReceipt,
  ) => {
    const sph = prompt.includes(
      "Previous local draft missed an exact line-count constraint",
    )
      ? "repair-hash"
      : "primary-hash";
    void Promise.resolve().then(() => {
      shared.recordedReceipts.push(build(sph));
    });
  },
  hashSystemPrompt: async (prompt: string) =>
    prompt.includes("Previous local draft missed an exact line-count constraint")
      ? "repair-hash"
      : "primary-hash",
}));

vi.mock("../../lib/context-window", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/context-window")>();
  return {
    ...actual,
    assessLocalContextSafety: (
      ...args: Parameters<typeof actual.assessLocalContextSafety>
    ) => {
      const [messages, systemPrompt, modelContextLength, requestedNewTokens] = args;
      shared.contextSafetyCalls.push({ modelContextLength, requestedNewTokens });
      if (
        systemPrompt.includes("Previous local draft missed an exact line-count constraint")
        && messages.some((message) =>
          message.content.includes("REPAIR_CONTEXT_OVERFLOW_SENTINEL"),
        )
      ) {
        return {
          ok: false,
          reason:
            "This local model needs a shorter context before it can answer safely.",
          promptTokens: 9999,
          requestedNewTokens: 80,
          totalTokens: 10079,
          safeBudgetTokens: 1000,
        };
      }
      return actual.assessLocalContextSafety(...args);
    },
  };
});

// Imports AFTER the mocks so the hook picks up the mocked seams.
import { useChat, buildSystemPrompt, createTokenBatcher } from "../useChat";
import { useChatStore } from "../../stores/chatStore";
import {
  setUpgradeStorage,
  writeUpgradeRecord,
  type UpgradeRecord,
} from "../../local-ai/lifecycle/upgrade";
import { MODEL_PREPARING_BUSY_MESSAGE } from "../../lib/local-heavy-work-owner";
import {
  LOCAL_GENERATION_FALLBACK_MESSAGE,
  LOCAL_GENERATION_REPEATED_MESSAGE,
  LOCAL_MODEL_FILES_MISSING_MESSAGE,
  LOCAL_MODEL_FILES_MISSING_OFFLINE_MESSAGE,
} from "../../local-ai/adapters/error-messages";
import { _resetFailureStreakForTesting } from "../useChat/failure-streak";

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
    contextWindowNotice: "none",
    routeRecommendationSnapshot: null,
  });
}

function lastAssistant() {
  const messages = useChatStore.getState().messages;
  return [...messages].reverse().find((m) => m.role === "assistant");
}

/** Queue the FIFO stream scripts the mocked shim will replay, one per generate(). */
function setScripts(next: StreamScript[]): void {
  shared.scripts = next;
}

function setLastUsage(usage: typeof shared.lastUsage): void {
  shared.lastUsage = usage;
}

function setLastTemplateName(name: string | null): void {
  shared.lastTemplateName = name;
}

function setFastSlot(state: SlotState): void {
  shared.fastSlotState = state;
}

/**
 * Receipts are recorded fire-and-forget behind an awaited hash promise, and a
 * repair turn records TWO of them. Flush enough microtask turns that every
 * pending `.then()` has run.
 */
async function flushReceiptRecording(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  shared.generateCalls.length = 0;
  shared.scripts = [];
  shared.recordedReceipts.length = 0;
  shared.contextSafetyCalls.length = 0;
  shared.lastUsage = null;
  shared.lastTemplateName = null;
  shared.fastSlotState = makeReadyFastSlot();
  shared.smartSlotState = makeEmptySmartSlot();
  resetChatStore();
  // Isolate the module-scoped generic-failure streak so escalation cases don't
  // leak across tests (a leftover count would flip attempt-1 pins to REPEATED).
  _resetFailureStreakForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 0. 'auto' selection resolution (fresh-profile first message)
// ═══════════════════════════════════════════════════════════════════════════
//
// On a fresh profile the chat store initializes selectedModel to 'auto'
// because no slot is ready when the store module evaluates (first-run setup
// hasn't happened yet). The first in-session message after setup completes
// must dispatch to the ready slot's model — NOT hit the "runs in the cloud"
// decline. Regression: prod 2026-06-09, the first message every brand-new
// user ever sent was declined.

describe("useChat — 'auto' selection dispatches to the ready slot", () => {
  it("sends through the ready eco-fast model when selectedModel is 'auto'", async () => {
    useChatStore.setState({ selectedModel: "auto" });
    setScripts([{ kind: "tokens", tokens: ["Hi", "!"] }]);
    setLastUsage({ promptTokens: 4, completionTokens: 2, maxTokens: 1024 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]!.modelId).toBe(TEST_MODEL_ID);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toBe("Hi!");
    expect(assistant.content).not.toMatch(/cloud/i);
  });

  it("prefers a ready eco-smart model over eco-fast on 'auto' (slice 2b upgrade lands there)", async () => {
    // Post-upgrade the class-best model lives on eco-smart while the starter
    // stays on eco-fast. "Let Eco choose" must mean the best ready model, not
    // the first slot in iteration order.
    useChatStore.setState({ selectedModel: "auto" });
    shared.smartSlotState = {
      slot: "eco-smart" as Slot,
      modelId: GEMMA_LITERT_MODEL_ID,
      model: {
        id: GEMMA_LITERT_MODEL_ID,
        friendlyName: "Gemma E2B LiteRT (test)",
      } as unknown as SlotState["model"],
      status: "ready",
    };
    setScripts([{ kind: "tokens", tokens: ["From ", "smart"] }]);
    setLastUsage({ promptTokens: 4, completionTokens: 2, maxTokens: 1024 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]!.modelId).toBe(GEMMA_LITERT_MODEL_ID);
  });

  it("sends when eco-smart is the ONLY bound slot (a first-run 'deeper' pick)", async () => {
    // The first-run welcome card's deeper tile binds eco-smart and leaves
    // eco-fast empty. The very first message on that device must still send.
    useChatStore.setState({ selectedModel: "auto" });
    setFastSlot({
      slot: "eco-fast" as Slot,
      modelId: null,
      model: null,
      status: "empty",
    });
    shared.smartSlotState = {
      slot: "eco-smart" as Slot,
      modelId: GEMMA_LITERT_MODEL_ID,
      model: {
        id: GEMMA_LITERT_MODEL_ID,
        friendlyName: "Gemma E2B LiteRT (test)",
      } as unknown as SlotState["model"],
      status: "ready",
    };
    setScripts([{ kind: "tokens", tokens: ["Deep ", "reply"] }]);
    setLastUsage({ promptTokens: 4, completionTokens: 2, maxTokens: 1024 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]!.modelId).toBe(GEMMA_LITERT_MODEL_ID);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toBe("Deep reply");
  });

  it("still declines 'auto' when no slot is ready (no runtime to dispatch to)", async () => {
    useChatStore.setState({ selectedModel: "auto" });
    setFastSlot({
      slot: "eco-fast" as Slot,
      modelId: null,
      model: null,
      status: "empty",
    });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(generateCalls).toHaveLength(0);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Normal stream → token accumulation → complete + usage fields
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — normal on-device stream (sendMessage)", () => {
  it("accumulates scripted tokens into the assistant message and marks it complete", async () => {
    setScripts([{ kind: "tokens", tokens: ["Hel", "lo ", "world"] }]);    setLastUsage({ promptTokens: 12, completionTokens: 3, maxTokens: 1024 });
    setLastTemplateName("chatml");

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage("Hi there");
    });

    const assistant = lastAssistant();
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe("Hello world");
    expect(assistant!.status).toBe("complete");
    expect(assistant!.inferenceMethod).toBe("local");
    expect(assistant!.confidence).toBeNull();
  });

  it("threads usage fields (localCompletionTokens / localMaxTokens / possiblyTruncated) onto the message", async () => {
    setScripts([{ kind: "tokens", tokens: ["short"] }]);    // completionTokens (3) is well under 95% of maxTokens (1024) → not truncated.
    setLastUsage({ promptTokens: 5, completionTokens: 3, maxTokens: 1024 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.localCompletionTokens).toBe(3);
    expect(assistant.localMaxTokens).toBe(1024);
    expect(assistant.possiblyTruncated).toBe(false);
  });

  it("flags possiblyTruncated when completionTokens reaches >= 95% of maxTokens", async () => {
    setScripts([{ kind: "tokens", tokens: ["x"] }]);    setLastUsage({ promptTokens: 5, completionTokens: 1000, maxTokens: 1024 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    expect(lastAssistant()!.possiblyTruncated).toBe(true);
  });

  it("creates exactly one user message and one assistant message on the branch", async () => {
    setScripts([{ kind: "tokens", tokens: ["ok"] }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("question");
    });

    const messages = useChatStore.getState().messages;
    const users = messages.filter((m) => m.role === "user");
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(users).toHaveLength(1);
    expect(users[0]!.content).toBe("question");
    expect(assistants).toHaveLength(1);
  });

  it("returns the stream phase to idle after completion", async () => {
    setScripts([{ kind: "tokens", tokens: ["done"] }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    expect(useChatStore.getState().streamPhase).toBe("idle");
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it("prepends a system message and forwards sampling options to the shim generate() call", async () => {
    setScripts([{ kind: "tokens", tokens: ["ok"] }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Explain quantum tunneling");
    });

    expect(generateCalls).toHaveLength(1);
    const call = generateCalls[0]!;
    expect(call.modelId).toBe(TEST_MODEL_ID);
    expect(call.messages[0]!.role).toBe("system");
    expect(call.messages[call.messages.length - 1]!.content).toBe(
      "Explain quantum tunneling",
    );
    // Sampling profile must reach the shim (Phase-1 invariant).
    expect(typeof call.options?.max_new_tokens).toBe("number");
    expect(typeof call.options?.temperature).toBe("number");
  });

  it("uses validation-selected Gemma LiteRT generation and context metadata in product chat", async () => {
    setFastSlot(makeReadyGemmaSlot());
    useChatStore.setState({ selectedModel: GEMMA_LITERT_MODEL_ID });
    setScripts([{ kind: "tokens", tokens: ["OK"] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Say only OK.");
    });

    expect(generateCalls).toHaveLength(1);
    const call = generateCalls[0]!;
    expect(call.modelId).toBe(GEMMA_LITERT_MODEL_ID);
    expect(call.options).toMatchObject({
      max_new_tokens: 256,
      temperature: 0.18,
      top_p: 0.72,
      top_k: 64,
    });
    expect(call.options).not.toHaveProperty("repetition_penalty");
    expect(call.options).not.toHaveProperty("no_repeat_ngram_size");
    expect(shared.contextSafetyCalls[0]).toMatchObject({
      modelContextLength: 2048,
      requestedNewTokens: 256,
    });
    expect(lastAssistant()!.content).toBe("OK");
  });

  it("records a 'complete' generation receipt with the full requested sampling profile", async () => {
    setScripts([{ kind: "tokens", tokens: ["a", "b"] }]);    setLastUsage({ promptTokens: 7, completionTokens: 2, maxTokens: 512 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });
    // Receipt recording is fire-and-forget through an awaited hash promise;
    // flush the microtask queue so the .then() resolves.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const complete = recordedReceipts.find((r) => r.status === "complete");
    expect(complete).toBeDefined();
    expect(complete?.samplingProfile).toMatchObject({
      temperature: expect.any(Number),
      maxTokens: expect.any(Number),
      topP: expect.any(Number),
      topK: expect.any(Number),
      repetitionPenalty: expect.any(Number),
    });
  });

  it("records the #28 stall signals (ranToCap + maxInterTokenGapMs) on the completion receipt", async () => {
    // Usage says the generation exhausted its budget (completionTokens >= maxTokens)
    // and the adapter measured a large inter-token gap — the stall fingerprint.
    setScripts([{ kind: "tokens", tokens: ["a", "b"] }]);
    setLastUsage({ promptTokens: 7, completionTokens: 512, maxTokens: 512, maxInterTokenGapMs: 1800 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });
    await flushReceiptRecording();

    const complete = recordedReceipts.find((r) => r.status === "complete");
    expect(complete?.ranToCap).toBe(true);
    expect(complete?.maxInterTokenGapMs).toBe(1800);
  });

  it("records ranToCap false and no gap when the generation stopped naturally", async () => {
    setScripts([{ kind: "tokens", tokens: ["a", "b"] }]);
    setLastUsage({ promptTokens: 7, completionTokens: 2, maxTokens: 512 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });
    await flushReceiptRecording();

    const complete = recordedReceipts.find((r) => r.status === "complete");
    expect(complete?.ranToCap).toBe(false);
    // No maxInterTokenGapMs in usage → the field is omitted from the receipt.
    expect(complete?.maxInterTokenGapMs).toBeUndefined();
  });

  it("records exactly one receipt, roled 'primary', when no repair runs", async () => {
    setScripts([{ kind: "tokens", tokens: ["a", "b"] }]);
    setLastUsage({ promptTokens: 7, completionTokens: 2, maxTokens: 512 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });
    await flushReceiptRecording();

    expect(recordedReceipts.map((r) => r.generationRole)).toEqual(["primary"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Hard-constraint repair loop → content reset → 2nd stream
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — hard-constraint repair loop", () => {
  it("resets content and runs a SECOND generate() when a dietary repair is warranted", async () => {
    // First stream emits an answer containing an animal ingredient for a
    // vegetarian request → buildLocalHardConstraintRepair returns a repair.
    setScripts([
      { kind: "tokens", tokens: ["Add ", "chicken ", "stock."] },
      { kind: "tokens", tokens: ["Use ", "vegetable ", "broth."] },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Give me a vegetarian soup recipe");
    });

    // Two generate() calls: primary + repair.
    expect(generateCalls).toHaveLength(2);
    // Final content is the SECOND stream's output (content was reset to "").
    const assistant = lastAssistant()!;
    expect(assistant.content).toBe("Use vegetable broth.");
    expect(assistant.status).toBe("complete");
  });

  it("passes the repair systemInstruction + repair generation options to the second generate()", async () => {
    setScripts([
      { kind: "tokens", tokens: ["beef ", "chili"] },
      { kind: "tokens", tokens: ["lentil ", "chili"] },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("a vegetarian chili recipe please");
    });

    expect(generateCalls).toHaveLength(2);
    const repairCall = generateCalls[1]!;
    // Single-turn repair still has only system+user; contextual repairs preserve history below.
    expect(repairCall.messages).toHaveLength(2);
    expect(repairCall.messages[0]!.role).toBe("system");
    expect(repairCall.messages[0]!.content).toContain("hard dietary constraint");
    expect(repairCall.messages[1]!.role).toBe("user");
    // Repair generation options override the base profile (temperature 0.2).
    expect(repairCall.options).toMatchObject({
      temperature: 0.2,
      top_p: 0.65,
      repetition_penalty: 1.12,
      no_repeat_ngram_size: 4,
    });
  });

  it("records the repaired completion receipt with the effective repair sampling profile", async () => {
    setScripts([
      { kind: "tokens", tokens: ["Here is a preface.\n- Line one\n- Line two\n- Line three"] },
      { kind: "tokens", tokens: ["- Line one\n- Line two\n- Line three"] },
    ]);
    setLastUsage({ promptTokens: 24, completionTokens: 3, maxTokens: 80 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Give exactly three short bullet lines about better focus.");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(generateCalls).toHaveLength(2);
    expect(generateCalls[1]!.options).toMatchObject({
      temperature: 0.1,
      top_p: 0.55,
      max_new_tokens: 80,
    });
    const repaired = recordedReceipts.find((r) => r.generationRole === "repair");
    expect(repaired?.systemPromptHash).toBe("repair-hash");
    expect(repaired?.samplingProfile).toMatchObject({
      temperature: 0.1,
      topP: 0.55,
      maxTokens: 80,
    });
  });

  // A repair turn runs TWO generations. Recording one receipt for the pair
  // silently merged them: the surviving row carried the repair's prompt hash
  // and sampling but the PRIMARY's first-token trail, and the primary
  // generation left no trace at all. That is what made the KV-reuse lane
  // unable to tell "the chat turn re-prefilled" from "the repair generation
  // re-prefilled" — the repair always misses by construction, because it
  // rewrites the front of the prompt.
  it("records a receipt for the superseded primary generation, not only the repair", async () => {
    setScripts([
      { kind: "tokens", tokens: ["Here is a preface.\n- Line one\n- Line two\n- Line three"] },
      { kind: "tokens", tokens: ["- Line one\n- Line two\n- Line three"] },
    ]);
    setLastUsage({ promptTokens: 24, completionTokens: 3, maxTokens: 80 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Give exactly three short bullet lines about better focus.");
    });
    await flushReceiptRecording();

    expect(generateCalls).toHaveLength(2);
    expect(recordedReceipts.map((r) => r.generationRole)).toEqual(["primary", "repair"]);
  });

  it("attributes each receipt to the system prompt its own generation ran with", async () => {
    setScripts([
      { kind: "tokens", tokens: ["Here is a preface.\n- Line one\n- Line two\n- Line three"] },
      { kind: "tokens", tokens: ["- Line one\n- Line two\n- Line three"] },
    ]);
    setLastUsage({ promptTokens: 24, completionTokens: 3, maxTokens: 80 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Give exactly three short bullet lines about better focus.");
    });
    await flushReceiptRecording();

    const primary = recordedReceipts.find((r) => r.generationRole === "primary");
    const repaired = recordedReceipts.find((r) => r.generationRole === "repair");
    expect(primary?.systemPromptHash).toBe("primary-hash");
    expect(repaired?.systemPromptHash).toBe("repair-hash");
  });

  it("scopes each receipt's lifecycle trail to its own generation", async () => {
    setScripts([
      { kind: "tokens", tokens: ["Here is a preface.\n- Line one\n- Line two\n- Line three"] },
      { kind: "tokens", tokens: ["- Line one\n- Line two\n- Line three"] },
    ]);
    setLastUsage({ promptTokens: 24, completionTokens: 3, maxTokens: 80 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Give exactly three short bullet lines about better focus.");
    });
    await flushReceiptRecording();

    // One generation, one first-token breadcrumb. Before per-generation
    // scoping the repair's trail carried both generations' events.
    for (const receipt of recordedReceipts) {
      expect(
        receipt.events?.map((e) => e.phase),
        `${receipt.generationRole} receipt carries another generation's breadcrumbs`,
      ).toEqual(["first-token"]);
    }
  });

  it("applies exact-token repairs deterministically without a second generate call", async () => {
    setScripts([
      { kind: "tokens", tokens: ["OK. I hope that helps."] },
      { kind: "tokens", tokens: ["should not run"] },
    ]);
    setLastUsage({ promptTokens: 8, completionTokens: 250, maxTokens: 256 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Say only the word OK and stop.");
    });

    expect(generateCalls).toHaveLength(1);
    const assistant = lastAssistant()!;
    expect(assistant.content).toBe("OK");
    expect(assistant.status).toBe("complete");
    expect(assistant.localCompletionTokens).toBe(250);
    expect(assistant.localMaxTokens).toBe(256);
    expect(assistant.possiblyTruncated).toBe(false);
  });

  it("preserves prior conversation turns when repairing a contextual follow-up", async () => {
    setScripts([
      { kind: "tokens", tokens: ["Leaves are green because chlorophyll captures sunlight."] },
      { kind: "tokens", tokens: ["Here is a preface.\n- line one\n- line two\n- line three"] },
      {
        kind: "tokens",
        tokens: ["- Chlorophyll captures sunlight.\n- Plants make food.\n- Green light reflects."],
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("In one warm sentence, explain why leaves are green.");
    });
    await act(async () => {
      await result.current.sendMessage("Now turn that into exactly three short bullet lines.");
    });

    expect(generateCalls).toHaveLength(3);
    const repairCall = generateCalls[2]!;
    expect(
      repairCall.messages.some(
        (message) =>
          message.role === "assistant"
          && message.content.includes("chlorophyll captures sunlight"),
      ),
    ).toBe(true);
    expect(repairCall.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("Regenerate as exactly 3 short bullet lines"),
    });
    expect(lastAssistant()!.content).toBe(
      "- Chlorophyll captures sunlight.\n- Plants make food.\n- Green light reflects.",
    );
  });

  it("checks repair retry context before clearing the primary draft", async () => {
    setScripts([
      { kind: "tokens", tokens: ["REPAIR_CONTEXT_OVERFLOW_SENTINEL"] },
      { kind: "tokens", tokens: ["Here is a preface.\n- line one\n- line two\n- line three"] },
      { kind: "tokens", tokens: ["should not run"] },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("Seed a fact for the follow-up.");
    });
    await act(async () => {
      await result.current.sendMessage("Now turn that into exactly three short bullet lines.");
    });

    expect(generateCalls).toHaveLength(2);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.content).toContain("Here is a preface.");
    expect(assistant.errorMessage).toContain("shorter context");
  });

  it("repairs code-block-only requests when the primary draft adds prose", async () => {
    setScripts([
      {
        kind: "tokens",
        tokens: [
          "Here is the function:\n\n```ts\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n```",
        ],
      },
      {
        kind: "tokens",
        tokens: [
          "```ts\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n```",
        ],
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage(
        "Reply with only a TypeScript code block that exports a function clamp(value: number, min: number, max: number): number.",
      );
    });

    expect(generateCalls).toHaveLength(2);
    expect(generateCalls[1]!.messages[0]!.content).toContain("code-block-only constraint");
    expect(generateCalls[1]!.messages.at(-1)?.content).toContain("Regenerate as exactly one fenced code block");
    expect(generateCalls[1]!.options).toMatchObject({
      temperature: 0.1,
      top_p: 0.55,
      max_new_tokens: 192,
    });
    expect(lastAssistant()!.content).toBe(
      "```ts\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n```",
    );
  });

  it("does NOT run a second stream when no repair is warranted", async () => {
    setScripts([{ kind: "tokens", tokens: ["A tasty tomato pasta."] }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("a vegetarian pasta recipe");
    });

    expect(generateCalls).toHaveLength(1);
    expect(lastAssistant()!.content).toBe("A tasty tomato pasta.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. User stop / abort → interrupted
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — user stop / abort (stopGeneration)", () => {
  it("marks the streaming message complete + streamInterrupted and returns phase to idle", async () => {
    let cancelled = false;
    setScripts([
      {
        kind: "hang",
        tokens: ["partial answer so far"],
        onCancel: () => {
          cancelled = true;
        },
      },
    ]);

    const { result } = renderHook(() => useChat());

    // Start the generation but do NOT await — the hang stream stays open.
    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendMessage("Tell me a long story");
      // Let the stream start, enqueue its token, and the loop begin reading.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Now stop. interruptActiveGeneration flushes pending tokens, cancels the
    // reader, aborts, and marks the streaming message interrupted.
    await act(async () => {
      result.current.stopGeneration();
      await sendPromise;
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.streamInterrupted).toBe(true);
    expect(cancelled).toBe(true);
    expect(useChatStore.getState().streamPhase).toBe("idle");
  });

  it("preserves the partial flushed content when stopped mid-stream", async () => {
    setScripts([
      {
        kind: "hang",
        tokens: ["The story begins"],
      },
    ]);

    const { result } = renderHook(() => useChat());
    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendMessage("Tell me a story");
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      result.current.stopGeneration();
      await sendPromise;
    });

    // stopGeneration → interruptActiveGeneration flushes pending tokens first,
    // so the partial content survives.
    expect(lastAssistant()!.content).toBe("The story begins");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Error path → applyLocalGenerationError mapping
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — runtime error handling", () => {
  it("marks the message as error and surfaces the error when the stream errors (no partial content)", async () => {
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError(
          "LOCAL_INFERENCE_FAILED",
          "boom",
          true,
        ),
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    // Unknown runtime codes no longer leak the raw "boom" — a warm fallback
    // shows and the technical detail is logged for diagnostics (PR-D2).
    expect(assistant.errorMessage).toBe(LOCAL_GENERATION_FALLBACK_MESSAGE);
    expect(assistant.errorMessage).not.toBe("boom");
    expect(assistant.inferenceMethod).toBe("local");
    expect(useChatStore.getState().error).toBe(LOCAL_GENERATION_FALLBACK_MESSAGE);
  });

  it.each(["OOM", "TIMEOUT"] as const)(
    "keeps the words that already arrived when the stream fails with %s (interrupted, not error)",
    async (code) => {
      setScripts([
        {
          kind: "error",
          tokens: ["partial answer so far"],
          error: new LocalInferenceStreamError(code, "runtime detail", true),
        },
      ]);

      const { result } = renderHook(() => useChat());
      await act(async () => {
        await result.current.sendMessage("hi");
      });

      const assistant = lastAssistant()!;
      expect(assistant.content).toBe("partial answer so far");
      expect(assistant.status).toBe("complete");
      expect(assistant.streamInterrupted).toBe(true);
      expect(assistant.interruptedReason).toBe("fault");
    },
  );

  it("offers a lighter model when the model fails to LOAD for lack of memory (never 'shorten the message')", async () => {
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError("LOAD_OOM", "Out of memory", true),
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.errorMessage).toBe(LOCAL_GENERATION_REPEATED_MESSAGE);
    expect(assistant.errorMessage).not.toMatch(/shorten/i);
    expect(useChatStore.getState().error).toBe(LOCAL_GENERATION_REPEATED_MESSAGE);
  });

  it("says the model's files are gone and can't be fetched offline (never 'needed a moment' or a cooldown) when weights were evicted while offline", async () => {
    const onLineSpy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError("MODEL_FILES_MISSING", "Failed to fetch", true),
      },
    ]);
    try {
      const { result } = renderHook(() => useChat());
      await act(async () => {
        await result.current.sendMessage("hi");
      });

      const assistant = lastAssistant()!;
      expect(assistant.status).toBe("error");
      expect(assistant.errorMessage).toBe(LOCAL_MODEL_FILES_MISSING_OFFLINE_MESSAGE);
      expect(assistant.errorMessage).not.toMatch(/needed a moment|breather|cooling/i);
      expect(useChatStore.getState().error).toBe(LOCAL_MODEL_FILES_MISSING_OFFLINE_MESSAGE);
    } finally {
      onLineSpy.mockRestore();
    }
  });

  it("says the model's files are gone and the re-download failed when weights were evicted while online", async () => {
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError("MODEL_FILES_MISSING", "Failed to fetch", true),
      },
    ]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.errorMessage).toBe(LOCAL_MODEL_FILES_MISSING_MESSAGE);
  });

  it("maps a TEMPLATE_MISSING stream error to the dedicated user message", async () => {
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError("TEMPLATE_MISSING", "raw", true),
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    // The raw error message is replaced by the friendly TEMPLATE_MISSING copy.
    expect(assistant.errorMessage).not.toBe("raw");
    expect(assistant.errorMessage!.length).toBeGreaterThan(0);
  });

  it("records an 'error' receipt when generation fails", async () => {
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError("LOCAL_INFERENCE_FAILED", "kaboom"),
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recordedReceipts.some((r) => r.status === "error")).toBe(true);
  });

  it("escalates to the repeated-failure copy on a second consecutive generic failure", async () => {
    const genericError = () => ({
      kind: "error" as const,
      tokens: [],
      error: new LocalInferenceStreamError("LOCAL_INFERENCE_FAILED", "boom", true),
    });

    const { result } = renderHook(() => useChat());

    setScripts([genericError()]);
    await act(async () => {
      await result.current.sendMessage("first try");
    });
    // Attempt 1 shows the retry-friendly fallback.
    expect(lastAssistant()!.errorMessage).toBe(LOCAL_GENERATION_FALLBACK_MESSAGE);

    setScripts([genericError()]);
    await act(async () => {
      await result.current.sendMessage("second try");
    });
    // Attempt 2 (same model) escalates to the "we reset it, try lighter" copy.
    expect(lastAssistant()!.errorMessage).toBe(LOCAL_GENERATION_REPEATED_MESSAGE);
  });

  it("resets the streak after a successful generation between failures", async () => {
    const genericError = () => ({
      kind: "error" as const,
      tokens: [],
      error: new LocalInferenceStreamError("LOCAL_INFERENCE_FAILED", "boom", true),
    });

    const { result } = renderHook(() => useChat());

    setScripts([genericError()]);
    await act(async () => {
      await result.current.sendMessage("fail once");
    });
    expect(lastAssistant()!.errorMessage).toBe(LOCAL_GENERATION_FALLBACK_MESSAGE);

    // A clean completion in between resets the streak.
    setScripts([{ kind: "tokens", tokens: ["all", " good"] }]);
    setLastUsage({ promptTokens: 4, completionTokens: 2, maxTokens: 1024 });
    await act(async () => {
      await result.current.sendMessage("this one works");
    });
    expect(lastAssistant()!.status).toBe("complete");

    setLastUsage(null);
    setScripts([genericError()]);
    await act(async () => {
      await result.current.sendMessage("fail again");
    });
    // Back to attempt-1 copy — the success reset the streak.
    expect(lastAssistant()!.errorMessage).toBe(LOCAL_GENERATION_FALLBACK_MESSAGE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4b. Not-ready guard while THIS model is being prepared (Finding D)
// ═══════════════════════════════════════════════════════════════════════════
//
// An interrupted/resuming pull leaves the runtime "still preparing" for a
// window. Sends that land there used to return an INCONSISTENT mix: sometimes
// the honest "preparing, please wait" guard, sometimes the generic
// "Something went sideways" card — for the SAME not-ready-yet condition. Route
// the not-ready case to the honest guard consistently, WITHOUT hiding genuine
// device faults, and WITHOUT claiming that a pull happening on the other slot
// says anything about the model actually serving the conversation.

describe("useChat — not-ready guard while this model is being prepared", () => {
  beforeEach(() => {
    // Isolated in-memory upgrade storage so the guard reads our staged record
    // and nothing leaks across tests.
    const map = new Map<string, string>();
    setUpgradeStorage({
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => { map.set(k, v); },
      removeItem: (k) => { map.delete(k); },
    });
  });

  afterEach(() => {
    writeUpgradeRecord(null);
    setUpgradeStorage(null);
  });

  /**
   * A pull in flight. The default slot is eco-fast — the one this fixture's
   * conversation actually runs on — because that is the case where "still
   * preparing" describes the failing generation.
   */
  function stageInFlightUpgrade(targetSlot: Slot = "eco-fast" as Slot): void {
    const record: UpgradeRecord = {
      version: 1,
      phase: "downloading",
      targetModelId: "candidate/qwen3.5-2b-onnx",
      targetSlot,
      baseModelId: null,
      deferral: null,
      swapAttempts: 0,
      updatedAt: 0,
    };
    writeUpgradeRecord(record);
  }

  it("routes a generic inference failure to the honest preparing guard (never the generic card)", async () => {
    stageInFlightUpgrade();
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError("LOCAL_INFERENCE_FAILED", "boom", true),
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.errorMessage).toBe(MODEL_PREPARING_BUSY_MESSAGE);
    expect(assistant.errorMessage).not.toBe("boom");
    expect(useChatStore.getState().error).toBe(MODEL_PREPARING_BUSY_MESSAGE);
  });

  it("routes an untyped (non-LocalInferenceStreamError) failure to the guard too", async () => {
    stageInFlightUpgrade();
    setScripts([
      { kind: "error", tokens: [], error: new Error("No model loaded") },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.errorMessage).toBe(MODEL_PREPARING_BUSY_MESSAGE);
  });

  it("does NOT hide a genuine device fault (cooldown) behind the guard, even mid-upgrade", async () => {
    stageInFlightUpgrade();
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError(
          "LOCAL_MODEL_COOLDOWN",
          "Eco Everyday is cooling down after a recent crash (30s left).",
          true,
        ),
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    // The dedicated cooldown branch survives — a real fault is never masked by
    // the preparing guard — and it warms the copy while keeping the honest
    // countdown (30s → "about 30 seconds"), never leaking "crash" verbatim.
    expect(assistant.errorMessage).toContain("about 30 seconds");
    expect(assistant.errorMessage).not.toContain("crash");
    expect(assistant.errorMessage).not.toBe(MODEL_PREPARING_BUSY_MESSAGE);
  });

  it("does NOT convert a generic failure when the pull is for the OTHER slot", async () => {
    // The regression this guard used to have: a background pull into eco-smart
    // relabelled every failure of the eco-fast model the person was chatting on
    // as "preparing, please wait" — for the whole length of the download. The
    // conversation's model is ready and its error is real; only the tile is
    // waiting on anything.
    stageInFlightUpgrade("eco-smart" as Slot);
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError("LOCAL_INFERENCE_FAILED", "boom", true),
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.errorMessage).toBe(LOCAL_GENERATION_FALLBACK_MESSAGE);
    expect(assistant.errorMessage).not.toBe(MODEL_PREPARING_BUSY_MESSAGE);
  });

  it("does NOT convert a generic failure when no upgrade is in flight (genuine errors still surface)", async () => {
    // No stageInFlightUpgrade() — the runtime is settled, so a generic failure
    // is a real error and must surface verbatim, not the preparing guard.
    setScripts([
      {
        kind: "error",
        tokens: [],
        error: new LocalInferenceStreamError("LOCAL_INFERENCE_FAILED", "boom", true),
      },
    ]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    // A genuine error still surfaces (not the preparing guard) — but as the warm
    // fallback, not the raw "boom" (PR-D2).
    expect(assistant.errorMessage).toBe(LOCAL_GENERATION_FALLBACK_MESSAGE);
    expect(assistant.errorMessage).not.toBe("boom");
    expect(assistant.errorMessage).not.toBe(MODEL_PREPARING_BUSY_MESSAGE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Readiness guards (dispatch gating)
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — dispatch readiness guards", () => {
  it("errors with a readiness message (no generate() call) when the slot is not ready", async () => {
    setFastSlot({
      slot: "eco-fast" as Slot,
      modelId: TEST_MODEL_ID,
      model: READY_FAST_MODEL,
      status: "preparing",
    });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    expect(generateCalls).toHaveLength(0);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.inferenceMethod).toBe("local");
  });

  it("errors with a cloud-not-supported message when a non-local model is selected", async () => {
    // NOTE: this previously used "auto" — which accidentally pinned the
    // fresh-profile first-message bug (auto + ready slot was declined as
    // "cloud"). 'auto' with a ready slot now dispatches on-device; a
    // genuinely non-local id still declines.
    useChatStore.setState({ selectedModel: "gpt-4o" });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    expect(generateCalls).toHaveLength(0);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.errorMessage).toContain("cloud");
    // Dispatch failures surface ONCE, in the assistant card — the store-level
    // error (the notice strip above the composer) stays quiet, so the raw
    // message is never echoed twice.
    expect(useChatStore.getState().error).toBeNull();
  });

  // ── stopForUnsafeLocalContext (oversized-context early-return guard) ────────
  // #4 Phase 3 Task 3: the context-safety guard inside streamResponse moves
  // during the refactor; pin that an oversized prompt errors WITHOUT a
  // generate() call (the guard short-circuits dispatch).
  it("errors without a generate() call when the prompt overflows the model context budget", async () => {
    setScripts([{ kind: "tokens", tokens: ["should not be reached"] }]);
    // A prompt far larger than any catalog context window (~250k estimated
    // tokens), so assessLocalContextSafety fails deterministically against
    // the catalog-resolved context length.
    const oversized = "word ".repeat(200_000);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage(oversized);
    });

    expect(generateCalls).toHaveLength(0);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.inferenceMethod).toBe("local");
    // The user-facing safety reason is surfaced both on the message and globally.
    expect(assistant.errorMessage).toContain("grown past");
    expect(useChatStore.getState().error).toContain("grown past");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. regenerate — new sibling assistant, fresh stream
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — regenerateMessage", () => {
  it("creates a new sibling assistant message and streams a fresh response into it", async () => {
    setScripts([{ kind: "tokens", tokens: ["first answer"] }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("a question");
    });

    const firstAssistant = lastAssistant()!;
    expect(firstAssistant.content).toBe("first answer");

    // Regenerate: a new sibling assistant with a fresh stream.
    setScripts([{ kind: "tokens", tokens: ["second answer"] }]);    await act(async () => {
      await result.current.regenerateMessage(firstAssistant.id);
    });

    const regenerated = lastAssistant()!;
    expect(regenerated.id).not.toBe(firstAssistant.id);
    expect(regenerated.content).toBe("second answer");
    expect(regenerated.status).toBe("complete");
    // Both assistants share the same parent (the user message).
    expect(regenerated.parentId).toBe(firstAssistant.parentId);
  });

  it("is a no-op when the target is not the latest assistant message", async () => {
    setScripts([{ kind: "tokens", tokens: ["answer"] }]);    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("q");
    });

    const before = useChatStore.getState().messages.length;
    // Pass a bogus id → no regeneration.
    await act(async () => {
      await result.current.regenerateMessage("does-not-exist");
    });
    expect(useChatStore.getState().messages.length).toBe(before);
    expect(generateCalls).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. editMessage — new sibling user + assistant branch
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — editMessage", () => {
  it("creates a new sibling user message and streams a new assistant on the new branch", async () => {
    setScripts([{ kind: "tokens", tokens: ["original reply"] }]);    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("original question");
    });

    const originalUser = useChatStore
      .getState()
      .messages.find((m) => m.role === "user")!;

    setScripts([{ kind: "tokens", tokens: ["edited reply"] }]);    await act(async () => {
      await result.current.editMessage(originalUser.id, "edited question");
    });

    const messages = useChatStore.getState().messages;
    const editedUser = messages.find(
      (m) => m.role === "user" && m.content === "edited question",
    );
    expect(editedUser).toBeDefined();
    // The new user message is a sibling of the original (same parentId).
    expect(editedUser!.parentId).toBe(originalUser.parentId);
    expect(lastAssistant()!.content).toBe("edited reply");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. retryMessage — offline interrupted reply → continue locally
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — retryMessage (offline continue-interrupted)", () => {
  it("continues an interrupted partial reply locally when offline (does not remove the message)", async () => {
    // Seed a conversation with an interrupted assistant reply that has partial
    // content — the precondition for continueInterruptedMessageLocally.
    const userId = "u1";
    const assistantId = "a1";
    useChatStore.setState({
      selectedModel: TEST_MODEL_ID,
      messages: [
        {
          id: userId,
          role: "user",
          content: "Write a haiku",
          createdAt: 1,
          parentId: null,
          status: "complete",
        },
        {
          id: assistantId,
          role: "assistant",
          content: "An old silent pond",
          createdAt: 2,
          parentId: userId,
          status: "complete",
          streamInterrupted: true,
          inferenceMethod: "local",
        },
      ],
    });

    // Force the offline branch.
    const onLineSpy = vi
      .spyOn(navigator, "onLine", "get")
      .mockReturnValue(false);

    setScripts([{ kind: "tokens", tokens: [" / a frog jumps in"] }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.retryMessage(assistantId);
    });

    // The interrupted message is continued in place (same id), not removed.
    const continued = useChatStore
      .getState()
      .messages.find((m) => m.id === assistantId);
    expect(continued).toBeDefined();
    expect(continued!.content).toContain("An old silent pond");
    expect(continued!.content).toContain("a frog jumps in");
    expect(continued!.status).toBe("complete");
    expect(continued!.offlineDivider).toBe(true);
    expect(generateCalls).toHaveLength(1);

    onLineSpy.mockRestore();
  });

  it("does not draw the 'finished on your device' divider when the continuation fails", async () => {
    useChatStore.setState({
      selectedModel: TEST_MODEL_ID,
      messages: [
        { id: "u1", role: "user", content: "Write a haiku", createdAt: 1, parentId: null, status: "complete" },
        {
          id: "a1",
          role: "assistant",
          content: "An old silent pond",
          createdAt: 2,
          parentId: "u1",
          status: "complete",
          streamInterrupted: true,
          inferenceMethod: "local",
        },
      ],
    });
    const onLineSpy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

    setScripts([{ kind: "error", tokens: [], error: new Error("worker crashed") }]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.retryMessage("a1");
    });

    const failed = useChatStore.getState().messages.find((m) => m.id === "a1");
    expect(failed).toBeDefined();
    expect(failed!.status).toBe("error");
    // Nothing finished, so the divider that says it did must not appear.
    expect(failed!.offlineDivider).toBeFalsy();

    onLineSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Pure exported seams (no hook render needed)
// ═══════════════════════════════════════════════════════════════════════════

describe("useChat — exported seam: buildSystemPrompt", () => {
  it("includes the Eco on-device identity prompt for a local model", () => {
    const prompt = buildSystemPrompt(TEST_MODEL_ID, "");
    expect(prompt).toContain("You are Eco");
  });

  it("appends trimmed custom instructions as a separate paragraph", () => {
    const prompt = buildSystemPrompt(TEST_MODEL_ID, "  Always be concise.  ");
    expect(prompt).toContain("Always be concise.");
    expect(prompt.split("\n\n").length).toBeGreaterThanOrEqual(2);
  });

  it("omits custom instructions when they are blank", () => {
    const withBlank = buildSystemPrompt(TEST_MODEL_ID, "   ");
    const withNone = buildSystemPrompt(TEST_MODEL_ID, "");
    expect(withBlank).toBe(withNone);
  });
});

describe("useChat — exported seam: createTokenBatcher", () => {
  it("tags flushed batches with the generation id and a monotonic seq counter", () => {
    const calls: { id: string; token: string; genId?: string; seq?: number }[] = [];
    const batcher = createTokenBatcher((id, token, genId, seq) => {
      calls.push({ id, token, genId, seq });
    });
    batcher.setGenerationId("gen-abc");
    batcher.resetSeq();

    batcher.append("m1", "hello ");
    batcher.flushSync();
    batcher.append("m1", "world");
    batcher.flushSync();

    expect(calls).toEqual([
      { id: "m1", token: "hello ", genId: "gen-abc", seq: 1 },
      { id: "m1", token: "world", genId: "gen-abc", seq: 2 },
    ]);
  });

  it("does not flush an empty buffer", () => {
    const append = vi.fn();
    const batcher = createTokenBatcher(append);
    batcher.flushSync();
    expect(append).not.toHaveBeenCalled();
  });

  it("resets the seq counter when resetSeq() is called (repair-loop behavior)", () => {
    const calls: (number | undefined)[] = [];
    const batcher = createTokenBatcher((_id, _t, _g, seq) => calls.push(seq));
    batcher.setGenerationId("g");
    batcher.append("m", "a");
    batcher.flushSync();
    batcher.resetSeq();
    batcher.append("m", "b");
    batcher.flushSync();
    expect(calls).toEqual([1, 1]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Generation lease (instant-start slice 2a)
// ═══════════════════════════════════════════════════════════════════════════
//
// Chat generation holds the 'generation' runtime lease so a model switch can
// never unload the runtime mid-reply. Real lease module (jsdom localStorage).

import { acquireLocalHeavyWork } from "../../lib/local-heavy-work-owner";

describe("useChat — generation lease (slice 2a)", () => {
  const RUNTIME_KEY = "eco-local-heavy-work-owner-v1";
  const DOWNLOAD_KEY = "eco-local-download-owner-v1";

  afterEach(() => {
    localStorage.removeItem(RUNTIME_KEY);
    localStorage.removeItem(DOWNLOAD_KEY);
  });

  it("fails honestly (no generation) while a model switch holds the runtime", async () => {
    const switching = acquireLocalHeavyWork("switch-model");
    expect(switching.ok).toBe(true);
    setScripts([{ kind: "tokens", tokens: ["should not run"] }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hi");
    });

    expect(generateCalls).toHaveLength(0);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("error");
    expect(assistant.errorMessage).toMatch(/preparing a local model/i);
    if (switching.ok) switching.release();
  });

  it("releases the lease after a completed reply (a switch may start again)", async () => {
    setScripts([{ kind: "tokens", tokens: ["Hi", "!"] }]);
    setLastUsage({ promptTokens: 4, completionTokens: 2, maxTokens: 1024 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(lastAssistant()!.status).toBe("complete");
    const probe = acquireLocalHeavyWork("switch-model");
    expect(probe.ok).toBe(true);
    if (probe.ok) probe.release();
  });

  it("releases the lease after a stream error", async () => {
    setScripts([{ kind: "error", tokens: ["par"], error: new Error("stream exploded") }]);

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hello");
    });

    const probe = acquireLocalHeavyWork("switch-model");
    expect(probe.ok).toBe(true);
    if (probe.ok) probe.release();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// eco-smart slot dispatch (slice 2a regression pin)
// ═══════════════════════════════════════════════════════════════════════════
//
// The eco-smart slot is dormant today but slice 2b binds the upgraded model
// there. Pin that a concrete model bound to eco-smart dispatches through the
// smart slot — the reverse-lookup must not collapse to the hardcoded
// 'eco-fast' fallback (that fallback is only for models bound to NO slot).

describe("useChat — a model bound to eco-smart dispatches (no eco-fast collapse)", () => {
  it("sends through the eco-smart slot's model", async () => {
    const smartModel = {
      id: GEMMA_LITERT_MODEL_ID,
      friendlyName: "Gemma E2B LiteRT (test)",
    } as unknown as SlotState["model"];
    shared.smartSlotState = {
      slot: "eco-smart" as Slot,
      modelId: GEMMA_LITERT_MODEL_ID,
      model: smartModel,
      status: "ready",
    };
    useChatStore.setState({ selectedModel: GEMMA_LITERT_MODEL_ID });
    setScripts([{ kind: "tokens", tokens: ["From ", "smart"] }]);
    setLastUsage({ promptTokens: 4, completionTokens: 2, maxTokens: 1024 });

    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]!.modelId).toBe(GEMMA_LITERT_MODEL_ID);
    const assistant = lastAssistant()!;
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toBe("From smart");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The shrunk context window note
// ═══════════════════════════════════════════════════════════════════════════
//
// Models hold different amounts of a conversation (the everyday 1.2B holds
// 8192 tokens, the LiteRT build 2048). Switching to a model that holds LESS
// quietly pushes more of the history out of context: the divider moves and
// nothing says why. The note says why, ONCE, and only when it is actually
// true — the window shrank AND this conversation overflows the new one.

describe("useChat — the out-of-context note", () => {
  /** A conversation big enough to overflow 2048 tokens but fit inside 8192. */
  function seedLongConversation(): void {
    const paragraph = "word ".repeat(500); // ~2500 chars ≈ 625 tokens
    useChatStore.setState({
      messages: [
        { id: "u1", role: "user", content: paragraph, createdAt: 1, parentId: null },
        { id: "a1", role: "assistant", content: paragraph, createdAt: 2, parentId: "u1" },
        { id: "u2", role: "user", content: paragraph, createdAt: 3, parentId: "a1" },
        { id: "a2", role: "assistant", content: paragraph, createdAt: 4, parentId: "u2" },
        { id: "u3", role: "user", content: "and finally?", createdAt: 5, parentId: "a2" },
      ],
    });
  }

  function bindSmallerModelToSmartSlot(): void {
    shared.smartSlotState = {
      slot: "eco-smart" as Slot,
      modelId: GEMMA_LITERT_MODEL_ID,
      model: {
        id: GEMMA_LITERT_MODEL_ID,
        friendlyName: "Gemma E2B LiteRT (test)",
      } as unknown as SlotState["model"],
      status: "ready",
    };
  }

  it("raises the note as soon as the chat overflows the model's window", async () => {
    seedLongConversation();
    bindSmallerModelToSmartSlot();
    useChatStore.setState({ selectedModel: "eco-fast" });

    const { result } = renderHook(() => useChat());
    // The whole conversation fits the 8192-token model: nothing is out of
    // context yet, so there is nothing to say.
    expect(result.current.contextDividerIndex).toBe(-1);
    expect(useChatStore.getState().contextWindowNotice).toBe("none");

    await act(async () => {
      useChatStore.setState({ selectedModel: "eco-smart" });
    });

    // The 2048-token model cannot hold it, so the divider appears and the
    // note says so by the composer.
    expect(result.current.contextDividerIndex).toBeGreaterThan(0);
    expect(useChatStore.getState().contextWindowNotice).toBe("visible");
  });

  it("stays quiet while the chat fits the window", async () => {
    bindSmallerModelToSmartSlot();
    useChatStore.setState({
      selectedModel: "eco-smart",
      messages: [
        { id: "u1", role: "user", content: "hi", createdAt: 1, parentId: null },
        { id: "a1", role: "assistant", content: "hello", createdAt: 2, parentId: "u1" },
      ],
    });

    const { result } = renderHook(() => useChat());

    expect(result.current.contextDividerIndex).toBe(-1);
    expect(useChatStore.getState().contextWindowNotice).toBe("none");
  });

  it("withdraws when a larger window holds the whole chat again", async () => {
    seedLongConversation();
    bindSmallerModelToSmartSlot();
    useChatStore.setState({ selectedModel: "eco-smart" });

    const { result } = renderHook(() => useChat());
    expect(useChatStore.getState().contextWindowNotice).toBe("visible");

    await act(async () => {
      useChatStore.setState({ selectedModel: "eco-fast" });
    });

    expect(result.current.contextDividerIndex).toBe(-1);
    expect(useChatStore.getState().contextWindowNotice).toBe("none");
  });

  it("a dismissal holds for the conversation even as more falls out of context", async () => {
    seedLongConversation();
    bindSmallerModelToSmartSlot();
    useChatStore.setState({ selectedModel: "eco-smart" });

    renderHook(() => useChat());
    expect(useChatStore.getState().contextWindowNotice).toBe("visible");
    useChatStore.getState().dismissContextWindowNotice();

    const paragraph = "word ".repeat(500);
    await act(async () => {
      useChatStore.getState().addMessage({ role: "user", content: paragraph, parentId: "a2" });
    });

    expect(useChatStore.getState().contextWindowNotice).toBe("dismissed");
  });
});
