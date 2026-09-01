// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * What `handleAssistantAction` actually does when a per-reply control is
 * pressed.
 *
 * The sibling file `__tests__/reply-recovery-actions.test.ts` pins the
 * CONDITIONS each control resolves to on every catalog model. This one pins the
 * DISPATCH: which of the two mechanisms runs (a regenerate with overrides, or
 * the canned `continue` turn), with which arguments, and which presses are
 * deliberately no-ops.
 *
 * Most of it drives the handler with spies, so a gate can be tested without a
 * stream. The last block wires the REAL `useChat` behind the same scripted shim
 * the seam suite uses, so at least one path is measured end to end: press
 * "Make shorter" and watch the directive arrive at the model on a sibling
 * generation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { Slot } from "../../local-ai/types";
import type { TokenStream } from "../../local-ai/runtime/stream";
import { scriptedTokenStream } from "../../__tests__/helpers/token-stream";

// ─── Scripted-stream shim seam (mirrors the recovery-seam suite) ───────────

type GenerateCall = {
  messages: Array<{ role: string; content: string }>;
  modelId: string;
  options: Record<string, unknown> | undefined;
};

const shared = vi.hoisted(() => {
  const TEST_MODEL_ID = "candidate/lfm2.5-1.2b-instruct-onnx";
  const READY_FAST_MODEL = {
    id: TEST_MODEL_ID,
    friendlyName: "Eco Fast (test)",
  } as unknown as SlotState["model"];

  return {
    TEST_MODEL_ID,
    makeReadyFastSlot: (): SlotState => ({
      slot: "eco-fast" as Slot,
      modelId: TEST_MODEL_ID,
      model: READY_FAST_MODEL,
      status: "ready",
    }),
    makeEmptySmartSlot: (): SlotState => ({
      slot: "eco-smart" as Slot,
      modelId: null,
      model: null,
      status: "empty",
    }),
    generateCalls: [] as GenerateCall[],
    scripts: [] as string[][],
    lastUsage: null as { promptTokens?: number; completionTokens?: number } | null,
    lastTemplateName: null as string | null,
    fastSlotState: undefined as SlotState | undefined,
    smartSlotState: undefined as SlotState | undefined,
  };
});

const TEST_MODEL_ID = shared.TEST_MODEL_ID;
const generateCalls = shared.generateCalls;

vi.mock("../../local-ai/runtime/stream", () => ({
  stream: (
    messages: Array<{ role: string; content: string }>,
    modelId: string,
    options: Record<string, unknown> | undefined,
  ): TokenStream => {
    shared.generateCalls.push({ messages, modelId, options });
    return scriptedTokenStream({
      tokens: shared.scripts.shift() ?? [],
      // Usage rides the terminating `done` event since R4b.
      done: {
        ...(shared.lastUsage ?? {}),
        ...(shared.lastTemplateName != null ? { tokenizerName: shared.lastTemplateName } : {}),
      },
    });
  },
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

vi.mock("../../local-ai/lifecycle/generation-receipt", () => ({
  recordGenerationReceipt: () => {},
  recordGenerationReceiptAsync: () => {},
  hashSystemPrompt: async () => "deadbeef",
}));

// Imports AFTER the mocks so the hooks pick up the mocked seams.
import { useChat } from "../useChat";
import { useConversationManager } from "../useConversationManager";
import { useChatStore, type ChatMessage } from "../../stores/chatStore";
import { getGenerationProfile } from "../../lib/chat-intent";
import {
  canDeepen,
  REPLY_CONTROL_TREATMENTS,
  SHORTER_MIN_COMPLETION_TOKENS,
  type ReplyRegenerateControl,
} from "../../lib/reply-controls";
import { getCatalog } from "../../local-ai/catalog/catalog";
import type { AssistantReplyControl } from "../../components/chat/MessageActions";

// ─── Fixtures ──────────────────────────────────────────────────────────────

/**
 * ★ THE THREE SHIPPED DIRECTIVES, PINNED BY EXACT BYTES.
 *
 * These are transcribed here on purpose rather than imported: an assertion that
 * compares the module against itself passes through any reword. Rewording one
 * of them silently re-creates the defect this feature exists to fix — the
 * closed-direction strings are chosen so `hasExplicitFormatInstruction` fires
 * and the contradicting per-intent hint is dropped, and the near-miss
 * phrasings ("Be concise.", "Explain it in plain, everyday language.") do not
 * fire. Every verdict is pinned in `__tests__/reply-recovery-actions.test.ts`.
 */
const SHIPPED_DIRECTIVES = {
  shorter: "Keep it short. Lead with the answer itself.",
  expand: "Go deeper — cover what this is actually like in practice, not just the definition.",
  simplify: "Keep it simple. Explain it in plain, everyday language.",
} as const satisfies Record<ReplyRegenerateControl, string>;

const CONTINUE_TURN = "Continue your previous answer.";

const CATALOG_MODEL_IDS: readonly string[] = getCatalog().map((model) => model.id);

/**
 * Discovered from the real profiles, never listed: a model whose budget moves
 * between `quick` and `deep`, and one whose does not.
 */
const LADDER_MODEL_ID = CATALOG_MODEL_IDS.find((id) => canDeepen(id));
const FLAT_MODEL_ID = CATALOG_MODEL_IDS.find((id) => !canDeepen(id));

const TARGET_ID = "assistant-1";
const USER_ID = "user-1";
const ASK = "why do leaves change colour in the autumn";

function seedConversation(assistant: Partial<ChatMessage> = {}): void {
  useChatStore.setState({
    messages: [
      { id: USER_ID, role: "user", content: ASK, createdAt: 1, parentId: null },
      {
        id: TARGET_ID,
        role: "assistant",
        content: "Because chlorophyll breaks down.",
        createdAt: 2,
        parentId: USER_ID,
        status: "complete",
        ...assistant,
      },
    ],
  });
}

type Spies = {
  sendMessage: ReturnType<typeof vi.fn>;
  regenerateMessage: ReturnType<typeof vi.fn>;
};

/** Render the manager with spies in place of the chat hook's write paths. */
function renderManager(options: { isStreaming?: boolean; modelId?: string } = {}) {
  const spies: Spies = { sendMessage: vi.fn(), regenerateMessage: vi.fn() };
  useChatStore.setState({ selectedModel: options.modelId ?? TEST_MODEL_ID });
  const { result } = renderHook(() =>
    useConversationManager({
      messages: useChatStore.getState().messages,
      isStreaming: options.isStreaming ?? false,
      // A null conversation keeps the persistence effects inert: the load
      // effect early-returns when neither the id nor the leaf has changed, and
      // the sync effect returns on a null id. Nothing here touches IndexedDB.
      activeConversationId: null,
      activeConversationLeafId: null,
      sendMessage: spies.sendMessage,
      editMessage: vi.fn(),
      regenerateMessage: spies.regenerateMessage,
      clearComposerDraft: vi.fn(),
    }),
  );
  return { result, spies };
}

function press(
  result: { current: { handleAssistantAction: (id: string, a: AssistantReplyControl) => void } },
  control: AssistantReplyControl,
): void {
  act(() => {
    result.current.handleAssistantAction(TARGET_ID, control);
  });
}

beforeEach(() => {
  shared.generateCalls.length = 0;
  shared.scripts = [];
  shared.lastUsage = null;
  shared.lastTemplateName = null;
  shared.fastSlotState = shared.makeReadyFastSlot();
  shared.smartSlotState = shared.makeEmptySmartSlot();
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
  seedConversation();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════
// The instrument
// ═════════════════════════════════════════════════════════════════════════

describe("reply controls — the instrument", () => {
  it("has both a flat and a ladder model to test the gate against", () => {
    // Without both sides the capability-gate tests below would pass against a
    // predicate that had degenerated to a constant.
    expect(LADDER_MODEL_ID, "no catalog model admits the open direction").toBeDefined();
    expect(FLAT_MODEL_ID, "every catalog model admits the open direction").toBeDefined();
  });

  it("ships exactly the directive strings pinned here", () => {
    for (const control of Object.keys(SHIPPED_DIRECTIVES) as ReplyRegenerateControl[]) {
      const directive = SHIPPED_DIRECTIVES[control];
      expect(
        REPLY_CONTROL_TREATMENTS[control].directive,
        `the "${control}" directive was reworded. It is chosen against `
          + `hasExplicitFormatInstruction, not for tone — see the verdict pins in `
          + `__tests__/reply-recovery-actions.test.ts before changing it.`,
      ).toBe(directive);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 1. Which mechanism each control runs
// ═════════════════════════════════════════════════════════════════════════

describe("reply controls — dispatch", () => {
  it("regenerates the target with the forced intent and the exact directive", () => {
    for (const control of ["shorter", "expand", "simplify"] as const) {
      const { result, spies } = renderManager({ modelId: LADDER_MODEL_ID });
      press(result, control);
      expect(spies.regenerateMessage).toHaveBeenCalledTimes(1);
      expect(spies.regenerateMessage).toHaveBeenCalledWith(TARGET_ID, {
        intent: REPLY_CONTROL_TREATMENTS[control].intent,
        turnDirective: SHIPPED_DIRECTIVES[control],
      });
      // It regenerates; it does not send a turn about the previous answer.
      expect(spies.sendMessage).not.toHaveBeenCalled();
    }
  });

  it("forces quick for the closed direction and deep for the open one", () => {
    // Named separately from the call-shape assertion so a swapped pair reads as
    // what it is rather than as a directive mismatch.
    expect(REPLY_CONTROL_TREATMENTS.shorter.intent).toBe("quick");
    expect(REPLY_CONTROL_TREATMENTS.simplify.intent).toBe("quick");
    expect(REPLY_CONTROL_TREATMENTS.expand.intent).toBe("deep");
  });

  it("still sends a canned turn for continue", () => {
    // Continuation needs the partial reply in the history, so this one stays a
    // turn — there is no assistant-prefix continuation to regenerate into.
    const { result, spies } = renderManager();
    press(result, "continue");
    expect(spies.sendMessage).toHaveBeenCalledWith(CONTINUE_TURN);
    expect(spies.regenerateMessage).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. The capability gate
// ═════════════════════════════════════════════════════════════════════════

describe("reply controls — the open direction is gated on real capability", () => {
  it("expands on a model whose budget moves between intents", () => {
    const modelId = LADDER_MODEL_ID!;
    // Asserted, not assumed: this model really does have headroom.
    expect(getGenerationProfile("deep", true, modelId).maxTokens).toBeGreaterThan(
      getGenerationProfile("quick", true, modelId).maxTokens,
    );
    const { result, spies } = renderManager({ modelId });
    press(result, "expand");
    expect(spies.regenerateMessage).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a model whose budget is flat", () => {
    const modelId = FLAT_MODEL_ID!;
    expect(getGenerationProfile("deep", true, modelId).maxTokens).toBe(
      getGenerationProfile("quick", true, modelId).maxTokens,
    );
    const { result, spies } = renderManager({ modelId });
    press(result, "expand");
    expect(spies.regenerateMessage).not.toHaveBeenCalled();
    expect(spies.sendMessage).not.toHaveBeenCalled();
  });

  it("gates only the open direction", () => {
    // ★ THE COUNTERWEIGHT. "expand does nothing on a flat model" is also
    // satisfied by a handler that has stopped dispatching anything at all.
    const { result, spies } = renderManager({ modelId: FLAT_MODEL_ID });
    press(result, "shorter");
    expect(spies.regenerateMessage).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Truncation reroutes expand to continue
// ═════════════════════════════════════════════════════════════════════════

describe("reply controls — a truncated reply is continued, not replaced", () => {
  it("sends the continue turn instead of regenerating", () => {
    // A reply that stopped at its ceiling has more to say. Regenerating would
    // throw away what the user already read and very likely hit the same
    // ceiling again, so the press adds to the reply instead.
    seedConversation({ possiblyTruncated: true });
    const { result, spies } = renderManager({ modelId: LADDER_MODEL_ID });
    press(result, "expand");
    expect(spies.sendMessage).toHaveBeenCalledWith(CONTINUE_TURN);
    expect(spies.regenerateMessage).not.toHaveBeenCalled();
  });

  it("reroutes only expand — the closed direction still regenerates", () => {
    // ★ THE COUNTERWEIGHT: a handler that routed everything to `continue` when
    // a reply is truncated would satisfy the assertion above.
    seedConversation({ possiblyTruncated: true });
    const { result, spies } = renderManager({ modelId: LADDER_MODEL_ID });
    press(result, "shorter");
    expect(spies.regenerateMessage).toHaveBeenCalledTimes(1);
    expect(spies.sendMessage).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. The already-short floor
// ═════════════════════════════════════════════════════════════════════════

describe("reply controls — shorter is a no-op on an already-short reply", () => {
  it("does nothing below the floor", () => {
    seedConversation({ localCompletionTokens: SHORTER_MIN_COMPLETION_TOKENS - 1 });
    const { result, spies } = renderManager();
    press(result, "shorter");
    expect(spies.regenerateMessage).not.toHaveBeenCalled();
    expect(spies.sendMessage).not.toHaveBeenCalled();
  });

  it("regenerates at the floor and above", () => {
    seedConversation({ localCompletionTokens: SHORTER_MIN_COMPLETION_TOKENS });
    const { result, spies } = renderManager();
    press(result, "shorter");
    expect(spies.regenerateMessage).toHaveBeenCalledTimes(1);
  });

  it("regenerates when the reply carries no token count at all", () => {
    // `localCompletionTokens` is written to the chat store on completion and is
    // NOT copied by `toDbMessage`, so every reply restored from IndexedDB
    // arrives without it. The floor must fail OPEN on absence: never refuse a
    // control because of state we simply do not have.
    seedConversation();
    expect(
      useChatStore.getState().messages.find((m) => m.id === TARGET_ID)?.localCompletionTokens,
    ).toBeUndefined();
    const { result, spies } = renderManager();
    press(result, "shorter");
    expect(spies.regenerateMessage).toHaveBeenCalledTimes(1);
  });

  it("applies the floor only to shorter", () => {
    // ★ THE COUNTERWEIGHT: a handler that refused every control on a short
    // reply would satisfy `does nothing below the floor`.
    seedConversation({ localCompletionTokens: 1 });
    const { result, spies } = renderManager({ modelId: LADDER_MODEL_ID });
    press(result, "expand");
    expect(spies.regenerateMessage).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Mid-stream, every control is a no-op
// ═════════════════════════════════════════════════════════════════════════

describe("reply controls — mid-stream", () => {
  it("does nothing for any control while a reply is streaming", () => {
    for (const control of ["continue", "shorter", "expand", "simplify"] as const) {
      const { result, spies } = renderManager({
        isStreaming: true,
        modelId: LADDER_MODEL_ID,
      });
      press(result, control);
      expect(spies.regenerateMessage, `"${control}" fired mid-stream`).not.toHaveBeenCalled();
      expect(spies.sendMessage, `"${control}" fired mid-stream`).not.toHaveBeenCalled();
    }
  });

  it("dispatches the same presses once the stream ends", () => {
    // ★ THE COUNTERWEIGHT on the guard above: a handler wired to nothing would
    // pass it. Same presses, same fixtures, streaming off.
    for (const control of ["continue", "shorter", "expand", "simplify"] as const) {
      const { result, spies } = renderManager({ isStreaming: false, modelId: LADDER_MODEL_ID });
      press(result, control);
      expect(
        spies.regenerateMessage.mock.calls.length + spies.sendMessage.mock.calls.length,
        `"${control}" did nothing with the stream idle`,
      ).toBe(1);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. End to end: the press reaches the model, on a sibling
// ═════════════════════════════════════════════════════════════════════════

describe("reply controls — through the real chat hook", () => {
  it("sends the directive to the model and keeps the reply a sibling", async () => {
    shared.scripts = [["first"], ["second"]];
    // This one builds its own conversation through the real send path, so the
    // seeded fixture must go — otherwise the assertions below would find the
    // fixture's user turn instead of the one that was actually asked.
    useChatStore.setState({ messages: [] });
    const { result } = renderHook(() => {
      const chat = useChat();
      const manager = useConversationManager({
        messages: chat.messages,
        isStreaming: chat.isStreaming,
        activeConversationId: null,
        activeConversationLeafId: null,
        sendMessage: chat.sendMessage,
        editMessage: chat.editMessage,
        regenerateMessage: chat.regenerateMessage,
        clearComposerDraft: vi.fn(),
      });
      return { chat, manager };
    });

    await act(async () => {
      await result.current.chat.sendMessage(ASK);
    });
    const firstReply = [...useChatStore.getState().messages]
      .reverse()
      .find((m) => m.role === "assistant")!;

    act(() => {
      result.current.manager.handleAssistantAction(firstReply.id, "shorter");
    });
    await waitFor(() => {
      expect(generateCalls).toHaveLength(2);
    });

    // The directive rides the END of the user's own turn, once...
    const regenerated = generateCalls[1]!;
    const finalUserTurn = [...regenerated.messages].reverse().find((m) => m.role === "user")!;
    expect(finalUserTurn.content).toBe(`${ASK}\n\n${SHIPPED_DIRECTIVES.shorter}`);
    // ...with the closed-direction sampling the forced intent resolves to.
    const quick = getGenerationProfile("quick", true, TEST_MODEL_ID);
    expect(regenerated.options?.maxTokens).toBe(quick.maxTokens);
    expect(regenerated.options?.temperature).toBe(quick.temperature);

    // Nothing about the directive is written back to the conversation.
    await waitFor(() => {
      expect(useChatStore.getState().isStreaming).toBe(false);
    });
    const stored = useChatStore.getState().messages;
    expect(stored.some((m) => m.content.includes(SHIPPED_DIRECTIVES.shorter))).toBe(false);

    // And the new reply hangs off the same user turn as the one it replaced.
    const userTurn = stored.find((m) => m.role === "user")!;
    const newest = [...stored].reverse().find((m) => m.role === "assistant")!;
    expect(newest.id).not.toBe(firstReply.id);
    expect(newest.parentId).toBe(userTurn.id);
  });
});
