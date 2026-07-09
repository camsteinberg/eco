// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useChatStore } from "../chatStore";

beforeEach(() => {
  localStorage.removeItem("eco-selected-model");
  localStorage.removeItem("eco-selected-model-explicit");
  useChatStore.setState({
    messages: [],
    composerDraft: "",
    streamPhase: "idle",
    loadAlmostReady: false,
    isStreaming: false,
    error: null,
    selectedModel: "auto",
  });
});

describe("useChatStore", () => {
  describe("initial state", () => {
    it("starts with an empty messages array", () => {
      expect(useChatStore.getState().messages).toEqual([]);
    });

    it("starts with isStreaming false", () => {
      expect(useChatStore.getState().isStreaming).toBe(false);
    });

    it("starts with no error", () => {
      expect(useChatStore.getState().error).toBeNull();
    });
  });

  describe("addMessage", () => {
    it("appends a message with a generated id", () => {
      useChatStore.getState().addMessage({ role: "user", content: "Hello" });
      const { messages } = useChatStore.getState();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe("user");
      expect(messages[0]!.content).toBe("Hello");
      expect(typeof messages[0]!.id).toBe("string");
      expect(messages[0]!.id.length).toBeGreaterThan(0);
    });

    it("appends messages in order", () => {
      useChatStore.getState().addMessage({ role: "user", content: "A" });
      useChatStore.getState().addMessage({ role: "assistant", content: "B" });
      const { messages } = useChatStore.getState();
      expect(messages).toHaveLength(2);
      expect(messages[0]!.content).toBe("A");
      expect(messages[1]!.content).toBe("B");
    });

    it("returns the id of the new message", () => {
      const id = useChatStore.getState().addMessage({ role: "user", content: "Hi" });
      expect(typeof id).toBe("string");
      expect(useChatStore.getState().messages[0]!.id).toBe(id);
    });
  });

  describe("appendToMessage", () => {
    it("appends a token to an existing message's content", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "He" });
      useChatStore.getState().appendToMessage(id, "llo");
      expect(useChatStore.getState().messages[0]!.content).toBe("Hello");
    });

    it("is a no-op when the id does not match any message", () => {
      useChatStore.getState().addMessage({ role: "assistant", content: "Hi" });
      useChatStore.getState().appendToMessage("nonexistent-id", " world");
      expect(useChatStore.getState().messages[0]!.content).toBe("Hi");
    });

    it("ignores late tokens after a message was interrupted or completed", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "Partial" });
      useChatStore.getState().updateMessage(id, {
        status: "complete",
        streamInterrupted: true,
      });

      useChatStore.getState().appendToMessage(id, " late token");

      expect(useChatStore.getState().messages[0]!).toMatchObject({
        content: "Partial",
        status: "complete",
        streamInterrupted: true,
      });
    });

    it("appends token with matching generationId and new seq", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "" });
      useChatStore.getState().updateMessage(id, { currentGenerationId: "gen-abc" });

      useChatStore.getState().appendToMessage(id, "Hello", "gen-abc", 1);

      const msg = useChatStore.getState().messages[0]!;
      expect(msg.content).toBe("Hello");
      expect(msg.lastSeq).toBe(1);
    });

    it("drops token with matching generationId but stale seq", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "Hi" });
      useChatStore.getState().updateMessage(id, { currentGenerationId: "gen-abc", lastSeq: 3 });

      useChatStore.getState().appendToMessage(id, " duplicate", "gen-abc", 2);

      expect(useChatStore.getState().messages[0]!.content).toBe("Hi");
      expect(useChatStore.getState().messages[0]!.lastSeq).toBe(3);
    });

    it("drops token with wrong generationId", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "Hi" });
      useChatStore.getState().updateMessage(id, { currentGenerationId: "gen-current" });

      useChatStore.getState().appendToMessage(id, " stale", "gen-old", 1);

      expect(useChatStore.getState().messages[0]!.content).toBe("Hi");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toContain("stale generation");
      warnSpy.mockRestore();
    });

    it("drops token to a complete message (existing behavior preserved)", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "Done" });
      useChatStore.getState().updateMessage(id, { status: "complete" });

      useChatStore.getState().appendToMessage(id, " extra", "gen-abc", 1);

      expect(useChatStore.getState().messages[0]!.content).toBe("Done");
    });

    it("accepts token without generationId for backward compatibility", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "" });

      useChatStore.getState().appendToMessage(id, "Hello");

      expect(useChatStore.getState().messages[0]!.content).toBe("Hello");
    });

    it("increments tokenCount by 1 per call when no tokenDelta is given (backward compat)", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "" });

      useChatStore.getState().appendToMessage(id, "He");
      useChatStore.getState().appendToMessage(id, "llo");

      expect(useChatStore.getState().messages[0]!.tokenCount).toBe(2);
    });

    it("increments tokenCount by an explicit tokenDelta (token-delta passthrough)", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "" });
      useChatStore.getState().updateMessage(id, { currentGenerationId: "gen-x" });

      // One metered char-flush that carried 3 stream tokens worth of text.
      useChatStore.getState().appendToMessage(id, "Hello world", "gen-x", 1, 3);
      // A pure-drain frame: chars released, but no new stream token arrived.
      useChatStore.getState().appendToMessage(id, "!", "gen-x", 2, 0);

      expect(useChatStore.getState().messages[0]!.tokenCount).toBe(3);
      expect(useChatStore.getState().messages[0]!.content).toBe("Hello world!");
    });
  });

  describe("setError", () => {
    it("sets an error string", () => {
      useChatStore.getState().setError("Something went wrong");
      expect(useChatStore.getState().error).toBe("Something went wrong");
    });

    it("clears the error when called with null", () => {
      useChatStore.getState().setError("oops");
      useChatStore.getState().setError(null);
      expect(useChatStore.getState().error).toBeNull();
    });
  });

  describe("clearMessages", () => {
    it("removes all messages and resets streaming and error state", () => {
      useChatStore.getState().addMessage({ role: "user", content: "Hi" });
      useChatStore.getState().setComposerDraft("Keep this local");
      useChatStore.getState().setStreamPhase("thinking");
      useChatStore.getState().setError("bad");
      useChatStore.getState().clearMessages();
      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(0);
      expect(state.composerDraft).toBe("");
      expect(state.isStreaming).toBe(false);
      expect(state.error).toBeNull();
    });

    it("can preserve the persisted composer draft while clearing workspace messages", () => {
      useChatStore.getState().addMessage({ role: "user", content: "Hi" });
      useChatStore.getState().setComposerDraft("Keep this local");
      useChatStore.getState().setStreamPhase("thinking");

      useChatStore.getState().clearMessages({ preserveComposerDraft: true });

      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(0);
      expect(state.composerDraft).toBe("Keep this local");
      expect(state.isStreaming).toBe(false);
      expect(localStorage.getItem("eco-composer-draft")).toBe("Keep this local");
    });
  });

  describe("composerDraft", () => {
    it("stores and clears the composer draft", () => {
      useChatStore.getState().setComposerDraft("Resume this");
      expect(useChatStore.getState().composerDraft).toBe("Resume this");

      useChatStore.getState().clearComposerDraft();
      expect(useChatStore.getState().composerDraft).toBe("");
    });
  });

  describe("persisted model selection migration", () => {
    it("fails closed from stale raw local model ids to neutral Auto", () => {
      localStorage.setItem("eco-selected-model", "local/retired-smoke-model");
      localStorage.setItem("eco-selected-model-explicit", "true");

      useChatStore.getState().restorePersistedPreferences();

      expect(useChatStore.getState().selectedModel).toBe("auto");
    });

    it("does not hydrate old concrete launch selections without product eligibility", () => {
      localStorage.setItem("eco-selected-model", "local/smollm3-3b");
      localStorage.setItem("eco-selected-model-explicit", "true");

      useChatStore.getState().restorePersistedPreferences();

      expect(useChatStore.getState().selectedModel).toBe("auto");
    });

    it("preserves explicit Eco slots without restoring raw hidden model ids", () => {
      localStorage.setItem("eco-selected-model", "eco-fast");
      localStorage.setItem("eco-selected-model-explicit", "true");

      useChatStore.getState().restorePersistedPreferences();

      expect(useChatStore.getState().selectedModel).toBe("eco-fast");
    });
  });

  describe("StreamPhase", () => {
    it("initial streamPhase is 'idle'", () => {
      expect(useChatStore.getState().streamPhase).toBe("idle");
    });

    it("setStreamPhase('thinking') updates streamPhase to 'thinking'", () => {
      useChatStore.getState().setStreamPhase("thinking");
      expect(useChatStore.getState().streamPhase).toBe("thinking");
    });

    it("setStreamPhase('loading') updates streamPhase to 'loading' and is streaming", () => {
      // The cold-load "Warming up Eco…" phase (#4 W3a) is a non-idle phase, so
      // the chat surface treats the turn as in-flight while the model warms.
      useChatStore.getState().setStreamPhase("loading");
      expect(useChatStore.getState().streamPhase).toBe("loading");
      expect(useChatStore.getState().isStreaming).toBe(true);
    });

    it("isStreaming returns true when streamPhase is not 'idle'", () => {
      useChatStore.getState().setStreamPhase("thinking");
      expect(useChatStore.getState().isStreaming).toBe(true);

      useChatStore.getState().setStreamPhase("loading");
      expect(useChatStore.getState().isStreaming).toBe(true);

      useChatStore.getState().setStreamPhase("generating");
      expect(useChatStore.getState().isStreaming).toBe(true);

      useChatStore.getState().setStreamPhase("queued");
      expect(useChatStore.getState().isStreaming).toBe(true);

      useChatStore.getState().setStreamPhase("tool-executing");
      expect(useChatStore.getState().isStreaming).toBe(true);
    });

    it("isStreaming returns false when streamPhase is 'idle'", () => {
      useChatStore.getState().setStreamPhase("thinking");
      useChatStore.getState().setStreamPhase("idle");
      expect(useChatStore.getState().isStreaming).toBe(false);
    });

    it("clearMessages resets streamPhase to 'idle'", () => {
      useChatStore.getState().setStreamPhase("generating");
      useChatStore.getState().clearMessages();
      expect(useChatStore.getState().streamPhase).toBe("idle");
    });

    it("setMessages resets streamPhase to 'idle'", () => {
      useChatStore.getState().setStreamPhase("tool-executing");
      useChatStore.getState().setMessages([]);
      expect(useChatStore.getState().streamPhase).toBe("idle");
    });
  });

  describe("loadAlmostReady (cold-load 'almost ready' signal)", () => {
    it("initial loadAlmostReady is false", () => {
      expect(useChatStore.getState().loadAlmostReady).toBe(false);
    });

    it("setLoadAlmostReady(true) flips the flag", () => {
      useChatStore.getState().setLoadAlmostReady(true);
      expect(useChatStore.getState().loadAlmostReady).toBe(true);
      useChatStore.getState().setLoadAlmostReady(false);
      expect(useChatStore.getState().loadAlmostReady).toBe(false);
    });

    it("stays set while phase remains 'loading'", () => {
      useChatStore.getState().setStreamPhase("loading");
      useChatStore.getState().setLoadAlmostReady(true);
      // Re-entering loading (e.g. a redundant setStreamPhase) must not clear it.
      useChatStore.getState().setStreamPhase("loading");
      expect(useChatStore.getState().loadAlmostReady).toBe(true);
    });

    it("setStreamPhase('generating') clears loadAlmostReady", () => {
      useChatStore.getState().setStreamPhase("loading");
      useChatStore.getState().setLoadAlmostReady(true);
      useChatStore.getState().setStreamPhase("generating");
      expect(useChatStore.getState().loadAlmostReady).toBe(false);
    });

    it("any non-loading phase clears loadAlmostReady", () => {
      for (const phase of ["idle", "queued", "thinking", "tool-executing"] as const) {
        useChatStore.getState().setStreamPhase("loading");
        useChatStore.getState().setLoadAlmostReady(true);
        useChatStore.getState().setStreamPhase(phase);
        expect(useChatStore.getState().loadAlmostReady).toBe(false);
      }
    });

    it("clearMessages clears loadAlmostReady", () => {
      useChatStore.getState().setStreamPhase("loading");
      useChatStore.getState().setLoadAlmostReady(true);
      useChatStore.getState().clearMessages();
      expect(useChatStore.getState().loadAlmostReady).toBe(false);
    });

    it("clearSessionState clears loadAlmostReady", () => {
      useChatStore.getState().setStreamPhase("loading");
      useChatStore.getState().setLoadAlmostReady(true);
      useChatStore.getState().clearSessionState();
      expect(useChatStore.getState().loadAlmostReady).toBe(false);
    });

    it("setMessages clears loadAlmostReady", () => {
      useChatStore.getState().setStreamPhase("loading");
      useChatStore.getState().setLoadAlmostReady(true);
      useChatStore.getState().setMessages([]);
      expect(useChatStore.getState().loadAlmostReady).toBe(false);
    });
  });

  describe("updateMessageVerification", () => {
    it("sets verification on the matching message", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "" });
      useChatStore.getState().updateMessageVerification(id, { status: "unverified" });
      const msg = useChatStore.getState().messages.find((m) => m.id === id)!;
      expect(msg.verification).toEqual({ status: "unverified" });
    });

    it("leaves other messages untouched", () => {
      const otherId = useChatStore.getState().addMessage({ role: "user", content: "Hi" });
      const targetId = useChatStore.getState().addMessage({ role: "assistant", content: "" });
      useChatStore.getState().updateMessageVerification(targetId, { status: "unreachable" });
      const messages = useChatStore.getState().messages;
      expect(messages.find((m) => m.id === targetId)!.verification).toEqual({
        status: "unreachable",
      });
      expect(messages.find((m) => m.id === otherId)!.verification).toBeUndefined();
    });

    it("is a no-op for an unknown id", () => {
      const id = useChatStore.getState().addMessage({ role: "assistant", content: "" });
      useChatStore.getState().updateMessageVerification("does-not-exist", { status: "unverified" });
      expect(useChatStore.getState().messages.find((m) => m.id === id)!.verification).toBeUndefined();
    });
  });
});
