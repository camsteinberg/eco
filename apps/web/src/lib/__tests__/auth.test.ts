// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock the Zustand stores before importing clearClientState
const {
  mockClearAll,
  mockClearMessages,
  mockClearSessionState,
  mockCloseConversationPersistenceDb,
  mockSuppressNextConversationPersistenceHydration,
  mockResetOnboarding,
  mockSignOut,
} = vi.hoisted(() => ({
  mockClearAll: vi.fn(),
  mockClearMessages: vi.fn(),
  mockClearSessionState: vi.fn(),
  mockCloseConversationPersistenceDb: vi.fn().mockResolvedValue(undefined),
  mockSuppressNextConversationPersistenceHydration: vi.fn(),
  mockResetOnboarding: vi.fn(),
  mockSignOut: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock("../../stores/conversationStore", () => ({
  useConversationStore: {
    getState: () => ({ clearAll: mockClearAll }),
  },
  closeConversationPersistenceDb: mockCloseConversationPersistenceDb,
  suppressNextConversationPersistenceHydration:
    mockSuppressNextConversationPersistenceHydration,
}));

vi.mock("../../stores/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      clearMessages: mockClearMessages,
      clearSessionState: mockClearSessionState,
    }),
  },
}));

vi.mock("../../stores/onboardingStore", () => ({
  getOnboardingStore: () => ({
    getState: () => ({
      resetOnboarding: mockResetOnboarding,
    }),
  }),
}));

vi.mock("../history/storage", () => ({
  deleteAllConversations: vi.fn(),
}));

vi.mock("../guest-local-context", () => ({
  clearGuestLocalContext: vi.fn(),
}));

vi.mock("../auth-continuation", () => ({
  clearInviteCodeCookie: vi.fn(),
}));

vi.mock("../pending-chat-prompt", () => ({
  clearPendingChatPrompt: vi.fn(),
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    useSession: () => ({ data: null }),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: mockSignOut,
  }),
}));

import {
  clearClientState,
  clearSessionClientState,
  clearUnsafeClientState,
  signOutCurrentUser,
  settleWithinBudget,
  CLIENT_CLEANUP_BUDGET_MS,
} from "../auth";
import { clearInviteCodeCookie } from "../auth-continuation";
import { clearPendingChatPrompt } from "../pending-chat-prompt";

describe("clearClientState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignOut.mockResolvedValue({ error: null });
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    // Clean up caches mock
    if ("caches" in globalThis) {
      delete (globalThis as Record<string, unknown>).caches;
    }
  });

  it("deletes eco-chat IndexedDB database", async () => {
    const spy = vi.spyOn(indexedDB, "deleteDatabase");
    await clearClientState();
    expect(spy).toHaveBeenCalledWith("eco-chat");
    spy.mockRestore();
  });

  it("deletes eco-settings IndexedDB database", async () => {
    const spy = vi.spyOn(indexedDB, "deleteDatabase");
    await clearClientState();
    expect(spy).toHaveBeenCalledWith("eco-settings");
    spy.mockRestore();
  });

  it("removes onboarding and other account-scoped eco-* localStorage keys while preserving device preferences", async () => {
    // Set up localStorage with various eco-* keys
    localStorage.setItem("eco-onboarding", '{"completed":true}');
    localStorage.setItem("eco-home-entry-dismissed", "true");
    localStorage.setItem("eco-tour-completed", "true");
    localStorage.setItem("eco-discovery-model-selector", "true");
    localStorage.setItem("eco-settings-key", "base64key");
    localStorage.setItem("eco-model-preference", "llama-3");
    localStorage.setItem("eco-local-runtime-diagnostics-v1", "[]");
    localStorage.setItem("eco-local-runtime-launch-gate-evidence-v1", "{}");
    // Device preferences that should be preserved
    localStorage.setItem("eco-theme", "dark");
    localStorage.setItem("eco-font-size", "16");
    localStorage.setItem("eco-sidebar-collapsed", "false");
    localStorage.setItem("eco-selected-model", "local/qwen3-0.6b");
    localStorage.setItem("eco-selected-model-explicit", "true");
    localStorage.setItem("eco-privacy-tier", "confidential");
    localStorage.setItem("eco-privacy-tier-explicit", "true");
    // Non-eco key that should be preserved
    localStorage.setItem("other-key", "value");

    await clearClientState();

    // Preserved: device preferences + non-eco keys
    expect(localStorage.getItem("eco-theme")).toBe("dark");
    expect(localStorage.getItem("eco-font-size")).toBe("16");
    expect(localStorage.getItem("eco-sidebar-collapsed")).toBe("false");
    expect(localStorage.getItem("eco-selected-model")).toBe("local/qwen3-0.6b");
    expect(localStorage.getItem("eco-selected-model-explicit")).toBe("true");
    expect(localStorage.getItem("eco-privacy-tier")).toBe("confidential");
    expect(localStorage.getItem("eco-privacy-tier-explicit")).toBe("true");
    expect(localStorage.getItem("other-key")).toBe("value");

    // Removed: all other eco-* keys
    expect(localStorage.getItem("eco-onboarding")).toBeNull();
    expect(localStorage.getItem("eco-home-entry-dismissed")).toBeNull();
    expect(localStorage.getItem("eco-tour-completed")).toBeNull();
    expect(localStorage.getItem("eco-discovery-model-selector")).toBeNull();
    expect(localStorage.getItem("eco-settings-key")).toBeNull();
    expect(localStorage.getItem("eco-model-preference")).toBeNull();
    expect(localStorage.getItem("eco-local-runtime-diagnostics-v1")).toBeNull();
    expect(localStorage.getItem("eco-local-runtime-launch-gate-evidence-v1")).toBeNull();
  });

  it("removes eco-* sessionStorage keys and suppresses immediate service-worker re-registration", async () => {
    sessionStorage.setItem("eco-auth-chat-context", '{"activeConversationId":"conv-1"}');
    sessionStorage.setItem("eco-pending-chat-prompt", "Keep this local");
    sessionStorage.setItem("eco-pending-message-focus", '{"conversationId":"conv-1","messageId":"msg-1"}');

    await clearClientState();

    expect(sessionStorage.getItem("eco-auth-chat-context")).toBeNull();
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBeNull();
    expect(sessionStorage.getItem("eco-pending-message-focus")).toBeNull();
    expect(mockSuppressNextConversationPersistenceHydration).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("eco-skip-sw-registration-once")).toBe("true");
  });

  it("removes eco: prefixed localStorage keys", async () => {
    localStorage.setItem("eco:private-explainer-dismissed", "true");
    localStorage.setItem("eco:some-other-flag", "yes");

    await clearClientState();

    expect(localStorage.getItem("eco:private-explainer-dismissed")).toBeNull();
    expect(localStorage.getItem("eco:some-other-flag")).toBeNull();
  });

  it("clears Eco app service worker caches when caches API is available", async () => {
    const mockDelete = vi.fn().mockResolvedValue(true);
    const mockKeys = vi.fn().mockResolvedValue([
      "eco-cache-v1",
      "eco-v5",
      "eco-app-cache-static",
      "eco-model-smollm3",
      "transformers-cache",
      "workbox-precache",
      "third-party-cache",
    ]);
    Object.defineProperty(globalThis, "caches", {
      value: { keys: mockKeys, delete: mockDelete },
      writable: true,
      configurable: true,
    });

    await clearClientState();

    expect(mockKeys).toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith("eco-cache-v1");
    expect(mockDelete).toHaveBeenCalledWith("eco-v5");
    expect(mockDelete).toHaveBeenCalledWith("eco-app-cache-static");
    expect(mockDelete).not.toHaveBeenCalledWith("eco-model-smollm3");
    expect(mockDelete).not.toHaveBeenCalledWith("transformers-cache");
    expect(mockDelete).not.toHaveBeenCalledWith("workbox-precache");
    expect(mockDelete).not.toHaveBeenCalledWith("third-party-cache");
  });

  it("calls Zustand store clearAll and clearMessages", async () => {
    await clearClientState();

    expect(mockClearAll).toHaveBeenCalled();
    expect(mockClearMessages).toHaveBeenCalled();
    expect(mockClearSessionState).toHaveBeenCalled();
    expect(mockCloseConversationPersistenceDb).toHaveBeenCalled();
    expect(mockResetOnboarding).toHaveBeenCalled();
  });

  it("clears pending invite and prompt continuation state", async () => {
    await clearClientState();

    expect(clearInviteCodeCookie).toHaveBeenCalledTimes(1);
    expect(clearPendingChatPrompt).toHaveBeenCalledTimes(1);
  });

  it("unregisters service workers before deleting caches when available", async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const postMessage = vi.fn((_message: unknown, ports?: MessagePort[]) => {
      ports?.[0]?.postMessage({ ok: true });
    });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        serviceWorker: {
          controller: {
            postMessage,
          },
          getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
        },
      },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(globalThis, "caches", {
      value: {
        keys: vi.fn().mockResolvedValue(["eco-v3"]),
        delete: vi.fn().mockResolvedValue(true),
      },
      writable: true,
      configurable: true,
    });

    await clearClientState();

    expect(postMessage).toHaveBeenCalledWith(
      { type: "eco-client-state-reset" },
      expect.any(Array)
    );
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("leaves downloaded model weights alone by default (sign-out path)", async () => {
    const mockDelete = vi.fn().mockResolvedValue(true);
    const mockKeys = vi.fn().mockResolvedValue([
      "eco-v5",
      "eco-local-ai-candidate_lfm2.5-1.2b-instruct-onnx",
      "webllm/model",
      "webllm/config",
      "webllm/wasm",
    ]);
    Object.defineProperty(globalThis, "caches", {
      value: { keys: mockKeys, delete: mockDelete },
      writable: true,
      configurable: true,
    });

    await clearClientState();

    expect(mockDelete).toHaveBeenCalledWith("eco-v5");
    expect(mockDelete).not.toHaveBeenCalledWith(
      "eco-local-ai-candidate_lfm2.5-1.2b-instruct-onnx"
    );
    expect(mockDelete).not.toHaveBeenCalledWith("webllm/model");
    expect(mockDelete).not.toHaveBeenCalledWith("webllm/config");
    expect(mockDelete).not.toHaveBeenCalledWith("webllm/wasm");
  });

  it("deletes model weight caches and the WebLLM scopes when includeModelFiles is set", async () => {
    const mockDelete = vi.fn().mockResolvedValue(true);
    const mockKeys = vi.fn().mockResolvedValue([
      "eco-v5",
      "eco-app-cache-static",
      "eco-local-ai-candidate_lfm2.5-1.2b-instruct-onnx",
      "eco-local-ai-candidate_lfm2-2.6b-onnx",
      "third-party-cache",
    ]);
    Object.defineProperty(globalThis, "caches", {
      value: { keys: mockKeys, delete: mockDelete },
      writable: true,
      configurable: true,
    });

    await clearClientState({ includeModelFiles: true });

    expect(mockDelete).toHaveBeenCalledWith(
      "eco-local-ai-candidate_lfm2.5-1.2b-instruct-onnx"
    );
    expect(mockDelete).toHaveBeenCalledWith(
      "eco-local-ai-candidate_lfm2-2.6b-onnx"
    );
    expect(mockDelete).toHaveBeenCalledWith("webllm/model");
    expect(mockDelete).toHaveBeenCalledWith("webllm/config");
    expect(mockDelete).toHaveBeenCalledWith("webllm/wasm");
    // The app's own caches are still swept.
    expect(mockDelete).toHaveBeenCalledWith("eco-v5");
    expect(mockDelete).toHaveBeenCalledWith("eco-app-cache-static");
    // Unrelated caches are still left alone.
    expect(mockDelete).not.toHaveBeenCalledWith("third-party-cache");
  });

  it("deletes the weights before the app caches so a budget expiry still starts the slow part", async () => {
    const order: string[] = [];
    const mockDelete = vi.fn(async (name: string) => {
      order.push(name);
      return true;
    });
    Object.defineProperty(globalThis, "caches", {
      value: {
        keys: vi
          .fn()
          .mockResolvedValue(["eco-v5", "eco-local-ai-candidate_lfm2-2.6b-onnx"]),
        delete: mockDelete,
      },
      writable: true,
      configurable: true,
    });

    await clearClientState({ includeModelFiles: true });

    expect(order.indexOf("eco-local-ai-candidate_lfm2-2.6b-onnx")).toBeLessThan(
      order.indexOf("eco-v5")
    );
  });

  it("does not throw when caches.delete rejects during the weights sweep", async () => {
    Object.defineProperty(globalThis, "caches", {
      value: {
        keys: vi
          .fn()
          .mockResolvedValue(["eco-v5", "eco-local-ai-candidate_lfm2-2.6b-onnx"]),
        delete: vi.fn().mockRejectedValue(new Error("QuotaExceededError")),
      },
      writable: true,
      configurable: true,
    });

    await expect(
      clearClientState({ includeModelFiles: true })
    ).resolves.toBeUndefined();
  });

  it("leaves the next boot on the ordinary first-run path: no slot binding survives, and the preserved selection is an alias rather than a model id", async () => {
    localStorage.setItem(
      "eco-local-ai-slot-fast",
      "candidate/lfm2.5-1.2b-instruct-onnx"
    );
    localStorage.setItem("eco-local-ai-slot-status-fast", "ready");
    localStorage.setItem("eco-local-ai-slot-smart", "candidate/lfm2-2.6b-onnx");
    localStorage.setItem("eco-model-slot-fast", "candidate/lfm2-2.6b-onnx");
    localStorage.setItem("eco-slot-fast", "candidate/lfm2-2.6b-onnx");
    localStorage.setItem("eco-local-ai-evidence-v1", "{}");
    // Preserved device preference: a slot ALIAS, never a model id.
    localStorage.setItem("eco-selected-model", "auto");

    Object.defineProperty(globalThis, "caches", {
      value: {
        keys: vi
          .fn()
          .mockResolvedValue(["eco-local-ai-candidate_lfm2-2.6b-onnx"]),
        delete: vi.fn().mockResolvedValue(true),
      },
      writable: true,
      configurable: true,
    });

    await clearClientState({ includeModelFiles: true });

    for (const key of [
      "eco-local-ai-slot-fast",
      "eco-local-ai-slot-status-fast",
      "eco-local-ai-slot-smart",
      "eco-model-slot-fast",
      "eco-slot-fast",
      "eco-local-ai-evidence-v1",
    ]) {
      expect(localStorage.getItem(key)).toBeNull();
    }
    // Nothing binds a slot to weights that no longer exist, so boot cannot wedge
    // on a "ready" model with no bytes.
    expect(localStorage.getItem("eco-selected-model")).toBe("auto");
  });

  it("TRUST-03: handleDeleteAccount calls DELETE /v1/auth/account before clearClientState", () => {
    // Verify by reading AccountTab source to confirm wiring
    const accountTabPath = path.resolve(
      __dirname,
      "../../components/settings/AccountTab.tsx"
    );
    const source = fs.readFileSync(accountTabPath, "utf8");

    // Verify server deletion call exists
    expect(source).toContain("/v1/auth/account");
    expect(source).toContain("method: 'DELETE'");

    // Verify clearClientState is called after the fetch (server call comes first)
    const fetchIndex = source.indexOf("/v1/auth/account");
    const clearIndex = source.indexOf("clearClientState({");
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeLessThan(clearIndex);
  });
});

describe("signOutCurrentUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignOut.mockResolvedValue({ error: null });
  });

  it("awaits Better Auth sign out without clearing local state itself", async () => {
    await signOutCurrentUser();

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockClearAll).not.toHaveBeenCalled();
    expect(mockClearMessages).not.toHaveBeenCalled();
  });

  it("throws when Better Auth returns an error", async () => {
    mockSignOut.mockResolvedValueOnce({
      error: { message: "Session could not be revoked" },
    });

    await expect(signOutCurrentUser()).rejects.toThrow("Session could not be revoked");
  });
});

describe("clearUnsafeClientState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears session-bound chat state without wiping local conversations", () => {
    clearUnsafeClientState();

    expect(mockClearSessionState).toHaveBeenCalled();
    expect(mockClearAll).not.toHaveBeenCalled();
    expect(mockClearMessages).not.toHaveBeenCalled();
  });
});

describe("settleWithinBudget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the work never settles, after the budget elapses (the sign-out hang guard)", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<void>(() => {
      /* a stalled service-worker / IndexedDB teardown that never resolves */
    });

    let settled = false;
    const guarded = settleWithinBudget(neverSettles, 4_000).then(() => {
      settled = true;
    });

    // Before the budget elapses it is still pending — we give cleanup a chance.
    await vi.advanceTimersByTimeAsync(3_999);
    expect(settled).toBe(false);

    // Once the budget elapses, it resolves regardless so the caller can navigate.
    await vi.advanceTimersByTimeAsync(1);
    await guarded;
    expect(settled).toBe(true);
  });

  it("resolves as soon as the work resolves, without waiting out the budget", async () => {
    vi.useFakeTimers();
    let settled = false;
    const guarded = settleWithinBudget(Promise.resolve(), 60_000).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    await guarded;
    expect(settled).toBe(true);
  });

  it("never rejects, even when the work rejects", async () => {
    await expect(
      settleWithinBudget(Promise.reject(new Error("teardown blew up")), 1_000),
    ).resolves.toBeUndefined();
  });

  it("exposes a sane default cleanup budget", () => {
    expect(CLIENT_CLEANUP_BUDGET_MS).toBeGreaterThan(0);
    expect(CLIENT_CLEANUP_BUDGET_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("clearSessionClientState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("keeps this device's chats and settings: never deletes IndexedDB", () => {
    const spy = vi.spyOn(indexedDB, "deleteDatabase");
    clearSessionClientState();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("drops only session-bound state", () => {
    sessionStorage.setItem("eco-draft", "x");
    sessionStorage.setItem("unrelated", "y");
    clearSessionClientState();
    expect(sessionStorage.getItem("eco-draft")).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("y");
    expect(clearInviteCodeCookie).toHaveBeenCalledTimes(1);
    expect(clearPendingChatPrompt).toHaveBeenCalledTimes(1);
  });
});
