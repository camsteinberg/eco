// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { create } from "zustand";
import type { FileExtractionResult } from "../lib/file-extract";
import type { ToolCallDisplay } from "../lib/tool-parser";
import type { Citation } from "../lib/citation-parser";
import type { GroundingVerification } from "../lib/tools";
import { getModel } from "../local-ai/catalog/catalog";
import { isLocalAiSlot } from "../local-ai/util";
import { getSlotForModel, hasReadySlot } from "../local-ai/lifecycle/slots";
import { COMPOSER_DRAFT_STORAGE_KEY } from "../lib/chat-workspace-storage";
import { getInferenceCapabilitySync } from "../lib/inference-capability";
import { safeStorage } from "../lib/local-storage";
import { logger } from "../lib/logger";
import {
  getValidationSelectedModelOverride,
  isContextWindowNoticeForced,
} from "../lib/validation-harness";

export const SELECTED_MODEL_STORAGE_KEY = "eco-selected-model";
export const SELECTED_MODEL_EXPLICIT_STORAGE_KEY = "eco-selected-model-explicit";
export { COMPOSER_DRAFT_STORAGE_KEY };

export type MessageStatus = "sending" | "streaming" | "complete" | "error";

export type StreamPhase =
  | "idle"
  | "queued"
  | "loading"
  | "thinking"
  | "generating"
  | "tool-executing"
  // A web lookup (grounding) is running: the device is fetching from a source.
  // Distinct from "tool-executing" (the on-device calculator/date/unit tools) so
  // the UI can name the web honestly instead of the generic "Working with tools".
  | "looking-up";

export type LocalModelReadinessAction = {
  kind: "prepare-local-model";
  modelId: string;
  modelName: string;
  slotId?: "eco-fast" | "eco-smart";
  slotLabel: string;
  status: "not-downloaded" | "partial" | "downloaded-needs-test";
};

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  parentId?: string | null;
  status?: MessageStatus;
  errorMessage?: string;
  tokenCount?: number;
  streamStartTime?: number | null;
  /** True when stream dropped mid-response (partial content received). */
  streamInterrupted?: boolean;
  /**
   * Why the stream was interrupted, when known. Drives honest per-cause copy in
   * `StreamInterrupted`:
   * - `user-stop` — the user pressed Stop.
   * - `fault` — an on-device runtime fault ended the reply early.
   * - `restore-detected` — a reply left unfinalized by a crash/reload, caught by
   *   the restore sweep. Optional and backward-compatible: older interrupted
   *   messages carry no reason and get neutral phrasing.
   */
  interruptedReason?: "user-stop" | "fault" | "restore-detected";
  /** True when a local response ended near its generation limit and may need continuation. */
  possiblyTruncated?: boolean;
  localCompletionTokens?: number;
  localMaxTokens?: number;
  /** Present on assistant messages when model was "auto" -- the concrete model selected by the orchestrator. */
  resolvedModel?: string;
  /** Tracks whether this message was processed locally or via network. */
  inferenceMethod?: 'remote' | 'local';
  /** Confidence score (0-1) from local inference. Null when not applicable. */
  confidence?: number | null;
  /** True when this message was preceded by a network drop and continued locally. */
  offlineDivider?: boolean;
  /** Structured citations extracted from research mode responses. */
  citations?: Citation[];
  /** Grounding uncertainty marker, set by a grounding tool's no-source outcomes. */
  verification?: GroundingVerification;
  /**
   * True when this assistant message IS a canonical exact-answer tool result
   * (calculator/datetime/unit — `presentation:"tool-block"`): `content` holds the
   * host-computed `display` string verbatim and no model generation ran. Persisted
   * so scroll-back and reload render the exact value as PLAIN text (never through
   * Markdown, which would mangle a "17 * 23 = 391" into italics) and copy/export
   * yield the exact value. The transient `activeToolCalls` side-channel only reaches
   * the LAST assistant message, so this flag is what carries the canonical treatment
   * to earlier turns.
   */
  canonicalToolAnswer?: boolean;
  /** Action metadata for local model readiness errors. */
  localReadiness?: LocalModelReadinessAction;
  /** Generation id for the current active stream. Used by appendToMessage to reject stale tokens. */
  currentGenerationId?: string;
  /** Monotonic sequence counter for the last accepted token batch. Rejects duplicate flushes. */
  lastSeq?: number;
}

export type ChatRouteRecommendationSnapshot = {
  taskIntent: "quick" | "explain" | "deep" | "code" | "writing" | "file" | "research";
  promptPreview: string;
  hasFiles: boolean;
  researchMode: boolean;
  selectedModel: string;
  resolvedSelectedModel: string;
  v1Slot: {
    slot: import("../local-ai/types").Slot;
    model: import("../local-ai/types").ModelConfig | null;
    assignable: boolean;
  };
  preservesUserChoice: true;
};

interface NewMessage {
  role: ChatMessage["role"];
  content: string;
  parentId?: string | null;
}

export type FileAttachmentStatus = "validating" | "reading" | "extracting" | "done" | "error";

export type FileAttachment = {
  id: string;
  file: File;
  status: FileAttachmentStatus;
  errorMessage?: string;
  result?: FileExtractionResult;
};

/** Lifecycle of the one-shot "this model holds less of the chat" note. */
export type ContextWindowNoticeState = "none" | "visible" | "dismissed";

interface ChatState {
  messages: ChatMessage[];
  composerDraft: string;
  streamPhase: StreamPhase;
  /**
   * Cold-load "almost ready" signal, set when the adapter emits `load-finish`
   * (compile done, generation about to start) during a `loading` phase. Drives
   * the loading-prelude copy override. Cleared whenever `streamPhase` leaves
   * "loading" so it can never leak across sends.
   */
  loadAlmostReady: boolean;
  isStreaming: boolean;
  error: string | null;
  selectedModel: string;
  fileAttachments: FileAttachment[];
  approvedTools: string[];
  activeToolCalls: ToolCallDisplay[];
  localToolNoticeShown: boolean;
  /**
   * The quiet note shown when a newly selected model holds LESS of the
   * conversation than the previous one did. One shot per conversation:
   * 'none' → 'visible' when the window actually shrinks under a chat that
   * already overflows it, 'visible' → 'dismissed' when the person closes it,
   * and never back. Reset wherever the conversation itself changes.
   */
  contextWindowNotice: ContextWindowNoticeState;
  routeRecommendationSnapshot: ChatRouteRecommendationSnapshot | null;
}

interface ChatActions {
  addMessage: (msg: NewMessage) => string;
  appendToMessage: (
    id: string,
    token: string,
    generationId?: string,
    toSeq?: number,
    /**
     * Number of true stream tokens this emit represents. Omitting it increments
     * `tokenCount` by 1 (legacy / one-token-per-call callers). The metered
     * batcher passes an explicit per-emit delta (0 on a pure char-drain frame)
     * so `tokenCount` tracks tokens, not store-append frequency.
     */
    tokenDelta?: number,
  ) => void;
  setComposerDraft: (draft: string) => void;
  clearComposerDraft: () => void;
  setStreamPhase: (phase: StreamPhase) => void;
  setLoadAlmostReady: (value: boolean) => void;
  setError: (error: string | null) => void;
  clearMessages: (options?: { preserveComposerDraft?: boolean }) => void;
  /** Clear session-bound UI state while preserving local conversation context. */
  clearSessionState: () => void;
  /** Replace all messages (used when switching conversations). */
  setMessages: (messages: ChatMessage[]) => void;
  setSelectedModel: (
    model: string,
    options?: { persist?: boolean; explicit?: boolean },
  ) => void;
  restorePersistedPreferences: () => void;
  restorePersistedComposerDraft: () => void;
  updateMessage: (id: string, updates: Partial<Pick<ChatMessage, "content" | "status" | "errorMessage" | "streamInterrupted" | "interruptedReason" | "possiblyTruncated" | "localCompletionTokens" | "localMaxTokens" | "resolvedModel" | "inferenceMethod" | "confidence" | "offlineDivider" | "localReadiness" | "currentGenerationId" | "lastSeq" | "canonicalToolAnswer">>) => void;
  removeMessage: (id: string) => void;
  addFileAttachment: (file: File) => string;
  updateFileAttachment: (id: string, updates: Partial<FileAttachment>) => void;
  removeFileAttachment: (id: string) => void;
  clearFileAttachments: () => void;
  approveTool: (toolName: string) => void;
  addToolCall: (call: ToolCallDisplay) => void;
  updateToolCall: (id: string, updates: Partial<ToolCallDisplay>) => void;
  clearToolState: () => void;
  setLocalToolNoticeShown: () => void;
  /** Raise the shrunk-context note, unless this conversation already had it. */
  showContextWindowNotice: () => void;
  /** The person closed the note; it does not come back for this conversation. */
  dismissContextWindowNotice: () => void;
  setRouteRecommendationSnapshot: (snapshot: ChatRouteRecommendationSnapshot | null) => void;
  updateMessageCitations: (id: string, citations: Citation[]) => void;
  updateMessageVerification: (id: string, verification: GroundingVerification) => void;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function supportsLaunchLocalDefaults(): boolean {
  return supportsManualLocalSelection() && hasReadySlot();
}

function supportsManualLocalSelection(): boolean {
  return getInferenceCapabilitySync() !== "unsupported";
}

function canHydrateLocalSelection(hasExplicitChoice: boolean): boolean {
  return supportsManualLocalSelection() && (hasExplicitChoice || supportsLaunchLocalDefaults());
}

const DEFAULT_LOCAL_MODEL_SELECTION = "eco-fast";

function normalizePersistedSelectedModel(
  storedModel: string,
  hasExplicitChoice: boolean,
): string {
  const canUseLocalSelection = canHydrateLocalSelection(hasExplicitChoice);

  // An EXPLICIT pick of a known catalog model survives reload verbatim. This
  // mirrors the existing explicit-slot policy below — reverting a user's
  // chosen model to a slot/auto default on reload is the felt "it switched
  // back to Bonsai on its own" bug (audit follow-up 2026-06-10). The check is
  // prefix-agnostic on purpose: the shipping default has a `candidate/` id,
  // which previously fell through every branch into the eco-fast catch-all.
  if (hasExplicitChoice && supportsManualLocalSelection() && getModel(storedModel)) {
    return storedModel;
  }

  if (isLocalAiSlot(storedModel)) {
    return canUseLocalSelection ? storedModel : "auto";
  }

  const matchingSlot = getSlotForModel(storedModel);
  if (matchingSlot) {
    return canUseLocalSelection ? matchingSlot : "auto";
  }

  // Non-explicit known catalog model (ANY prefix — `local/` and `candidate/`
  // alike) → route via auto. Before this was `local/`-only, so a persisted
  // non-explicit `candidate/` id fell to the catch-all and landed on whatever
  // stale model the eco-fast slot still had bound.
  if (getModel(storedModel)) {
    return "auto";
  }

  if (storedModel.startsWith("local/") && !getModel(storedModel)) {
    return supportsLaunchLocalDefaults() ? DEFAULT_LOCAL_MODEL_SELECTION : "auto";
  }

  if (!supportsLaunchLocalDefaults()) {
    return "auto";
  }

  if (storedModel === "auto") {
    return DEFAULT_LOCAL_MODEL_SELECTION;
  }

  return DEFAULT_LOCAL_MODEL_SELECTION;
}

function loadPersistedSelectedModel(): string {
  if (typeof window === "undefined") {
    return "auto";
  }

  const validationOverride = getValidationSelectedModelOverride();
  if (validationOverride) {
    return validationOverride;
  }

  const storedModel = safeStorage.get(SELECTED_MODEL_STORAGE_KEY);
  const hasExplicitChoice =
    safeStorage.get(SELECTED_MODEL_EXPLICIT_STORAGE_KEY) === "true";

  if (!storedModel) {
    return supportsLaunchLocalDefaults() ? DEFAULT_LOCAL_MODEL_SELECTION : "auto";
  }

  return normalizePersistedSelectedModel(storedModel, hasExplicitChoice);
}

function persistSelectedModel(model: string, explicit: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  safeStorage.set(SELECTED_MODEL_STORAGE_KEY, model);
  safeStorage.set(SELECTED_MODEL_EXPLICIT_STORAGE_KEY, explicit ? "true" : "false");
}

function loadPersistedComposerDraft(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const storedDraft = safeStorage.get(COMPOSER_DRAFT_STORAGE_KEY);
  return storedDraft ?? "";
}

/**
 * Where the context-window note starts, on this load and after every reset.
 *
 * "none" in the product, always: `useChat` is the only thing that raises it,
 * and only for a real window shrink. The harness seam is here rather than in
 * the initial state alone because loading a conversation resets the note — a
 * seeded transcript, which is the only thing the note makes sense above, would
 * otherwise wipe it before it could be seen.
 */
function initialContextWindowNotice(): ContextWindowNoticeState {
  return isContextWindowNoticeForced() ? "visible" : "none";
}

function persistComposerDraft(draft: string): void {
  if (typeof window === "undefined") {
    return;
  }

  if (draft.length > 0) {
    safeStorage.set(COMPOSER_DRAFT_STORAGE_KEY, draft);
    return;
  }

  safeStorage.remove(COMPOSER_DRAFT_STORAGE_KEY);
}

export const useChatStore = create<ChatState & ChatActions>()((set) => ({
  messages: [],
  composerDraft: loadPersistedComposerDraft(),
  streamPhase: "idle" as StreamPhase,
  loadAlmostReady: false,
  isStreaming: false,
  error: null,
  selectedModel: loadPersistedSelectedModel(),
  fileAttachments: [],
  approvedTools: [],
  activeToolCalls: [],
  localToolNoticeShown: false,
  contextWindowNotice: initialContextWindowNotice(),
  routeRecommendationSnapshot: null,

  addMessage(msg) {
    const id = generateId();
    set((state) => {
      const messages = [
        ...state.messages,
        {
          id,
          role: msg.role,
          content: msg.content,
          createdAt: Date.now(),
          parentId: msg.parentId ?? null,
        },
      ];
      // Prune oldest messages if over threshold to prevent unbounded memory growth
      if (messages.length > 500) {
        return { messages: messages.slice(-500) };
      }
      return { messages };
    });
    return id;
  },

  appendToMessage(id, token, generationId?, toSeq?, tokenDelta = 1) {
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === id);
      if (idx === -1) return state;
      const msg = state.messages[idx]!;
      if (msg.status === "complete" || msg.status === "error" || msg.streamInterrupted) {
        return state;
      }
      // Reject tokens from a stale generation (e.g. cancelled regeneration
      // whose worker is still emitting late tokens).
      if (generationId !== undefined && msg.currentGenerationId !== undefined
          && generationId !== msg.currentGenerationId) {
        if (typeof console !== 'undefined') {
          logger.warn(
            `[eco/chat] Dropped token for stale generation ${generationId} (current: ${msg.currentGenerationId})`,
          );
        }
        return state;
      }
      // Reject duplicate token batches (same seq already applied).
      if (toSeq !== undefined && toSeq <= (msg.lastSeq ?? 0)) {
        return state;
      }
      const updated: typeof msg = {
        ...msg,
        content: msg.content + token,
        // tokenCount tracks the TRUE number of stream tokens, not store-append
        // calls. The metered char-cadence drain (token-batcher.ts) emits many
        // frames per token, so it passes the accumulated `tokenDelta` (true
        // tokens released this frame; 0 on a pure-drain frame). Default 1
        // preserves any caller that appends one token per call.
        tokenCount: (msg.tokenCount ?? 0) + tokenDelta,
        streamStartTime: msg.streamStartTime ?? Date.now(),
        ...(toSeq !== undefined ? { lastSeq: toSeq } : {}),
      };
      const messages = [...state.messages];
      messages[idx] = updated;
      return { messages };
    });
  },

  setComposerDraft(composerDraft) {
    persistComposerDraft(composerDraft);
    set({ composerDraft });
  },

  clearComposerDraft() {
    persistComposerDraft("");
    set({ composerDraft: "" });
  },

  setStreamPhase(phase) {
    // `loadAlmostReady` is a cold-load-only signal. Any transition out of the
    // loading phase (including into generation) must clear it so a stale
    // "almost ready" can never bleed into a later phase or a later send.
    set({
      streamPhase: phase,
      isStreaming: phase !== "idle",
      ...(phase !== "loading" ? { loadAlmostReady: false } : {}),
    });
  },

  setLoadAlmostReady(value) {
    set({ loadAlmostReady: value });
  },

  setError(error) {
    set({ error });
  },

  clearMessages(options) {
    const preserveComposerDraft = options?.preserveComposerDraft ?? false;
    if (!preserveComposerDraft) {
      persistComposerDraft("");
    }
    set((state) => ({
      messages: [],
      composerDraft: preserveComposerDraft ? state.composerDraft : "",
      streamPhase: "idle" as StreamPhase,
      loadAlmostReady: false,
      isStreaming: false,
      error: null,
      fileAttachments: [],
      approvedTools: [],
      activeToolCalls: [],
      localToolNoticeShown: false,
      contextWindowNotice: initialContextWindowNotice(),
      routeRecommendationSnapshot: null,
    }));
  },

  clearSessionState() {
    set({
      composerDraft: "",
      streamPhase: "idle" as StreamPhase,
      loadAlmostReady: false,
      isStreaming: false,
      error: null,
      fileAttachments: [],
      approvedTools: [],
      activeToolCalls: [],
      localToolNoticeShown: false,
      contextWindowNotice: initialContextWindowNotice(),
      routeRecommendationSnapshot: null,
    });
  },

  setMessages(messages) {
    set({ messages, streamPhase: "idle" as StreamPhase, loadAlmostReady: false, isStreaming: false, error: null, approvedTools: [], activeToolCalls: [], localToolNoticeShown: false, contextWindowNotice: initialContextWindowNotice() });
  },

  setSelectedModel(model, options) {
    const shouldPersist = options?.persist ?? true;
    const explicit = options?.explicit ?? false;
    if (shouldPersist) {
      persistSelectedModel(model, explicit);
    }
    set({ selectedModel: model });
  },

  restorePersistedPreferences() {
    set({
      selectedModel: loadPersistedSelectedModel(),
    });
  },

  restorePersistedComposerDraft() {
    set({ composerDraft: loadPersistedComposerDraft() });
  },

  updateMessage(id, updates) {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      ),
    }));
  },

  removeMessage(id) {
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
    }));
  },

  addFileAttachment(file) {
    const id = generateId();
    set((state) => ({
      fileAttachments: [
        ...state.fileAttachments,
        { id, file, status: "validating" as const },
      ],
    }));
    return id;
  },

  updateFileAttachment(id, updates) {
    set((state) => ({
      fileAttachments: state.fileAttachments.map((f) =>
        f.id === id ? { ...f, ...updates } : f
      ),
    }));
  },

  removeFileAttachment(id) {
    set((state) => ({
      fileAttachments: state.fileAttachments.filter((f) => f.id !== id),
    }));
  },

  clearFileAttachments() {
    set({ fileAttachments: [] });
  },

  approveTool(toolName) {
    set((state) => ({
      approvedTools: state.approvedTools.includes(toolName)
        ? state.approvedTools
        : [...state.approvedTools, toolName],
    }));
  },

  addToolCall(call) {
    set((state) => ({
      activeToolCalls: [...state.activeToolCalls, call],
    }));
  },

  updateToolCall(id, updates) {
    set((state) => ({
      activeToolCalls: state.activeToolCalls.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    }));
  },

  clearToolState() {
    set({ approvedTools: [], activeToolCalls: [], localToolNoticeShown: false });
  },

  setLocalToolNoticeShown() {
    set({ localToolNoticeShown: true });
  },

  showContextWindowNotice() {
    // Once per conversation: a note the person already dismissed must not
    // reappear because they switched models again.
    set((state) =>
      state.contextWindowNotice === "none"
        ? { contextWindowNotice: "visible" as ContextWindowNoticeState }
        : state,
    );
  },

  dismissContextWindowNotice() {
    set({ contextWindowNotice: "dismissed" as ContextWindowNoticeState });
  },

  setRouteRecommendationSnapshot(snapshot) {
    set({ routeRecommendationSnapshot: snapshot });
  },

  updateMessageCitations(id, citations) {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, citations } : m
      ),
    }));
  },

  updateMessageVerification(id, verification) {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, verification } : m
      ),
    }));
  },
}));
