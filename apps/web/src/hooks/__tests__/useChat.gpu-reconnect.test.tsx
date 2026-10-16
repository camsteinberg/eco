// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A send that cannot run because this page lost its GPU device and cannot get
 * another (`GPU_RECONNECT`): the turn shows the calm refresh copy, is saved
 * with that card, the page reloads once, and the reloaded page answers the
 * turn by itself.
 *
 * Renders `useChat` with the stream and slot seams mocked like the
 * characterization net; the page reload is a spy. The conversation store is
 * real, over fake-indexeddb.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { SlotState } from "../../local-ai/lifecycle/slots";
import type { Slot } from "../../local-ai/types";
import type { TokenStream } from "../../local-ai/runtime/stream";
import { scriptedTokenStream, type TokenStreamScript } from "../../__tests__/helpers/token-stream";

const shared = vi.hoisted(() => {
  const TEST_MODEL_ID = "candidate/lfm2.5-1.2b-instruct-onnx";
  return {
    TEST_MODEL_ID,
    fastSlot: {
      slot: "eco-fast",
      modelId: TEST_MODEL_ID,
      model: { id: TEST_MODEL_ID, friendlyName: "Eco Fast (test)" },
      status: "ready",
    } as unknown as SlotState,
    smartSlot: { slot: "eco-smart", modelId: null, model: null, status: "empty" } as unknown as SlotState,
    scripts: [] as TokenStreamScript[],
    streamCalls: 0,
    reloads: [] as Array<{ retry?: { conversationId: string; assistantId: string } }>,
    marker: null as { conversationId: string; assistantId: string } | null,
  };
});

vi.mock("../../local-ai/runtime/stream", () => ({
  stream: (): TokenStream => {
    shared.streamCalls++;
    return scriptedTokenStream(shared.scripts.shift() ?? {});
  },
}));

vi.mock("../../local-ai/lifecycle/slots", () => ({
  SLOTS: ["eco-fast", "eco-smart"] as ReadonlyArray<Slot>,
  getSlot: (slot: Slot): SlotState => (slot === "eco-fast" ? shared.fastSlot : shared.smartSlot),
  getSlotForModel: (modelId: string): Slot | null =>
    modelId === shared.TEST_MODEL_ID ? ("eco-fast" as Slot) : null,
  hasReadySlot: () => true,
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

vi.mock("../../lib/sounds", () => ({
  playMessageSent: () => {},
  playMessageReceived: () => {},
}));

vi.mock("../../local-ai/lifecycle/gpu-recovery", () => ({
  reloadPageForGpu: (options: { retry?: { conversationId: string; assistantId: string } }) => {
    shared.reloads.push(options);
    return true;
  },
  readGpuRetryMarker: () => shared.marker,
  clearGpuRetryMarker: () => {
    shared.marker = null;
  },
}));

// Imports AFTER the mocks so the hook picks up the mocked seams.
import { useChat } from "../useChat";
import { useChatStore, type ChatMessage } from "../../stores/chatStore";
import { useConversationStore } from "../../stores/conversationStore";
import { LocalInferenceStreamError } from "../../local-ai/runtime/errors";
import {
  GPU_RECONNECT_MESSAGE,
  LOCAL_RUNTIME_HICCUP_MESSAGE,
} from "../../local-ai/adapters/error-messages";

const CONVERSATION_ID = "conv-gpu-reconnect";

function resetChatStore(messages: ChatMessage[] = []): void {
  useChatStore.setState({
    messages,
    composerDraft: "",
    streamPhase: "idle",
    isStreaming: false,
    error: null,
    selectedModel: shared.TEST_MODEL_ID,
    fileAttachments: [],
    approvedTools: [],
    activeToolCalls: [],
    localToolNoticeShown: false,
    contextWindowNotice: "none",
    routeRecommendationSnapshot: null,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  shared.scripts = [];
  shared.streamCalls = 0;
  shared.reloads = [];
  shared.marker = null;
  resetChatStore();
  useConversationStore.setState({ activeConversationId: CONVERSATION_ID });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChat — a send this page cannot run until it reloads (GPU_RECONNECT)", () => {
  it("shows the refresh copy, saves the turn with it, and reloads once with the turn to answer", async () => {
    shared.scripts = [
      {
        error: new LocalInferenceStreamError("GPU_RECONNECT", GPU_RECONNECT_MESSAGE, true),
      },
    ];
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage("how far is the moon?");
    });
    await flush();

    const assistant = useChatStore.getState().messages.at(-1);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.status).toBe("error");
    expect(assistant?.errorMessage).toBe(GPU_RECONNECT_MESSAGE);
    expect(shared.reloads).toEqual([
      { retry: { conversationId: CONVERSATION_ID, assistantId: assistant!.id } },
    ]);

    const saved = await useConversationStore.getState().loadConversationMessages(CONVERSATION_ID);
    const savedAssistant = saved.find((m) => m.id === assistant!.id);
    expect(savedAssistant?.status).toBe("error");
    expect(savedAssistant?.errorMessage).toBe(GPU_RECONNECT_MESSAGE);
    expect(saved.some((m) => m.role === "user" && m.content === "how far is the moon?")).toBe(true);
  });

  it("does not reload when the turn could not be saved, and shows the crash card instead", async () => {
    const realSave = useConversationStore.getState().saveMessage;
    // The send's own early save succeeds; the save of the refresh card fails.
    useConversationStore.setState({
      saveMessage: async (message) => {
        if (message.status === "error") throw new Error("QuotaExceededError");
        await realSave(message);
      },
    });
    shared.scripts = [
      {
        error: new LocalInferenceStreamError("GPU_RECONNECT", GPU_RECONNECT_MESSAGE, true),
      },
    ];
    try {
      const { result } = renderHook(() => useChat());
      await act(async () => {
        await result.current.sendMessage("how far is the moon?");
      });
      await flush();

      expect(shared.reloads).toEqual([]);
      const assistant = useChatStore.getState().messages.at(-1);
      expect(assistant?.status).toBe("error");
      expect(assistant?.errorMessage).toBe(LOCAL_RUNTIME_HICCUP_MESSAGE);
    } finally {
      useConversationStore.setState({ saveMessage: realSave });
    }
  });

  it("answers the saved turn by itself after the reload, once its conversation has loaded", async () => {
    shared.marker = { conversationId: CONVERSATION_ID, assistantId: "a-1" };
    shared.scripts = [{ tokens: ["About 384,400 km."] }];
    const { unmount } = renderHook(() => useChat());
    await flush();
    expect(shared.streamCalls).toBe(0);

    // The conversation arrives from IndexedDB after mount.
    act(() => {
      resetChatStore([
        { id: "u-1", role: "user", content: "how far is the moon?", createdAt: 1 } as ChatMessage,
        {
          id: "a-1",
          role: "assistant",
          content: "",
          parentId: "u-1",
          createdAt: 2,
          status: "error",
          errorMessage: GPU_RECONNECT_MESSAGE,
        } as ChatMessage,
      ]);
    });
    await flush();

    expect(shared.streamCalls).toBe(1);
    expect(shared.marker).toBeNull();
    const answered = useChatStore.getState().messages.filter((m) => m.role === "assistant").at(-1);
    expect(answered?.content).toBe("About 384,400 km.");
    unmount();
  });

  it("leaves a conversation alone when the saved card is not its last message", async () => {
    shared.marker = { conversationId: CONVERSATION_ID, assistantId: "a-1" };
    renderHook(() => useChat());
    act(() => {
      resetChatStore([
        { id: "u-1", role: "user", content: "q", createdAt: 1 } as ChatMessage,
        { id: "a-1", role: "assistant", content: "", parentId: "u-1", createdAt: 2, status: "error" } as ChatMessage,
        { id: "u-2", role: "user", content: "newer", createdAt: 3 } as ChatMessage,
      ]);
    });
    await flush();
    expect(shared.streamCalls).toBe(0);
  });
});
