// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The chat's load and its first-token clock, end to end: the REAL `stream()`
 * drained by the REAL `runGeneration()`, with only the lifecycle faked.
 *
 * Setup proves a model with a cold-load budget of two to five minutes, then a
 * first-token deadline. The chat used to put the load inside its own 90s
 * first-token window, so a device whose cached load takes longer than 90s
 * passed setup and then failed every later visit. The load now has the budget
 * setup proved, and the 90s clock starts once the model is loaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createGeneration, type Generation } from "../generation";
import { runGeneration, type RunGenerationResult } from "../run-generation";
import { stream } from "../../../local-ai/runtime/stream";
import * as lifecycle from "../../../local-ai/runtime/lifecycle";
import { AdapterError, type LoadOptions, type GenerateOptions, type TokenEvent } from "../../../local-ai/runtime/types";
import type { ModelConfig } from "../../../local-ai/types";
import { useChatStore } from "../../../stores/chatStore";

const MODEL: ModelConfig = {
  id: "local/qwen3-0.6b",
  friendlyName: "Qwen3",
  vendor: "Alibaba",
  sizeGB: 0.57,
  runtime: "transformers",
  capabilities: { contextTokens: 4096 },
  maxNewTokens: { ceiling: 1024, default: 512, max: 2048, intentTokens: {} },
} as unknown as ModelConfig;

/** The cold-load budget setup proved for this model on this device. */
const LOAD_BUDGET_MS = 300_000;
const TTFT_DEADLINE_MS = 90_000;

vi.mock("../../../local-ai/bootstrap", () => ({
  bootstrapLocalAi: vi.fn(async () => undefined),
}));

vi.mock("../../../local-ai/catalog/catalog", () => ({
  getModel: (id: string): ModelConfig | null => (id === MODEL.id ? MODEL : null),
}));

vi.mock("../../../local-ai/eval/eval-candidates", () => ({
  getEvalCandidateModel: (): ModelConfig | null => null,
}));

vi.mock("../../../local-ai/lifecycle/smoke", () => ({
  defaultLoadBudgetMs: vi.fn(() => LOAD_BUDGET_MS),
}));

vi.mock("../../../local-ai/runtime/lifecycle", () => ({
  loadModel: vi.fn(),
  generate: vi.fn(),
  wasGpuLostThisPage: vi.fn(() => false),
}));

vi.mock("../../../lib/validation-harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/validation-harness")>()),
  consumeValidationGenerationFault: vi.fn(() => null),
  getValidationLocalGenerationFixture: vi.fn(() => null),
  isValidationHarnessEnabled: vi.fn(() => false),
}));

const mockLoad = lifecycle.loadModel as unknown as Mock;
const mockGenerate = lifecycle.generate as unknown as Mock;

const ADAPTER = { countTokens: async (text: string) => text.trim().split(/\s+/).length };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wait `ms` on the (fake) clock, or forever when `ms` is null; rejects early
 * when `signal` aborts, as the adapters do.
 */
function delay(ms: number | null, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = ms === null ? undefined : setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new AdapterError("aborted", "aborted", true));
    });
  });
}

/** A load that finishes after `ms`, or rejects as the adapters do when aborted. */
function loadsIn(ms: number | null, onSignal?: (signal: AbortSignal | undefined) => void) {
  return async (_model: unknown, options?: LoadOptions): Promise<unknown> => {
    onSignal?.(options?.signal);
    await delay(ms, options?.signal);
    return ADAPTER;
  };
}

/** A load that never finishes on its own. */
function loadsNever(onSignal?: (signal: AbortSignal | undefined) => void) {
  return loadsIn(null, onSignal);
}

/** A generation whose first word takes `ms` (null: never), then ends. */
function answersAfter(ms: number | null, onSignal?: (signal: AbortSignal | undefined) => void) {
  return (_messages: unknown, options?: GenerateOptions): AsyncIterable<TokenEvent> => ({
    async *[Symbol.asyncIterator]() {
      onSignal?.(options?.signal);
      if (ms !== 0) await delay(ms, options?.signal);
      yield { kind: "token", text: "Hello" };
      yield { kind: "done", promptTokens: 3, completionTokens: 1 };
    },
  });
}

function seedAssistant(generationId: string): string {
  const id = useChatStore.getState().addMessage({ role: "assistant", content: "" });
  useChatStore.getState().updateMessage(id, { status: "streaming", currentGenerationId: generationId });
  return id;
}

function makeGeneration(): Generation {
  return createGeneration((id, token, generationId, toSeq) => {
    useChatStore.getState().appendToMessage(id, token, generationId, toSeq);
  });
}

/** Start one turn and record its result whenever it lands. */
function startTurn(): {
  generation: Generation;
  tokens: ReturnType<typeof stream>;
  outcome: () => RunGenerationResult | null;
  done: Promise<RunGenerationResult>;
} {
  const generation = makeGeneration();
  const assistantId = seedAssistant(generation.id);
  const tokens = stream(
    [
      { role: "system", content: "You are Eco." },
      { role: "user", content: "Say hello." },
    ],
    MODEL.id,
  );
  let result: RunGenerationResult | null = null;
  let phase: "thinking" | "loading" | "generating" | "idle" = "loading";
  const done = runGeneration({
    generation,
    stream: tokens,
    assistantId,
    setStreamPhase: (next) => {
      phase = next as typeof phase;
    },
    getStreamPhase: () => phase,
    getMessageContent: (id) =>
      useChatStore.getState().messages.find((m) => m.id === id)?.content ?? "",
  }).then((r) => {
    result = r;
    return r;
  });
  return { generation, tokens, outcome: () => result, done };
}

function errorCode(result: RunGenerationResult | null): string | undefined {
  if (result?.status !== "error") return undefined;
  return (result.error as { code?: string }).code;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mockLoad.mockReset();
  mockGenerate.mockReset();
  useChatStore.setState({ messages: [], streamPhase: "idle", isStreaming: false, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("the chat's load has its own budget; the first-token clock starts when it ends", () => {
  it("answers after a 120s load that is followed at once by a word", async () => {
    mockLoad.mockImplementation(loadsIn(120_000));
    mockGenerate.mockImplementation(answersAfter(0));

    const turn = startTurn();
    await vi.advanceTimersByTimeAsync(121_000);

    const result = turn.outcome();
    expect(result?.status).toBe("completed");
    expect(result?.finalText).toBe("Hello");
  });

  it("times the first word from the end of the load, not the start of the turn", async () => {
    mockLoad.mockImplementation(loadsIn(200_000));
    mockGenerate.mockImplementation(answersAfter(80_000));

    const turn = startTurn();
    await vi.advanceTimersByTimeAsync(281_000);

    const result = turn.outcome();
    expect(result?.status).toBe("completed");
    expect(result?.finalText).toBe("Hello");
  });

  it("still gives a loaded model only 90s to its first word", async () => {
    let generateSignal: AbortSignal | undefined;
    mockLoad.mockResolvedValue(ADAPTER);
    mockGenerate.mockImplementation(answersAfter(null, (signal) => {
      generateSignal = signal;
    }));

    const turn = startTurn();
    await vi.advanceTimersByTimeAsync(TTFT_DEADLINE_MS - 1_000);
    expect(turn.outcome()).toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(turn.outcome()?.status).toBe("error");
    expect(errorCode(turn.outcome())).toBe("TIMEOUT");
    // The watchdog releases the runtime rather than abandoning it.
    expect(generateSignal?.aborted).toBe(true);
  });

  it("fails a load that outlasts its budget as a timeout, and aborts the load", async () => {
    let loadSignal: AbortSignal | undefined;
    mockLoad.mockImplementation(loadsNever((signal) => {
      loadSignal = signal;
    }));

    const turn = startTurn();
    // Well past the 90s first-token window: still loading, not failed.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(turn.outcome()).toBeNull();
    expect(loadSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(LOAD_BUDGET_MS - 200_000 + 1_000);
    // An error, never an empty "completed" reply.
    expect(turn.outcome()?.status).toBe("error");
    expect(errorCode(turn.outcome())).toBe("TIMEOUT");
    expect(loadSignal?.aborted).toBe(true);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("ends a turn stopped during the load cleanly, and leaves no timer behind", async () => {
    let loadSignal: AbortSignal | undefined;
    mockLoad.mockImplementation(loadsNever((signal) => {
      loadSignal = signal;
    }));

    const turn = startTurn();
    await vi.advanceTimersByTimeAsync(50_000);
    // What the Stop button does (interruptActiveGeneration).
    turn.generation.abortController.abort();
    turn.tokens.cancel();
    await vi.advanceTimersByTimeAsync(0);

    // A Stop ends the loop cleanly (the cancelled stream reads `done`); the
    // generation's abort signal is what tells useChat it was stopped.
    expect(turn.outcome()).toEqual({ status: "completed", finalText: "", done: null });
    expect(loadSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // Nothing fires later either.
    await vi.advanceTimersByTimeAsync(LOAD_BUDGET_MS + TTFT_DEADLINE_MS);
    expect(turn.outcome()?.status).toBe("completed");
  });
});
