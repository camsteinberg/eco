// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WIRING PROOF for the conversation-integrity guarantee (#27) on the
 * offline-continue completion path.
 *
 * The primary stream always redacted a leaking third-party draft; the
 * offline-continue path (`continueInterruptedMessageLocally`, reached from
 * `retryMessage` when an interrupted reply is resumed offline) used to finalize
 * WITHOUT the guard, so a private detail could survive into the message. This
 * test drives that exact path — an armed conversation, an interrupted leaking
 * partial, `navigator.onLine === false` — and asserts the finalized reply is
 * clean. It renders `useChat` and scripts the inference shim like the recovery
 * seam net, adding only the recovery-model resolver and the offline flag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { Slot } from "../../local-ai/types";
import type { TokenStream } from "../../local-ai/runtime/stream";
import { scriptedTokenStream } from "../../__tests__/helpers/token-stream";

type StreamScript = { tokens: string[] };

const shared = vi.hoisted(() => {
  const TEST_MODEL_ID = "candidate/lfm2.5-1.2b-instruct-onnx";
  const READY_FAST_MODEL = {
    id: TEST_MODEL_ID,
    friendlyName: "Eco Fast (test)",
  } as unknown as SlotState["model"];
  function makeReadyFastSlot(): SlotState {
    return { slot: "eco-fast" as Slot, modelId: TEST_MODEL_ID, model: READY_FAST_MODEL, status: "ready" };
  }
  function makeEmptySmartSlot(): SlotState {
    return { slot: "eco-smart" as Slot, modelId: null, model: null, status: "empty" };
  }
  return {
    TEST_MODEL_ID,
    makeReadyFastSlot,
    makeEmptySmartSlot,
    scripts: [] as StreamScript[],
    fastSlotState: undefined as SlotState | undefined,
    smartSlotState: undefined as SlotState | undefined,
  };
});

const TEST_MODEL_ID = shared.TEST_MODEL_ID;

vi.mock("../../local-ai/runtime/stream", () => ({
  stream: (): TokenStream =>
    scriptedTokenStream({ tokens: shared.scripts.shift()?.tokens ?? [] }),
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

// The offline branch of retryMessage resolves a ready local model to continue with.
vi.mock("../../local-ai/lifecycle/recovery", () => ({
  resolveReadyLocalRecoveryModelId: async () => shared.TEST_MODEL_ID,
}));

// Imports AFTER the mocks so the hook picks up the mocked seams.
import { useChat } from "../useChat";
import { useChatStore } from "../../stores/chatStore";

// The single-turn "nora"-shape: the private detail, the privacy marker and the
// draft-to-someone ask all in one turn — this arms the guard (fabricated input).
const ARMED_PROMPT =
  "i need to email the events team to cancel my slot. the real reason is my husband " +
  "is having surgery at the hospital that day, but its private. write it";

// A leaking partial the interrupted reply left behind (raw — the interrupted
// primary path keeps partial text un-redacted, which is exactly the exposure).
const LEAKING_PARTIAL =
  "Hi events team, I need to cancel my slot. My husband is having surgery at the hospital that day.";

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
  return [...useChatStore.getState().messages].reverse().find((m) => m.role === "assistant");
}

let onLineSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  shared.scripts = [];
  shared.fastSlotState = shared.makeReadyFastSlot();
  shared.smartSlotState = shared.makeEmptySmartSlot();
  resetChatStore();
});

afterEach(() => {
  onLineSpy?.mockRestore();
  onLineSpy = null;
  vi.restoreAllMocks();
});

describe("useChat — offline-continue carries the #27 integrity guarantee", () => {
  it("redacts a leaking interrupted third-party draft when resumed offline", async () => {
    // 1. Build a real armed conversation with a clean first reply.
    shared.scripts = [{ tokens: ["ok"] }, { tokens: [" Thanks for understanding."] }];
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.sendMessage(ARMED_PROMPT);
    });
    const assistant = lastAssistant()!;

    // 2. Simulate the interruption: the reply was cut off mid-stream with a raw,
    //    un-redacted leaking partial still on screen.
    act(() => {
      useChatStore.setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistant.id
            ? { ...m, content: LEAKING_PARTIAL, status: "complete", streamInterrupted: true }
            : m,
        ),
      }));
    });

    // 3. Go offline so retry resumes locally via continueInterruptedMessageLocally.
    onLineSpy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

    // 4. Resume the interrupted reply offline.
    await act(async () => {
      await result.current.retryMessage(assistant.id);
    });

    // 5. The finalized reply must not carry the private detail anymore.
    const finalContent = useChatStore.getState().messages.find((m) => m.id === assistant.id)!.content;
    expect(finalContent).not.toMatch(/surgery/i);
    expect(finalContent).not.toMatch(/hospital/i);
    // ...while keeping the legitimate, non-leaking prose of the message.
    expect(finalContent).toMatch(/events team/i);
  });
});
