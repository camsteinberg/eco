// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("useChatStore selected model persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    window.history.replaceState({}, "", "/");
  });

  it("does not hydrate implicit concrete local defaults without default eligibility", async () => {
    localStorage.setItem("eco-selected-model", "local/qwen3-0.6b");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("falls back from persisted concrete smart model IDs to Auto without a safe slot assignment", async () => {
    localStorage.setItem("eco-selected-model", "local/smollm3-3b");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("falls back from stale local model IDs to Auto without default eligibility", async () => {
    localStorage.setItem("eco-selected-model", "local/removed-model");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("persists selected model updates to localStorage", async () => {
    const { useChatStore, SELECTED_MODEL_STORAGE_KEY } = await import("../chatStore");

    useChatStore.getState().setSelectedModel("eco-smart");

    expect(localStorage.getItem(SELECTED_MODEL_STORAGE_KEY)).toBe(
      "eco-smart",
    );
  });

  it("keeps new capable browsers on network-safe defaults until a local model is default-eligible", async () => {
    const {
      useChatStore,
      SELECTED_MODEL_STORAGE_KEY,
    } = await import("../chatStore");

    expect(localStorage.getItem(SELECTED_MODEL_STORAGE_KEY)).toBeNull();
    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("preserves explicit manual local choices on capable browsers without default eligibility", async () => {
    localStorage.setItem("eco-selected-model", "eco-fast");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("eco-fast");
  });

  it("preserves an EXPLICIT pick of a known catalog model verbatim — including candidate/ ids (2026-06-10 reversion fix)", async () => {
    // The shipping default has a `candidate/` id. Pre-fix it fell through every
    // normalize branch into the eco-fast catch-all, so an explicit Liquid pick
    // silently reverted to whatever stale model that slot still had bound
    // (observed live: "it switched back to Bonsai when I reloaded").
    localStorage.setItem("eco-selected-model", "candidate/lfm2.5-1.2b-instruct-onnx");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("candidate/lfm2.5-1.2b-instruct-onnx");
  });

  it("preserves an EXPLICIT pick of a local/ catalog model verbatim", async () => {
    localStorage.setItem("eco-selected-model", "local/qwen3-0.6b");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("local/qwen3-0.6b");
  });

  it("preserves an EXPLICIT pick of the graduated Qwen3.5-2B smart pick verbatim (chat #7 graduation sweep)", async () => {
    // Migration-sweep check for the smart-pick graduation: the new catalog
    // entry keeps its candidate/ id, so it must ride the prefix-agnostic
    // explicit-pick branch — never the eco-fast catch-all.
    localStorage.setItem("eco-selected-model", "candidate/qwen3.5-2b-onnx");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("candidate/qwen3.5-2b-onnx");
  });

  it.each([
    ["candidate/gemma-4-e2b-litert", "candidate%2Fgemma-4-e2b-litert"],
    ["candidate/gemma-4-e4b-litert", "candidate%2Fgemma-4-e4b-litert"],
  ] as const)("lets the validation harness override persisted selection with eval candidate %s", async (modelId, encodedModelId) => {
    window.history.replaceState(
      {},
      "",
      `/chat?eco-validation-selected-model=${encodedModelId}`,
    );
    localStorage.setItem("eco-selected-model", "candidate/qwen3.5-2b-onnx");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe(modelId);
  });

  it("routes a NON-explicit persisted candidate/ id to auto, never the eco-fast catch-all", async () => {
    localStorage.setItem("eco-selected-model", "candidate/lfm2.5-1.2b-instruct-onnx");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("keeps degraded wasm browsers on network-safe defaults without default eligibility", async () => {
    window.history.replaceState({}, "", "/?eco-force-capability=wasm");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("does not hydrate unsupported-browser defaults into local state", async () => {
    window.history.replaceState({}, "", "/?eco-force-capability=unsupported");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("does not overwrite the stored local default during temporary remote fallbacks", async () => {
    localStorage.setItem("eco-selected-model", "eco-fast");
    localStorage.setItem("eco-selected-model-explicit", "false");

    const { useChatStore, SELECTED_MODEL_STORAGE_KEY } = await import("../chatStore");

    useChatStore.getState().setSelectedModel("auto", {
      persist: false,
      explicit: false,
    });

    expect(useChatStore.getState().selectedModel).toBe("auto");
    expect(localStorage.getItem(SELECTED_MODEL_STORAGE_KEY)).toBe(
      "eco-fast",
    );
  });

  it("restores unsupported-browser non-explicit defaults to remote-safe settings", async () => {
    window.history.replaceState({}, "", "/?eco-force-capability=unsupported");
    localStorage.setItem("eco-selected-model", "eco-fast");
    localStorage.setItem("eco-selected-model-explicit", "false");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("keeps persisted auto preferences remote-safe when no local model is default-eligible", async () => {
    localStorage.setItem("eco-selected-model", "auto");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    useChatStore.getState().setSelectedModel("local/smollm3-3b", {
      persist: false,
      explicit: false,
    });

    useChatStore.getState().restorePersistedPreferences();

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("collapses persisted network model IDs to Auto when no local model is default-eligible", async () => {
    localStorage.setItem("eco-selected-model", "llama-3.1-8b");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("collapses unsupported-browser stale network preferences to preview-safe settings", async () => {
    window.history.replaceState({}, "", "/?eco-force-capability=unsupported");
    localStorage.setItem("eco-selected-model", "llama-3.1-8b");
    localStorage.setItem("eco-selected-model-explicit", "true");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().selectedModel).toBe("auto");
  });

  it("hydrates the composer draft from localStorage", async () => {
    localStorage.setItem("eco-composer-draft", "Return to this draft");

    const { useChatStore } = await import("../chatStore");

    expect(useChatStore.getState().composerDraft).toBe("Return to this draft");
  });

  it("persists and clears the composer draft locally", async () => {
    const { useChatStore, COMPOSER_DRAFT_STORAGE_KEY } = await import("../chatStore");

    useChatStore.getState().setComposerDraft("Keep this local");
    expect(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toBe("Keep this local");

    useChatStore.getState().clearComposerDraft();
    expect(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("restores the composer draft on demand from localStorage", async () => {
    localStorage.setItem("eco-composer-draft", "Recovered later");

    const { useChatStore } = await import("../chatStore");

    useChatStore.setState({ composerDraft: "" });
    useChatStore.getState().restorePersistedComposerDraft();

    expect(useChatStore.getState().composerDraft).toBe("Recovered later");
  });
});
