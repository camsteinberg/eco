// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect, useMemo, useRef } from "react";
import { useChatStore } from "../stores/chatStore";
import type { ChatMessage, ChatRouteRecommendationSnapshot, FileAttachment } from "../stores/chatStore";
import { useConversationStore } from "../stores/conversationStore";
import {
  canUseExternalLookups,
  isExternalLookupExplicitlyOff,
  useSettingsStore,
} from "../stores/settingsStore";
import { toDbMessage } from "../lib/db";
import {
  assessLocalContextSafety,
  clampRequestedNewTokensForContext,
  selectMessagesForContext,
  selectContextWindow,
  findContextDividerIndex,
} from "../lib/context-window";
import { playMessageSent, playMessageReceived } from "../lib/sounds";
import { isLocalAiModel, getContextTokens, isLocalAiSlot, inferTaskIntent, resolveSelectedModelId } from "../local-ai/util";
import { resolveReadyLocalRecoveryModelId } from "../local-ai/lifecycle/recovery";
import { diagnoseUnsupportedProfile } from "../local-ai/device/diagnosis";
import { getDeviceProfile } from "../local-ai/device/profile";
import { isBelowFloor } from "../local-ai/device/below-floor";
import { getModel as getLocalAiCatalogModel } from "../local-ai/catalog/catalog";
import { recommend, NoAssignableModelError } from "../local-ai/selection/recommend";
import { getOnDeviceSystemPrompt } from "../lib/system-prompt";
import {
  applyTurnHints,
  getGenerationProfile,
  inferChatIntent,
  inferTurnIntent,
  type ChatIntent,
} from "../lib/chat-intent";
import {
  appendBranchRecaps,
  buildBranchRecaps,
  type BranchRecaps,
} from "../lib/detail-recap";
import { inferAnswerShape, type AnswerShape } from "../lib/answer-shape";
import {
  buildLocalHardConstraintRepair,
  type LocalHardConstraintRepair,
} from "../lib/local-generation-constraints";
import {
  buildIntegrityRepairPrompt,
  derivePrivacyGuard,
  findLeaks,
  redactReplyForIntegrity,
} from "../lib/conversation-integrity-guard";
import { LocalInferenceStreamError } from "../local-ai/runtime/errors";
import { buildLocalFallbackMessages, getLocalRuntimeCrashRecovery } from "../lib/chat-recovery";
import { buildLocalReadinessFailureV2, findAutoRetryTarget } from "../lib/chat-turns";
import { isValidationHarnessEnabled } from "../lib/validation-harness";
import {
  getSlot as getLocalAiSlot,
  getSlotForModel as getLocalAiSlotForModel,
  subscribe as subscribeLocalAiSlots,
} from "../local-ai/lifecycle/slots";
import { isUpgradeInFlightForSlot } from "../local-ai/lifecycle/upgrade";
import { MODEL_PREPARING_BUSY_MESSAGE, getActiveLocalHeavyWorkLease } from "../lib/local-heavy-work-owner";
import { getActiveModel } from "../local-ai/runtime/lifecycle";
import { createLocalAiLegacyInference } from "../local-ai/adapters/useChatLegacyShim";
import { getLastUsage as getLocalAiLastUsage, getLastTemplateName as getLocalAiLastTemplateName, ranToCapFromUsage } from "../local-ai/runtime/usage-store";
import {
  TEMPLATE_MISSING_USER_MESSAGE,
  LOCAL_GENERATION_FALLBACK_MESSAGE,
  LOCAL_GENERATION_REPEATED_MESSAGE,
  DEVICE_PROTECTION_MESSAGE,
  describeLocalCooldownMessage,
} from "../local-ai/adapters/error-messages";
import {
  recordLocalGenerationFailure,
  resetLocalGenerationFailureStreak,
} from "./useChat/failure-streak";
import { recordGenerationReceiptAsync } from "../local-ai/lifecycle/generation-receipt";
import type { Slot as LocalAiSlot } from "../local-ai/types";
import type { LifecycleEvent, LifecyclePhase } from "../local-ai/runtime/types";
import { logger } from "../lib/logger";
import {
  createGeneration,
  setActiveGeneration,
  clearActiveGeneration,
  isActiveGenerationAborted,
  interruptActiveGeneration,
} from "./useChat/generation";
import { runGeneration } from "./useChat/run-generation";
import { acquireGenerationLease } from "./useChat/generation-lease";
import { runToolStep } from "./useChat/tool-step";
import { deriveGroundedMatchContext } from "./useChat/grounding-context";
import { DEFAULT_TOOLS } from "../lib/tools";
import { normalizeStreamMarkdown } from "../lib/stream-markdown-normalizer";

export {
  buildLocalFallbackMessages,
  getLocalRuntimeCrashRecovery,
} from "../lib/chat-recovery";

// Re-exported for the test suites + harness that import these seams from the
// `useChat` barrel (the implementations live in sibling modules now).
export { createTokenBatcher } from "./useChat/token-batcher";
export {
  interruptActiveGeneration,
  setActiveGenerationForTesting,
  createGeneration,
  type Generation,
} from "./useChat/generation";

/**
 * Estimate the rendering overhead (hints, recaps, tool note) that the prompt
 * assembly adds on top of the raw message content. Passed to
 * `selectMessagesForContext` as `reservedOverheadTokens` so the selection
 * budget accounts for the tokens that will exist in the rendered prompt but
 * not in the raw conversation, preventing a window that passes selection from
 * failing the 0.90 safety check.
 *
 * Per-turn overhead: the longest hint (`buildTurnQualityInstruction`) is
 * ~120 chars ≈ 30 tokens. Recaps and tool notes add a fixed amount.
 * The reserve is capped at 10% of the context length to avoid over-eviction
 * in long conversations where the user-turn count is large.
 *
 * @internal Exported for unit testing.
 */
export function estimateRenderingOverhead(
  messages: ReadonlyArray<{ role: string }>,
  contextLength: number,
): number {
  const PER_TURN_HINT_TOKENS = 24;
  const FIXED_OVERHEAD_TOKENS = 128;
  const userTurnCount = messages.filter((m) => m.role === "user").length;
  return Math.min(
    userTurnCount * PER_TURN_HINT_TOKENS + FIXED_OVERHEAD_TOKENS,
    Math.floor(contextLength * 0.10),
  );
}

/**
 * Build a composed system prompt combining the Eco identity prompt and custom
 * instructions.
 *
 * v1.0 web is on-device-only, so the prompt is kept minimal: identity + custom
 * instructions only. User memories are intentionally not injected — that path
 * was network-only and small on-device models can't follow it reliably.
 */
/** @internal Exported for unit testing */
export function buildSystemPrompt(
  selectedModel: string,
  customInstructions: string,
  _localProfile?: import("../local-ai/types").DeviceProfile,
): string {
  const parts: string[] = [];
  // v1: selectedModel is either a concrete model id (local/...) or a slot name
  // (eco-fast / eco-smart). Resolve slots to their bound model id; everything
  // else passes through unchanged.
  const effectiveSelectedModel = resolveSelectedModelId(selectedModel);

  parts.push(getOnDeviceSystemPrompt(effectiveSelectedModel));

  if (customInstructions.trim()) {
    parts.push(customInstructions.trim());
  }

  return parts.join("\n\n");
}

/**
 * Normalize an assistant message's final body so the persisted text matches what
 * the renderer displays (copy / export / history stay consistent). Runs once at
 * completion, AFTER the batcher's terminal `flushSync()`, on the committed store
 * content; `complete: true` normalizes the whole text. No-op write is skipped.
 *
 * The renderer applies the SAME normalizer live during streaming, so this only
 * reconciles the stored bytes — there is no visible re-flow when the message
 * finalizes. Aborted / interrupted partial replies are intentionally left raw:
 * their text ends mid-construct and the user explicitly stopped, so we don't
 * touch the load-bearing user-stop finalize path.
 *
 * UNLIKE the display path (which normalizes think-stripped text), this
 * normalizes the FULL stored body. That is safe today only because the
 * worker-side `ThinkTagFilter` (`local-ai/runtime/output-filter.ts`) strips
 * `<think>…</think>` blocks before tokens ever reach the store. If that filter
 * is removed or think output starts being persisted, this call site must treat
 * think segments as opaque before normalizing.
 *
 * Reads the store globally but takes `updateMessage` as a parameter on purpose:
 * tests inject a counting wrapper to assert the no-op-skip (zero writes when
 * content is already clean).
 *
 * KV-CACHE TRADEOFF (deliberate, bounded): when this REWRITES the stored
 * assistant body, that turn's text no longer strictly-prefix-matches the token
 * sequence the worker cached for it, so the worker's `decideKvReuse` gate
 * (`local-ai/runtime/kv-cache.ts`) correctly declines reuse and the NEXT turn
 * pays a full prefill instead of a warm TTFT. The cost is bounded and only paid
 * on turns where artifacts were actually fixed: the no-op-skip above preserves
 * the common (already-clean) path, where reuse stays intact. We accept it
 * because a permanently-clean transcript (correct copy / export / history, and
 * a stable prompt prefix for every later turn) is worth more than one warm TTFT.
 * Verified live 2026-06-11: LFM2.5 clean-turn multi-turn TTFT ~1.5s — reuse held
 * through the normalizer's no-op path.
 *
 * @internal Exported for unit testing.
 */
export function finalizeAssistantMarkdown(
  assistantId: string,
  updateMessage: (id: string, updates: { content: string }) => void,
): void {
  const msg = useChatStore.getState().messages.find((m) => m.id === assistantId);
  if (!msg) return;
  const normalized = normalizeStreamMarkdown(msg.content, { complete: true });
  if (normalized !== msg.content) {
    updateMessage(assistantId, { content: normalized });
  }
}

/**
 * Decide the initial stream phase for a turn by model residency, BEFORE the
 * generation starts (#4 W3a).
 *
 * A sibling change warms the on-device model on chat mount, so the target model
 * is USUALLY already resident when the first message sends. When it is NOT
 * resident (cold start, a fresh model, or warmup hasn't finished), the first
 * `adapter.load` runs a multi-second WebGPU weight-load + shader compile before
 * any token — a silent window that reads as a hang. In that case we open in the
 * honest `"loading"` phase ("Warming up Eco…") instead of `"thinking"` dots.
 *
 * The phase is decided ONCE here, at send time. `runGeneration` flips it to
 * `"generating"` on the first token regardless of whether it started as
 * `"loading"` or `"thinking"`, so no mid-stream loading→thinking transition is
 * needed (keeps the hot path simple).
 *
 * `adapter.load` DOES emit byte progress, but on a cached cold load that
 * progress burns out in ~1s of a much longer WebGPU session-create — a
 * determinate bar would sit pinned at 100% for most of the wait, which is
 * dishonest. So the loading affordance is time-based copy escalation (a
 * breathing botanical cursor whose label steps up as the wait grows) plus one
 * honest lifecycle signal: `load-finish` (compile done, generation starting)
 * flips an "almost ready" hint. No percentage bar.
 *
 * @internal Exported for unit testing.
 */
export function resolveInitialStreamPhase(
  selectedModelChoice: string,
): "loading" | "thinking" {
  // Resolve the selection to the concrete model id streamResponse will load:
  // slot → bound model id; concrete id → as-is. Mirrors resolveDispatch.
  const targetModelId = resolveSelectedModelId(selectedModelChoice);

  // Resident already (warmed on mount, or a prior turn left it loaded) → today's
  // "thinking" behavior. Otherwise the cold-load window owns the wait → honest
  // "loading". A null active model or an id mismatch both fall through to
  // "loading", which is the safe, truthful default.
  return getActiveModel()?.id === targetModelId ? "thinking" : "loading";
}

// Active-generation tracking + the user-stop path live in ./useChat/generation.
// `interruptActiveGeneration` is re-exported from the barrel above.

function hasReadyFileAttachment(fileAttachments: FileAttachment[]): boolean {
  return fileAttachments.some((attachment) => attachment.status === "done");
}

function hasFileSignal(content: string, fileAttachments: FileAttachment[]): boolean {
  return /<file\b/i.test(content) || hasReadyFileAttachment(fileAttachments);
}

/** @internal Exported for route snapshot tests. */
export function buildChatRouteRecommendationSnapshot(input: {
  prompt: string;
  selectedModel: string;
  researchMode: boolean;
  fileAttachments?: FileAttachment[];
}): ChatRouteRecommendationSnapshot {
  const fileAttachments = input.fileAttachments ?? [];
  const hasFiles = hasFileSignal(input.prompt, fileAttachments);
  // v1: resolve slot name to concrete model id via the slot store. Non-slot
  // ids pass through unchanged (catalog/legacy/network — useChat decides).
  const resolvedSelectedModel = resolveSelectedModelId(input.selectedModel);
  const taskIntent = inferTaskIntent({
    prompt: input.prompt,
    hasFiles,
    researchMode: input.researchMode,
  });
  // v1 slot snapshot: the primary slot for the selected model.
  const slotId = isLocalAiSlot(input.selectedModel)
    ? input.selectedModel
    : "eco-fast" as import("../local-ai/types").Slot;
  const slotState = getLocalAiSlot(slotId);

  return {
    taskIntent,
    promptPreview: input.prompt.trim().slice(0, 180),
    hasFiles,
    researchMode: input.researchMode,
    selectedModel: input.selectedModel,
    resolvedSelectedModel,
    v1Slot: {
      slot: slotId,
      model: slotState.model
        ? (getLocalAiCatalogModel(slotState.model.id) ?? null)
        : null,
      assignable: slotState.status === "ready",
    },
    preservesUserChoice: true,
  };
}

/**
 * Normalize a model *choice* so an UNBOUND concrete on-device id can never
 * reach generation.
 *
 * A concrete catalog id that no slot owns describes bytes nothing has
 * downloaded or verified. Dispatching it makes the runtime self-fetch gigabytes
 * mid-turn — silently, with no progress and no consent — while Settings keeps
 * reporting the first bound slot, so the two surfaces disagree about what is
 * running. Such a choice is therefore rewritten to `"auto"`, the same "let Eco
 * choose" state a fresh device carries, and the caller persists that so chat,
 * readiness, and Settings agree from then on.
 *
 * Deliberately narrow:
 *   - slot names and `"auto"` pass through — they already resolve through slots;
 *   - a slot-BOUND concrete id passes through — its bytes are accounted for, and
 *     it keeps resolving to its owning slot exactly as before;
 *   - a non-on-device id (a stale cloud selection) passes through so the
 *     dispatch guard can still give it the explicit "runs in the cloud" decline
 *     rather than quietly swallowing it.
 *
 * @internal Exported for unit testing.
 */
export function normalizeUnboundModelSelection(choice: string): string {
  if (choice === "auto" || isLocalAiSlot(choice)) return choice;
  if (!isLocalAiModel(choice)) return choice;
  const boundToASlot =
    getLocalAiSlot("eco-fast").model?.id === choice ||
    getLocalAiSlot("eco-smart").model?.id === choice;
  return boundToASlot ? choice : "auto";
}

/**
 * Local error codes that already resolve to a specific, honest chat message
 * (crash recovery, cooldown, low battery, OOM, missing template). Any other
 * failure — a generic inference error, a timeout, a "no model loaded" while a
 * swap is mid-flight — would otherwise fall through to the generic error card.
 * During an in-flight upgrade that generic card is wrong: the model is simply
 * still preparing. This predicate lets the not-ready guard skip the codes that
 * have their own honest handling.
 */
const DEDICATED_LOCAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "DEVICE_LOST",
  "WORKER_CRASHED",
  "LOCAL_MODEL_COOLDOWN",
  "DEVICE_PROTECTION",
  "OOM",
  "TEMPLATE_MISSING",
]);

function errorHasDedicatedLocalMessage(err: unknown): boolean {
  return err instanceof LocalInferenceStreamError && DEDICATED_LOCAL_ERROR_CODES.has(err.code);
}

/**
 * True when the model this generation ran on is the one a pull is still
 * preparing — the only case where "still preparing, please wait" is the honest
 * reading of a failure.
 *
 * A pull now runs in the BACKGROUND, on whichever slot the tapped tile owns,
 * while the conversation keeps streaming on the other one. Asking "is any
 * upgrade in flight?" would relabel a genuine fault of the serving model as a
 * wait, on every send, for as long as the download lasts. So the question is
 * asked about this generation's own slot: the slot the failing model is bound
 * to (a swap binds its slot up front, so a mid-swap model resolves to it), or
 * the slot name itself when the selection never resolved to a model.
 */
function upgradeIsPreparingThisModel(modelKey: string): boolean {
  const slot: LocalAiSlot | null = isLocalAiSlot(modelKey)
    ? modelKey
    : getLocalAiSlotForModel(modelKey);
  return slot !== null && isUpgradeInFlightForSlot(slot);
}

/**
 * Per-generation overrides a caller may hand to a single regenerate. Both are
 * REQUEST-LOCAL: nothing here is written to the conversation, so the stored
 * user turn and the history every later turn re-renders stay exactly as the
 * user typed them.
 */
export type RegenerateOverrides = {
  /**
   * Intent to resolve generation options with, in place of the one classified
   * from the turn text. Substituted at the OPTIONS-RESOLUTION layer only — the
   * classifiers (`inferChatIntent` / `inferAnswerShape`) keep their strict-prefix
   * purity contract: pure functions of (turn text, hasPriorTurns), never handed
   * a caller's preference.
   */
  intent?: ChatIntent;
  /**
   * Model-facing directive appended to the END of the final user turn for THIS
   * generation. See `appendTurnDirective` for why the END placement is the
   * design and not an implementation detail.
   */
  turnDirective?: string;
};

/** Everything `streamResponse` accepts for one dispatch. */
export type StreamResponseOverrides = RegenerateOverrides & {
  model?: string;
  systemPrompt?: string;
};

/**
 * Append a model-facing directive to the END of the final user turn.
 *
 * Returns a NEW array carrying the directive on a COPY of the last user
 * message — the input list is never mutated, which is what keeps the directive
 * out of the stored conversation.
 *
 * The END placement, and composing this BEFORE any intent/hint work, is the
 * whole design: `buildHintedUserTurn` decides hint suppression from the turn's
 * own bytes via `hasExplicitFormatInstruction`, so a directive phrased as an
 * explicit format instruction suppresses the per-intent hint through the
 * EXISTING mechanism — no directive-aware special case anywhere. A directive
 * that does NOT read as one still gets the hint appended after it, exactly as
 * a user's own phrasing would; that asymmetry is deliberate and load-bearing,
 * so directive strings are chosen against the detector, not against this code.
 * The blank-line join is the same separator `buildHintedUserTurn` uses.
 *
 * No-op for an absent/blank directive, or a list with no user turn.
 */
function appendTurnDirective(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  directive: string | undefined,
): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  const trimmed = directive?.trim() ?? "";
  if (trimmed.length === 0) return messages;
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  const target = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  if (!target) return messages;
  const next = [...messages];
  next[lastUserIndex] = { ...target, content: `${target.content}\n\n${trimmed}` };
  return next;
}

export function useChat() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamPhase = useChatStore((s) => s.streamPhase);
  const error = useChatStore((s) => s.error);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const composerDraft = useChatStore((s) => s.composerDraft);
  const fileAttachments = useChatStore((s) => s.fileAttachments);
  const activeToolCalls = useChatStore((s) => s.activeToolCalls);
  const { addMessage, appendToMessage, setStreamPhase, setLoadAlmostReady, setError, clearMessages, updateMessage, removeMessage, updateMessageCitations, updateMessageVerification } =
    useChatStore.getState();
  // Host-driven tool actions (#4 Phase 4a). The tool step writes the transient
  // ToolCallBlock side-channel through these; read from getState() at call time
  // so they always point at the live store.
  const { addToolCall, updateToolCall, clearToolState } = useChatStore.getState();

  // Read custom instructions for system prompt composition.
  const customInstructions = useSettingsStore((s) => s.customInstructions);

  // v1: resolve slot name to concrete model id via the slot store.
  const resolvedSelectedModel = resolveSelectedModelId(selectedModel);
  const allowValidationModelMetadata = isValidationHarnessEnabled();
  // Single base-system-prompt derivation. Both consumers — context-window
  // sizing (this memo + contextDividerIndex) and the per-turn dispatch prompt
  // (`buildQualitySystemPrompt`) — flow through `buildSystemPrompt`. There is
  // no second prompt path: `buildSystemPrompt` resolves slot names internally,
  // so passing a slot name or its bound model id yields the same base prompt.
  const composedSystemPrompt = useMemo(
    () => buildSystemPrompt(selectedModel, customInstructions),
    [selectedModel, customInstructions],
  );
  // Shipping context length resolves from the catalog only. Diagnostics may opt
  // into eval-candidate metadata so validation-selected product transcripts use
  // the same context window the eval harness reports.
  const effectiveModelContextLength = getContextTokens(resolvedSelectedModel, undefined, {
    allowValidationModel: allowValidationModelMetadata,
  });
  // The context length the last render resolved to, and whether the change
  // that produced the current one was Eco normalizing its own selection rather
  // than a real model change. Both feed the shrunk-window note at the bottom
  // of this hook.
  const priorContextLengthRef = useRef<number | null>(null);
  const silentModelSwitchRef = useRef(false);

  useEffect(() => {
    const hasDraft = composerDraft.trim().length > 0;
    const hasFiles = fileAttachments.length > 0;
    if (!hasDraft && !hasFiles) {
      useChatStore.getState().setRouteRecommendationSnapshot(null);
      return;
    }

    useChatStore.getState().setRouteRecommendationSnapshot(
      buildChatRouteRecommendationSnapshot({
        prompt: composerDraft,
        selectedModel,
        researchMode: false,
        fileAttachments,
      }),
    );
  }, [composerDraft, fileAttachments, selectedModel]);

  // Base system prompt for the current turn, read from live store/settings
  // state (not the reactive snapshot) so a model override or a mid-session
  // custom-instructions change is honored. Same single path as the sizing memo.
  function composeBaseSystemPrompt(modelOverride?: string): string {
    const rawModel = modelOverride ?? useChatStore.getState().selectedModel;
    return buildSystemPrompt(
      rawModel,
      useSettingsStore.getState().customInstructions,
    );
  }

  // v1.0 local-AI: per-instance shim that bridges the new runtime/lifecycle
  // generate() into the legacy ReadableStream<string> contract this hook
  // was written against. All local generation routes through this shim.
  const v1LocalShim = useMemo(() => createLocalAiLegacyInference(), []);

  // Stable store-access hooks injected into every runGeneration call (primary,
  // repair, and the offline continue path). Defined once so the three call
  // sites share one definition and can't drift.
  const streamIO = {
    setStreamPhase,
    getStreamPhase: () => useChatStore.getState().streamPhase,
    getMessageContent: (id: string) =>
      useChatStore.getState().messages.find((m) => m.id === id)?.content ?? "",
  };

  function getLatestTurnIntent(
    apiMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  ) {
    // Same per-turn inference rule `applyTurnHints` uses for history
    // re-renders (KV contract: the latest turn must classify identically when
    // it later re-renders as history). hasPriorTurns = any message precedes
    // the latest user turn in the list.
    let lastUserIndex = -1;
    for (let i = apiMessages.length - 1; i >= 0; i--) {
      if (apiMessages[i]!.role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    const latestUserMessage = lastUserIndex >= 0 ? apiMessages[lastUserIndex]!.content : "";
    return inferTurnIntent(latestUserMessage, lastUserIndex > 0);
  }

  function buildLocalGenerationOptions(
    intent: ReturnType<typeof inferChatIntent>,
    modelId: string,
    continueFinalMessage = false,
  ) {
    const profile = getGenerationProfile(intent, true, modelId, {
      allowValidationModel: allowValidationModelMetadata,
    });
    return {
      max_new_tokens: profile.maxTokens,
      temperature: profile.temperature,
      ...(profile.topP != null && { top_p: profile.topP }),
      ...(profile.topK != null && { top_k: profile.topK }),
      ...(profile.repetitionPenalty != null && {
        repetition_penalty: profile.repetitionPenalty,
      }),
      ...(profile.noRepeatNgramSize != null && {
        no_repeat_ngram_size: profile.noRepeatNgramSize,
      }),
      ...(continueFinalMessage ? { continueFinalMessage: true } : {}),
    };
  }

  function stopForUnsafeLocalContext(
    assistantId: string,
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    systemPrompt: string,
    modelId: string,
    requestedNewTokens: number,
  ): { stopped: boolean; grantedNewTokens: number } {
    const contextLength = getContextTokens(modelId, undefined, {
      allowValidationModel: allowValidationModelMetadata,
    });
    // Degrade before refusing: clamp the new-token request to the context
    // headroom (floor MIN_LOCAL_NEW_TOKENS) so long conversations get a
    // shorter reply instead of an error. The safety check below still refuses
    // when even the floored grant doesn't fit.
    const grantedNewTokens = clampRequestedNewTokensForContext(
      messages,
      systemPrompt,
      contextLength,
      requestedNewTokens,
    );
    const decision = assessLocalContextSafety(
      messages,
      systemPrompt,
      contextLength,
      grantedNewTokens,
    );

    if (decision.ok) {
      return { stopped: false, grantedNewTokens };
    }

    updateMessage(assistantId, {
      status: "error",
      errorMessage: decision.reason,
      inferenceMethod: "local",
    });
    setError(decision.reason);
    return { stopped: true, grantedNewTokens };
  }

  // Wave 2.6 Stage 1: per-intent hints moved OUT of the system message onto
  // the end of each user turn (`applyTurnHints` — shared with the eval
  // harness). Measured: the system-front hint recovered only 9% (LFM) / 29%
  // (Qwen) of the explicit-phrasing premium vs 35% / 68% at the user turn,
  // AND a hint-free front keeps strict-prefix KV reuse across intent changes
  // (#151 front-of-prompt variance). The system message is the base prompt
  // only (plus any per-turn tool note appended downstream).
  function buildQualitySystemPrompt(
    model: string,
    baseSystemPrompt?: string,
  ): string {
    return baseSystemPrompt ?? composeBaseSystemPrompt(model);
  }

  function applyLocalGenerationError(
    err: unknown,
    assistantId: string,
    modelKey: string,
  ) {
    const currentAssistant = useChatStore
      .getState()
      .messages.find((message) => message.id === assistantId);

    if (currentAssistant?.status === "complete" && currentAssistant.streamInterrupted) {
      return;
    }

    // Not-ready-yet: a pull is still preparing THIS model. A failure in that
    // window (the runtime was mid-swap, or the model wasn't loaded yet) is
    // "please wait," not a fault — route it to the SAME honest "preparing"
    // guard the lease-busy path shows, never the generic "Something went
    // sideways" card. Genuine device faults (crash, cooldown, low battery, OOM,
    // missing template) keep their specific guidance below, and a pull for the
    // OTHER slot leaves this path alone entirely.
    if (upgradeIsPreparingThisModel(modelKey) && !errorHasDedicatedLocalMessage(err)) {
      updateMessage(assistantId, {
        status: "error",
        errorMessage: MODEL_PREPARING_BUSY_MESSAGE,
        inferenceMethod: "local",
      });
      setError(MODEL_PREPARING_BUSY_MESSAGE);
      return;
    }

    if (err instanceof LocalInferenceStreamError) {
      const hasPartialContent = Boolean(currentAssistant?.content.length);

      if (err.code === "DEVICE_LOST" || err.code === "WORKER_CRASHED") {
        const recovery = getLocalRuntimeCrashRecovery(hasPartialContent);
        setError(recovery.globalError);
        updateMessage(assistantId, recovery.assistantUpdate);
        return;
      }

      if (err.code === "LOCAL_MODEL_COOLDOWN") {
        // Warm the raw "<Model> is cooling down after a recent crash (Ns left)."
        // into calm copy that keeps the honest countdown (see
        // describeLocalCooldownMessage) instead of surfacing the model name and
        // the word "crash" verbatim.
        const message = describeLocalCooldownMessage(err.message);
        updateMessage(assistantId, {
          status: "error",
          errorMessage: message,
          inferenceMethod: "local",
        });
        setError(message);
        return;
      }

      if (err.code === "DEVICE_PROTECTION") {
        const message = DEVICE_PROTECTION_MESSAGE;
        updateMessage(assistantId, {
          status: "error",
          errorMessage: message,
          inferenceMethod: "local",
        });
        setError(message);
        return;
      }

      if (err.code === "OOM") {
        const message =
          "This device needs a lighter local load. Eco paused this model for a few minutes to protect this browser. Try a faster model or shorten the prompt, then try again.";
        updateMessage(assistantId, {
          status: "error",
          errorMessage: message,
          inferenceMethod: "local",
        });
        setError(message);
        return;
      }

      if (err.code === "TEMPLATE_MISSING") {
        const message = TEMPLATE_MISSING_USER_MESSAGE;
        updateMessage(assistantId, {
          status: "error",
          errorMessage: message,
          inferenceMethod: "local",
        });
        setError(message);
        return;
      }

      // Unknown runtime error code: the raw `err.message` is opaque device/
      // library detail ("boom", "No model loaded", …). Show a warm, honest
      // fallback and keep the technical detail in diagnostics only.
      logger.warn("[eco/local-inference] unhandled stream error", err);
      const message = escalateGenericFailure(modelKey);
      updateMessage(assistantId, {
        status: "error",
        errorMessage: message,
        inferenceMethod: "local",
      });
      setError(message);
      return;
    }

    // Non-LocalInferenceStreamError failure — same treatment: warm fallback for
    // the user, raw detail to diagnostics.
    logger.warn("[eco/local-inference] untyped generation error", err);
    const message = escalateGenericFailure(modelKey);
    updateMessage(assistantId, {
      status: "error",
      errorMessage: message,
      inferenceMethod: "local",
    });
    setError(message);
  }

  // A generic on-device failure that matched no dedicated branch. Track it as a
  // per-model streak: the first shows the retry-friendly fallback, the second
  // (and beyond) shows the escalated "we reset the model, try a lighter one"
  // copy the lighter-model nudge keys on. Dedicated branches (cooldown, OOM,
  // device-protection, template, preparing) never call this — they neither
  // increment nor reset the streak.
  function escalateGenericFailure(modelKey: string): string {
    const count = recordLocalGenerationFailure(modelKey);
    return count >= 2
      ? LOCAL_GENERATION_REPEATED_MESSAGE
      : LOCAL_GENERATION_FALLBACK_MESSAGE;
  }

  // ── Dispatch resolution ────────────────────────────────────────────────
  // Resolve the selected model/slot choice into a runnable local model id, or
  // write the appropriate error onto the assistant message and return a
  // not-ok result. Mirrors the guards `streamResponse` carried inline:
  //   (a) a slot whose model isn't ready → unsupported (eco-network) OR
  //       prepare-local-model, depending on whether a model is assignable;
  //   (b) a non-local (stale cloud / "auto") selection → cloud-not-supported;
  //   (c) a belt-and-suspenders slot re-check just before dispatch.
  type DispatchResolution = { ok: true; model: string } | { ok: false };

  function writeDispatchError(
    assistantId: string,
    message: string,
    extra?: Partial<Pick<ChatMessage, "localReadiness">>,
  ): void {
    updateMessage(assistantId, {
      status: "error",
      errorMessage: message,
      inferenceMethod: "local",
      ...extra,
    });
    setError(message);
  }

  function resolveDispatch(
    assistantId: string,
    rawSelectedModelChoice: string,
  ): DispatchResolution {
    // A concrete on-device id that NO slot owns is never dispatchable — see
    // `normalizeUnboundModelSelection`. Rewriting it to "auto" HERE, at the one
    // seam every send / edit / regenerate funnels through, catches the id that
    // went unbound while the tab was open as well as the one that was persisted
    // that way. The rewrite is persisted (and drops the explicit flag) so the
    // readiness hook and Settings re-derive from the same choice. Quiet on
    // purpose: an error card would ask the user to fix a state they never chose.
    const selectedModelChoice = normalizeUnboundModelSelection(rawSelectedModelChoice);
    if (selectedModelChoice !== rawSelectedModelChoice) {
      // Eco repairing its own state, not a model the person chose — the
      // shrunk-window note must not speak for it.
      silentModelSwitchRef.current = true;
      useChatStore.getState().setSelectedModel(selectedModelChoice, { explicit: false });
    }

    // (a) Slot selected but not dispatchable.
    if (isLocalAiSlot(selectedModelChoice)) {
      const slotState = getLocalAiSlot(selectedModelChoice);
      const profile = getDeviceProfile();
      if (!slotState.model || slotState.status !== "ready") {
        // Below floor / no assignable model → unsupported. Otherwise the model
        // is assignable but needs download/setup → prepare-local-model.
        let isUnsupported = isBelowFloor(profile);
        if (!isUnsupported) {
          try {
            recommend(selectedModelChoice, profile);
          } catch (err) {
            if (err instanceof NoAssignableModelError) {
              isUnsupported = true;
            } else {
              throw err;
            }
          }
        }
        if (isUnsupported) {
          const diagnosis = diagnoseUnsupportedProfile(profile);
          writeDispatchError(
            assistantId,
            `browser-local-ai-not-supported: ${diagnosis.guidance}`,
          );
          return { ok: false };
        }
        const slotLabel = 'Eco';
        writeDispatchError(
          assistantId,
          `${slotLabel} needs setup before it can run on this device. Go to Settings → Eco to set it up.`,
          {
            localReadiness: {
              kind: "prepare-local-model",
              modelId: slotState.model?.id ?? selectedModelChoice,
              modelName: slotState.model?.friendlyName ?? slotLabel,
              slotId: selectedModelChoice,
              slotLabel,
              status: "not-downloaded",
            },
          },
        );
        return { ok: false };
      }
    }

    // Resolve to a concrete model id (slot → bound model; concrete → as-is).
    const model = resolveSelectedModelId(selectedModelChoice);

    // 'auto' is the store's pre-setup default ("let Eco choose") — it lingers
    // for the whole session when the chat shell booted before first-run setup
    // finished (fresh profile: no slot was ready at store init). With a ready
    // on-device slot, Eco's choice IS that slot's model. Without one, fall
    // through to the decline below.
    if (model === "auto") {
      // eco-smart first: post-upgrade (slice 2b) the class-best model lives
      // there while the starter keeps eco-fast — "let Eco choose" means the
      // best ready model. Pre-upgrade profiles only ever have eco-fast bound,
      // so the order flip is a no-op for them.
      for (const autoSlotId of ["eco-smart", "eco-fast"] as const) {
        const autoSlot = getLocalAiSlot(autoSlotId);
        if (autoSlot.status === "ready" && autoSlot.model) {
          return { ok: true, model: autoSlot.model.id };
        }
      }
    }

    // (b) Non-local selection has no runtime to dispatch to in on-device v1.0.
    if (!isLocalAiModel(model)) {
      writeDispatchError(
        assistantId,
        "This model runs in the cloud, which Eco no longer supports. Choose an on-device model in Settings → Eco to keep chatting.",
      );
      return { ok: false };
    }

    // (c) Belt-and-suspenders: resolve which slot owns this model and verify it
    // is ready immediately before dispatch. The trailing "eco-fast" default is
    // now unreachable for on-device ids — normalization above guarantees any
    // concrete id still here is slot-bound — and must NOT be relied on: it used
    // to pass an unowned model through on a ready fast slot's readiness verdict.
    const slotId: LocalAiSlot = isLocalAiSlot(selectedModelChoice)
      ? selectedModelChoice
      : (getLocalAiSlot("eco-fast").model?.id === model
          ? "eco-fast"
          : getLocalAiSlot("eco-smart").model?.id === model
            ? "eco-smart"
            : "eco-fast");
    const slotState = getLocalAiSlot(slotId);
    if (slotState.status !== "ready" || !slotState.model) {
      const readinessFailure = buildLocalReadinessFailureV2({ slot: slotState });
      writeDispatchError(assistantId, readinessFailure.message, {
        localReadiness: {
          kind: "prepare-local-model",
          modelId: slotState.model?.id ?? model,
          modelName: readinessFailure.modelName,
          slotId: readinessFailure.slotId,
          slotLabel: readinessFailure.slotLabel,
          status: readinessFailure.readinessStatus,
        },
      });
      return { ok: false };
    }

    return { ok: true, model };
  }

  // ── Prompt + generation-options assembly ───────────────────────────────
  type LocalDispatchPlan = {
    turnIntent: ReturnType<typeof inferChatIntent>;
    /** Shape of the latest turn (receipt observability; ⊥ task class). */
    turnShape: AnswerShape;
    systemPrompt: string;
    /**
     * apiMessages as the model will actually see them: per-turn hints applied to
     * every user turn, then each user turn's recaps appended after that.
     * Every rebuild path reads THIS, never raw apiMessages, so a re-render can
     * never drift from what was sent.
     */
    hintedMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    messagesWithSystem: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    localGenerationOptions: ReturnType<typeof buildLocalGenerationOptions>;
  };

  function buildPrompt(
    model: string,
    apiMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    /**
     * Each user turn's figure and detail recaps, by user-turn ordinal, derived
     * by the caller from the FULL branch. Required rather than optional on
     * purpose: an optional one silently no-ops, which is exactly how derived
     * context has gone unwired here before.
     */
    branchRecaps: BranchRecaps,
    overrides?: StreamResponseOverrides,
  ): LocalDispatchPlan {
    // Compose the directive onto the final user turn FIRST, so everything below
    // — classification, the shape receipt, and above all `applyTurnHints` —
    // sees the turn exactly as the model will. That ordering is what lets the
    // existing explicit-format-instruction suppression apply to the directive.
    const composedMessages = appendTurnDirective(apiMessages, overrides?.turnDirective);
    // A forced intent substitutes for the classified one HERE, at the options
    // layer — the classifiers themselves are never told about it. Receipts
    // report this same value, so diagnostics describe the sampling actually run.
    const turnIntent = overrides?.intent ?? getLatestTurnIntent(composedMessages);
    // Receipt observability only — derived with the SAME position rule the
    // hint path uses (hasPriorTurns = anything precedes the last user turn).
    let lastUserIndex = -1;
    for (let i = composedMessages.length - 1; i >= 0; i--) {
      if (composedMessages[i]!.role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    const turnShape = inferAnswerShape(
      (lastUserIndex >= 0 ? composedMessages[lastUserIndex]!.content : "").trim(),
      { hasPriorTurns: lastUserIndex > 0 },
    );
    const systemPrompt = buildQualitySystemPrompt(model, overrides?.systemPrompt);
    // Hints ride the user turns (every turn, deterministically re-derived —
    // see the KV contract at lib/chat-intent.applyTurnHints).
    const hintedMessages = applyTurnHints(composedMessages, isLocalAiModel(model), model);
    // Recaps go on LAST, after every decision the turn's own text makes.
    // Measured: classifying recapped text flips this corpus's budget turn from
    // `explain` to `deep`, which would resolve different sampling options —
    // so nothing above this line may ever see a recap.
    const recappedMessages = appendBranchRecaps(hintedMessages, branchRecaps);
    return {
      turnIntent,
      turnShape,
      systemPrompt,
      hintedMessages: recappedMessages,
      messagesWithSystem: [{ role: 'system' as const, content: systemPrompt }, ...recappedMessages],
      localGenerationOptions: buildLocalGenerationOptions(turnIntent, model),
    };
  }

  // Receipt type aliases used by the per-generation receipt helpers below.
  type GenerationReceipt = import("../local-ai/lifecycle/generation-receipt").GenerationReceipt;
  type GenerationRole = import("../local-ai/lifecycle/generation-receipt").GenerationRole;

  /**
   * Stream an on-device model response into the given assistant message.
   * Shared between sendMessage, editMessage, and regenerateMessage.
   *
   * Pipeline: resolveDispatch → buildPrompt → runGeneration (+repair) →
   * recordReceipt. Each step is a focused unit; `runGeneration` is the single
   * read→batch→flush primitive shared with the offline continue path.
   */
  async function streamResponse(
    assistantId: string,
    apiMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    /**
     * Recaps for the FULL branch, by user-turn ordinal — `apiMessages` is
     * already windowed, and deriving recaps from a window would let an eviction
     * rewrite an earlier turn's recap and break the KV prefix.
     */
    branchRecaps: BranchRecaps,
    /**
     * `model` / `systemPrompt` are still unused by all callers. If a caller ever
     * sets `model`, `resolveInitialStreamPhase` at the call site must be passed
     * the same resolved choice, or the loading indicator will desync from the
     * actual dispatch target. `intent` / `turnDirective` are the per-generation
     * recovery seam — see `RegenerateOverrides`; also unused by all callers today.
     */
    overrides?: StreamResponseOverrides,
  ) {
    const selectedModelChoice = overrides?.model ?? useChatStore.getState().selectedModel;

    // ── Resolve dispatch ───────────────────────────────────────────────────
    const dispatch = resolveDispatch(assistantId, selectedModelChoice);
    if (!dispatch.ok) return;
    const { model } = dispatch;

    // ── Build prompt + generation options ──────────────────────────────────
    const plan = buildPrompt(model, apiMessages, branchRecaps, overrides);
    const { turnIntent, localGenerationOptions } = plan;

    // ── Create the per-generation object (BEFORE the tool step) ─────────────
    // Owns its own AbortController + batcher (id + seq) + reader slot. The
    // module-level active pointer lets stopGeneration reach this generation.
    //
    // Created HERE — above the tool step — so a network-backed tool (grounding,
    // #5 S3) can be tied to this generation's AbortController: pressing Stop during
    // the lookup aborts the fetch via the same path as a mid-stream stop. Nothing
    // between buildPrompt and here depends on the tool step.
    const generation = createGeneration(appendToMessage);
    setActiveGeneration(generation);
    updateMessage(assistantId, { currentGenerationId: generation.id });

    // ── Host-driven tool step (#4 Phase 4a, #5 S3) ─────────────────────────
    // Run the tool registry over the latest user turn BEFORE the single
    // generation. On a confident match the tool executes and returns a `forModel`
    // note we inject into THIS generation's system prompt so the model phrases the
    // answer naturally. Deterministic tools (calculator/datetime/unit) also render
    // an authoritative ToolCallBlock; the grounding tool instead returns a
    // `citation` (presentation:"citation") for the citation chip. On no match this
    // clears any prior turn's tool call and returns null (the common path).
    // Read from the RAW turn, never the directive-composed one: tool detection
    // is scoped to the user's actual ask, and a host-authored directive must
    // not be able to change what gets looked up.
    const latestUserText = [...apiMessages]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
    // Gate browser-direct lookups on hydrated settings (#5 S5). Default-ON after
    // settings load, but unknown/unhydrated settings fail closed: a persisted web
    // lookup opt-out must not be bypassed during reload or pending-prompt races.
    // When off/unhydrated we drop citation tools entirely, so factual turns never
    // detect/execute browser-direct lookups (no network, no chip) and fall through
    // to normal on-device chat. Deterministic tools remain unaffected.
    const settingsSnapshot = useSettingsStore.getState();
    const externalLookupsAllowed = canUseExternalLookups(settingsSnapshot);
    const effectiveTools = externalLookupsAllowed
      ? DEFAULT_TOOLS
      : DEFAULT_TOOLS.filter((tool) => tool.presentation !== "citation");
    // When the user has EXPLICITLY turned web lookups off, hand the removed citation
    // tools back as `declineTools` so a turn that WOULD have hit a browser-direct
    // lookup gets an honest "I can't look that up" note instead of the model
    // fabricating a falsely-sourced answer (F-1). Detection-only — they never execute
    // or touch the network. Gated on EXPLICIT opt-out, NOT the unhydrated race: on
    // `!hasLoaded` we still fail closed on the network, but we must not tell the user
    // "lookups are off" when we simply haven't loaded their choice yet (they may have
    // them on). Lookups on / unhydrated ⇒ undefined (no decline note).
    const declineTools = isExternalLookupExplicitlyOff(settingsSnapshot)
      ? DEFAULT_TOOLS.filter((tool) => tool.presentation === "citation")
      : undefined;
    // Conversation-derived match hint: the SINGLE most-recent grounded subject, so
    // a pronoun follow-up ("how tall is it?") can resolve against it (chat #7 W2.2).
    // Recency-correct: the latest grounded turn decides the hint. Derived from the
    // store's CURRENT message list, which edit/regenerate already truncated to the
    // active branch BEFORE this runs (setMessages precedes streamResponse), so a
    // citation on a discarded later turn can't leak. The just-created streaming
    // reply (assistantId) is excluded explicitly — it carries no citation yet, but
    // excluding it is the honest invariant rather than a reliance on its empty state.
    const matchContext = deriveGroundedMatchContext(
      useChatStore.getState().messages,
      { excludeId: assistantId },
    );
    const toolStep = await runToolStep(
      latestUserText,
      {
        clearToolState,
        addToolCall,
        updateToolCall,
        setStreamPhase,
      },
      generation.abortController.signal,
      {
        tools: effectiveTools,
        // Present only when lookups are off — the disabled citation tools, so an
        // off-turn that would have looked something up declines honestly (F-1).
        ...(declineTools ? { declineTools } : {}),
        // Omit matchContext entirely when context-free, so a turn with no recent
        // grounded antecedent stays context-free (preserves the existing idiom).
        ...(Object.keys(matchContext).length > 0 ? { matchContext } : {}),
      },
    );

    // If the user pressed Stop during a (network-backed) tool lookup,
    // interruptActiveGeneration already aborted this generation, finalized the
    // streaming message as complete+interrupted, and set the phase idle. Don't
    // generate — mirror the post-primary abort-skip invariant.
    if (generation.abortController.signal.aborted) {
      clearActiveGeneration(generation);
      return;
    }

    // ── Deterministic honest decline (F-1) ────────────────────────────────
    // When web lookups are explicitly off and the turn would have needed one, the
    // tool step returns a host-rendered decline message instead of a model note.
    // We render it verbatim AS the answer and SKIP generation entirely — the small
    // model can't be trusted to obey a "decline" instruction (prod-verified: it
    // fabricates a falsely-sourced answer), so taking the model out of the loop is
    // the only way to guarantee no fabrication. No citation/verification applies.
    if (toolStep.declineMessage) {
      updateMessage(assistantId, {
        content: toolStep.declineMessage,
        status: "complete",
        inferenceMethod: "local",
        confidence: null,
      });
      finalizeAssistantMarkdown(assistantId, updateMessage);
      playMessageReceived(useSettingsStore.getState().soundsEnabled);
      clearActiveGeneration(generation);
      return;
    }

    // ── Host-authoritative identity/privacy answer (Finding G) ─────────────
    // The turn asked who/what Eco is, where the user's data goes, or "are you
    // <product>?". A sub-2B model fabricates FALSE cloud-privacy claims here (the
    // 350m starter: "your data goes to Amazon S3" in ~1/3 samples) and invents base
    // identities, inverting a privacy-first product's core promise. So the host
    // states the on-device truth verbatim AND SKIPS generation entirely — the third
    // instance of the host-authoritative pattern (calculator/datetime/unit canonical
    // answers; the F-1 lookups-off decline above). Rendered as a normal Markdown
    // assistant message via the same finalize path as the decline (NOT
    // `canonicalToolAnswer`, which is for verbatim computed values): persisted,
    // copyable, and surviving scroll-back. Structurally NOT gated by web lookups —
    // the grounding gate only filters `presentation:"citation"` tools, and the
    // identity tool is `"host-answer"`, so it is never removed. This is the
    // host-authoritative-answer corollary: when a small model reliably fabricates
    // on a known-dangerous frame, the host states the truth instead of generating.
    if (toolStep.hostAnswer !== undefined) {
      updateMessage(assistantId, {
        content: toolStep.hostAnswer,
        status: "complete",
        inferenceMethod: "local",
        confidence: null,
      });
      finalizeAssistantMarkdown(assistantId, updateMessage);
      playMessageReceived(useSettingsStore.getState().soundsEnabled);
      clearActiveGeneration(generation);
      return;
    }

    // ── Canonical exact-answer tool result ────────────────────────────────
    // A canonical tool (calculator/datetime/unit) computed the authoritative answer.
    // Set its `display` verbatim AS the message content and SKIP generation entirely,
    // exactly like the F-1 decline above — a sub-1B model reliably corrupts an exact
    // value in prose ("2 + 2 = 5"). Persisting it as content (marked canonical) is
    // what makes the correct value survive a follow-up + scroll-back and feeds
    // copy/export; the `canonicalToolAnswer` flag tells MessageBubble to render it as
    // PLAIN text (never Markdown, which would mangle "17 * 23 = 391"). No markdown
    // normalization runs — the string is a literal computed value, not streamed
    // prose. The ToolCallBlock side-channel (#222) still shows the working detail on
    // the live message; content is now the durable source of truth.
    if (toolStep.canonicalAnswer !== undefined) {
      updateMessage(assistantId, {
        content: toolStep.canonicalAnswer,
        status: "complete",
        inferenceMethod: "local",
        confidence: null,
        canonicalToolAnswer: true,
      });
      playMessageReceived(useSettingsStore.getState().soundsEnabled);
      clearActiveGeneration(generation);
      return;
    }

    // Inject the tool note into the system prompt for this single generation. The
    // displayed ToolCallBlock result stays authoritative regardless of the prose.
    // The rebuild reuses plan.hintedMessages — NOT raw apiMessages — so the
    // per-turn hints survive the tool path (raw messages here would silently
    // drop every hint on grounded/tool turns).
    const systemPrompt = toolStep.systemNote
      ? [plan.systemPrompt, toolStep.systemNote].join("\n\n")
      : plan.systemPrompt;
    const messagesWithSystem = toolStep.systemNote
      ? [{ role: "system" as const, content: systemPrompt }, ...plan.hintedMessages]
      : plan.messagesWithSystem;

    // Carry a grounding citation (found case only) onto the assistant message so
    // the citation chip renders. Decline/degraded carry none. (#5 S4 styles it.)
    if (toolStep.citation) {
      updateMessageCitations(assistantId, [
        {
          id: 1,
          title: toolStep.citation.title,
          url: toolStep.citation.url,
          source: toolStep.citation.source,
          ...(toolStep.citation.asOf ? { asOf: toolStep.citation.asOf } : {}),
          // Carry the confidence tier so the once-per-chat grounding notice can be
          // gated on a "high"-confidence hit only (provenance honesty — the notice
          // must not claim "isn't guesswork" for a fuzzy fulltext/low/followup hit).
          ...(toolStep.citation.groundingConfidence
            ? { groundingConfidence: toolStep.citation.groundingConfidence }
            : {}),
        },
      ]);
    }

    // Carry a grounding uncertainty signal (hedge/decline/degrade) onto the message
    // so the host renders the deterministic "couldn't confirm this" marker. FOUND
    // carries a citation instead; the two are mutually exclusive by construction.
    if (toolStep.verification) {
      updateMessageVerification(assistantId, toolStep.verification);
    }

    // ── Context-safety guard (oversized prompt) ───────────────────────────
    // Runs BEFORE the receipt snapshot so receipts record the GRANTED budget
    // (the clamp may shrink the request to fit context headroom). Uses the
    // HINTED messages — hint tokens now live in the user turns, and the
    // accounting must see the bytes the model will.
    const contextGuard = stopForUnsafeLocalContext(
      assistantId,
      plan.hintedMessages,
      systemPrompt,
      model,
      localGenerationOptions.max_new_tokens,
    );
    if (contextGuard.stopped) {
      clearActiveGeneration(generation);
      return;
    }
    localGenerationOptions.max_new_tokens = contextGuard.grantedNewTokens;

    // ── Runtime lease ──────────────────────────────────────────────────────
    // Hold the 'generation' lease for the whole reply (primary + repair) so a
    // model switch can never unload the runtime mid-generation. Waits out a
    // transient readiness/warmup holder (mirrors the pre-lease lifecycle-lock
    // queueing; the UI already shows the honest "loading" phase); fails
    // honestly for real conflicts (switch in progress, another tab).
    const leaseAcquisition = await acquireGenerationLease({
      signal: generation.abortController.signal,
    });
    if (!leaseAcquisition.ok) {
      if (leaseAcquisition.aborted) {
        // User stopped while waiting — the stop path already finalized the
        // message (same invariant as the post-tool abort skip).
        clearActiveGeneration(generation);
        return;
      }
      updateMessage(assistantId, {
        status: "error",
        errorMessage: leaseAcquisition.message,
        inferenceMethod: "local",
      });
      setError(leaseAcquisition.message);
      clearActiveGeneration(generation);
      return;
    }

    let effectiveGenerationOptions = { ...localGenerationOptions };
    let effectiveSystemPrompt = systemPrompt;

    // ── Per-GENERATION receipt scope ───────────────────────────────────────
    // A turn can run TWO generations: the primary, then a hard-constraint
    // repair that rewrites the system prompt and the last user turn. They are
    // separate inference runs with separate prompts, sampling and timings, so
    // each one gets its own scope and its own receipt.
    //
    // These were once turn-scoped, which silently merged the pair: the single
    // surviving row carried the repair's prompt hash and sampling but the
    // PRIMARY's first-token time and BOTH trails, and the primary generation's
    // compute vanished from diagnostics. That merge is what left the KV-reuse
    // lane unable to separate "the chat turn re-prefilled" from "the repair
    // re-prefilled" — and a repair always re-prefills by construction, since
    // it changes the front of the prompt.
    let generationRole: GenerationRole = 'primary';
    let receiptStreamStartMs = Date.now();
    // Breadcrumb trail for THIS generation. The runtime adapters emit lifecycle
    // events during load and generation; the shim forwards them to this
    // callback. We stamp each with ms-from-stream-start off our own clock
    // (event.at is a different time base) so the trail is self-consistent, and
    // derive first-token latency from the first `first-token`. Timings and
    // phase names only — never message content.
    let generationEvents: { at: number; phase: LifecyclePhase }[] = [];
    let firstTokenMs: number | null = null;

    /** Open a fresh receipt scope; every field above belongs to one generation. */
    function beginGenerationScope(role: GenerationRole): void {
      generationRole = role;
      receiptStreamStartMs = Date.now();
      generationEvents = [];
      firstTokenMs = null;
    }
    function recordLifecycleBreadcrumb(event: LifecycleEvent): void {
      const at = Date.now() - receiptStreamStartMs;
      generationEvents.push({ at, phase: event.phase });
      if (event.phase === "first-token" && firstTokenMs === null) {
        firstTokenMs = at;
      }
      // Cold-load "almost ready" signal: when the runtime finishes compiling
      // (`load-finish`, generation about to start) flip the store hint the
      // loading prelude reads. `onLoadProgress` is deliberately NOT wired — on a
      // cached cold load byte-fractions burn out in ~1s of a much longer
      // session-create, so they'd be misleading (see resolveInitialStreamPhase).
      if (event.phase === "load-finish") setLoadAlmostReady(true);
    }

    type ReceiptBase = Omit<
      GenerationReceipt,
      'status' | 'promptTokens' | 'completionTokens' | 'errorCode' | 'systemPromptHash'
    >;

    /**
     * Freeze what the CURRENT generation scope knows. Called synchronously by
     * `recordReceiptAsync`, because the prompt hash it awaits resolves a
     * microtask later — and on a repair turn the scope has been reopened by
     * then, so a lazily-built body would describe the wrong generation.
     */
    function snapshotReceiptBase(): ReceiptBase {
      return {
        generationId: generation.id,
        generationRole,
        modelId: model,
        timestamp: Date.now(),
        templateName: getLocalAiLastTemplateName(),
        samplingProfile: {
          ...(effectiveGenerationOptions.temperature != null && {
            temperature: effectiveGenerationOptions.temperature,
          }),
          ...(effectiveGenerationOptions.max_new_tokens != null && {
            maxTokens: effectiveGenerationOptions.max_new_tokens,
          }),
          ...(effectiveGenerationOptions.top_p != null && { topP: effectiveGenerationOptions.top_p }),
          ...(effectiveGenerationOptions.top_k != null && { topK: effectiveGenerationOptions.top_k }),
          ...(effectiveGenerationOptions.repetition_penalty != null && {
            repetitionPenalty: effectiveGenerationOptions.repetition_penalty,
          }),
          ...(effectiveGenerationOptions.no_repeat_ngram_size != null && {
            noRepeatNgramSize: effectiveGenerationOptions.no_repeat_ngram_size,
          }),
          intent: turnIntent,
          answerShape: plan.turnShape,
        },
        durationMs: Date.now() - receiptStreamStartMs,
        firstTokenMs,
        events: [...generationEvents],
      };
    }

    function recordReceiptAsync(
      build: (base: ReceiptBase, sph: string) => GenerationReceipt,
      prompt = effectiveSystemPrompt,
    ): void {
      // Snapshot BEFORE handing off: the hash resolves a microtask later, and
      // on a repair turn `beginGenerationScope` has reopened the scope by then.
      const base = snapshotReceiptBase();
      recordGenerationReceiptAsync(prompt, (sph) => build(base, sph));
    }

    // Terminal-status handlers shared by the primary + repair generations. Each
    // mirrors the prior single-catch behavior for that status and records the
    // matching receipt. Returning here means the turn is finished.
    function finalizeErrorResult(error: unknown): void {
      applyLocalGenerationError(error, assistantId, model);
      recordReceiptAsync((base, sph) => ({
        ...base,
        systemPromptHash: sph,
        status: 'error' as const,
        promptTokens: 0,
        completionTokens: 0,
        errorCode: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
      }));
    }

    function finalizeAbortedResult(): void {
      // Shim-originated ABORTED (rare): the user-stop path finalizes the message
      // in interruptActiveGeneration before the reader unwinds, so it is usually
      // already complete+interrupted. Finalize only if it somehow isn't.
      const msg = useChatStore.getState().messages.find((m) => m.id === assistantId);
      if (msg && msg.status !== "complete") {
        // Reaching here means interruptActiveGeneration (the user-stop path)
        // did NOT already finalize this message — the abort came from elsewhere
        // (e.g. a lookup abort), so classify it as a fault, not "you stopped".
        updateMessage(assistantId, {
          status: "complete",
          streamInterrupted: true,
          interruptedReason: "fault",
          inferenceMethod: "local",
        });
      }
      recordReceiptAsync((base, sph) => ({
        ...base,
        systemPromptHash: sph,
        status: 'aborted' as const,
        promptTokens: 0,
        completionTokens: 0,
      }));
    }

    try {
      // ── Primary generation ────────────────────────────────────────────────
      const primaryResult = await runGeneration({
        generation,
        stream: v1LocalShim.generate(messagesWithSystem, model, {
          ...localGenerationOptions,
          onLifecycleEvent: recordLifecycleBreadcrumb,
        }),
        assistantId,
        ...streamIO,
      });

      if (primaryResult.status === "error") {
        finalizeErrorResult(primaryResult.error);
        return;
      }
      if (primaryResult.status === "aborted") {
        finalizeAbortedResult();
        return;
      }

      // ── Hard-constraint repair (second generation) ────────────────────────
      // Skipped when the user stopped (abort set) — the explicit user-stop
      // invariant: a stopped turn is never silently re-generated.
      let deterministicReplacementApplied = false;
      // RAW turn again: a repair triggers on a hard constraint the USER stated,
      // so a host-authored directive must not be able to trigger one.
      const latestUserPrompt = [...apiMessages]
        .reverse()
        .find((message) => message.role === "user")?.content ?? "";
      // Conversation-integrity guard (#27): armed only when the history carries a
      // privacy marker AND this turn drafts new correspondence. Read from
      // apiMessages (the windowed history + this turn), never a host-authored
      // directive. The guarantee is applied deterministically at completion; here
      // we prefer a hardened regeneration when the primary draft actually leaked.
      const integrityGuard = derivePrivacyGuard(apiMessages, latestUserPrompt);
      const integrityLeaked =
        integrityGuard.armed
        && findLeaks(primaryResult.finalText, integrityGuard.forbiddenSpans).length > 0;
      const repair: LocalHardConstraintRepair | null =
        buildLocalHardConstraintRepair({
          userPrompt: latestUserPrompt,
          outputText: primaryResult.finalText,
        })
        ?? (integrityLeaked
          ? {
              reason: "conversation-integrity",
              ...buildIntegrityRepairPrompt(latestUserPrompt, integrityGuard.forbiddenSpans),
              generationOptions: { temperature: 0.4, top_p: 0.85 },
            }
          : null);
      if (repair && !generation.abortController.signal.aborted) {
        if (repair.replacementText !== undefined) {
          deterministicReplacementApplied = true;
          updateMessage(assistantId, {
            content: repair.replacementText,
            lastSeq: 0,
          });
          generation.batcher.resetSeq();
        } else {
          // A second generation is about to run. Record the primary's receipt
          // HERE, while the scope still describes it and before the context
          // guard below can end the turn — otherwise the primary's prompt,
          // sampling, timing and KV decision are lost, and a guard bail leaves
          // the turn with no receipt at all.
          const primaryUsage = getLocalAiLastUsage();
          recordReceiptAsync((base, sph) => ({
            ...base,
            systemPromptHash: sph,
            status: 'complete' as const,
            promptTokens: primaryUsage?.promptTokens ?? 0,
            completionTokens: primaryUsage?.completionTokens ?? 0,
            ...(primaryUsage?.kvReuse != null ? { kvReuse: primaryUsage.kvReuse } : {}),
            ...(primaryUsage?.cjkSuppression != null
              ? { cjkSuppression: primaryUsage.cjkSuppression }
              : {}),
            ...(primaryUsage?.maxInterTokenGapMs !== undefined
              ? { maxInterTokenGapMs: primaryUsage.maxInterTokenGapMs }
              : {}),
            ranToCap: ranToCapFromUsage(primaryUsage),
          }));

          const repairSystemPrompt = [systemPrompt, repair.systemInstruction].join("\n\n");
          const repairHintedMessages = [
            ...plan.hintedMessages.slice(0, -1),
            { role: "user" as const, content: repair.userPrompt },
          ];
          const repairOptions = {
            ...localGenerationOptions,
            ...repair.generationOptions,
          };
          const repairContextGuard = stopForUnsafeLocalContext(
            assistantId,
            repairHintedMessages,
            repairSystemPrompt,
            model,
            repairOptions.max_new_tokens ?? localGenerationOptions.max_new_tokens,
          );
          if (repairContextGuard.stopped) {
            return;
          }
          repairOptions.max_new_tokens = repairContextGuard.grantedNewTokens;
          beginGenerationScope('repair');
          effectiveGenerationOptions = repairOptions;
          effectiveSystemPrompt = repairSystemPrompt;
          updateMessage(assistantId, { content: "", lastSeq: 0 });
          generation.batcher.resetSeq();
          const repairMessages = [
            {
              role: "system" as const,
              content: repairSystemPrompt,
            },
            ...repairHintedMessages,
          ];
          const repairResult = await runGeneration({
            generation,
            stream: v1LocalShim.generate(
              repairMessages,
              model,
              { ...repairOptions, onLifecycleEvent: recordLifecycleBreadcrumb },
            ),
            assistantId,
            ...streamIO,
          });
          // Preserve the prior single-try semantics: a repair-stream failure was
          // caught by the same catch as the primary loop, so it routes through the
          // same error/aborted handling rather than completing normally.
          if (repairResult.status === "error") {
            finalizeErrorResult(repairResult.error);
            return;
          }
          if (repairResult.status === "aborted") {
            finalizeAbortedResult();
            return;
          }
        }
      }

      // ── Completion: usage + receipt ───────────────────────────────────────
      // INVARIANT: nothing in this block may throw. It runs outside
      // runGeneration's error mapping, so a throw would only reach the caller's
      // catch (handleStreamError) and lose the error receipt. All calls here are
      // throw-safe today (pure store reads/writes; recordReceiptAsync and
      // playMessageReceived swallow their own errors) — keep it that way.
      // confidence is always null in v1 (no heuristic confidence score).
      const lastUsage = getLocalAiLastUsage();
      const possiblyTruncated =
        !deterministicReplacementApplied
        && lastUsage?.maxTokens != null
        && lastUsage.maxTokens > 0
        && lastUsage.completionTokens != null
        && lastUsage.completionTokens >= Math.floor(lastUsage.maxTokens * 0.95);
      updateMessage(assistantId, {
        status: "complete",
        inferenceMethod: "local",
        confidence: null,
        possiblyTruncated,
        ...(lastUsage?.completionTokens != null && { localCompletionTokens: lastUsage.completionTokens }),
        ...(lastUsage?.maxTokens != null && { localMaxTokens: lastUsage.maxTokens }),
      });
      // A clean completion breaks any prior generic-failure streak.
      resetLocalGenerationFailureStreak();
      // Reconcile the persisted body with the deterministic display normalization
      // (clean completion only — a user-stopped turn keeps its raw partial text).
      if (!generation.abortController.signal.aborted) {
        // Conversation-integrity guarantee (#27): deterministically strip any private
        // span that survived the primary draft AND any regeneration above. This is the
        // hard backstop — redaction cannot fail to remove a span it was given — so a
        // leaked secret can never reach a message drafted to a third party, even when
        // the model ignores the hardened frame. Runs before the markdown normalizer so
        // the persisted body is the redacted text. Shared with the offline-continue
        // completion path via redactReplyForIntegrity so neither path can forget it.
        const current =
          useChatStore.getState().messages.find((m) => m.id === assistantId)?.content ?? "";
        const cleaned = redactReplyForIntegrity(apiMessages, current);
        if (cleaned !== current) {
          updateMessage(assistantId, { content: cleaned, lastSeq: 0 });
          generation.batcher.resetSeq();
        }
        finalizeAssistantMarkdown(assistantId, updateMessage);
      }
      recordReceiptAsync((base, sph) => ({
        ...base,
        systemPromptHash: sph,
        status: 'complete' as const,
        promptTokens: lastUsage?.promptTokens ?? 0,
        completionTokens: lastUsage?.completionTokens ?? 0,
        ...(lastUsage?.kvReuse != null ? { kvReuse: lastUsage.kvReuse } : {}),
        ...(lastUsage?.cjkSuppression != null ? { cjkSuppression: lastUsage.cjkSuppression } : {}),
        ...(lastUsage?.maxInterTokenGapMs !== undefined
          ? { maxInterTokenGapMs: lastUsage.maxInterTokenGapMs }
          : {}),
        ranToCap: ranToCapFromUsage(lastUsage),
      }));

      // Only play the received sound when the turn wasn't user-stopped.
      if (!generation.abortController.signal.aborted) {
        playMessageReceived(useSettingsStore.getState().soundsEnabled);
      }
    } finally {
      leaseAcquisition.release();
      clearActiveGeneration(generation);
    }
  }

  /**
   * Handle an unexpected error escaping the on-device stream. The local
   * inference branch already maps its own runtime failures via
   * applyLocalGenerationError; this is the top-level safety net for anything
   * that bubbles out of streamResponse (e.g. readiness/context guards that
   * throw). Partial content is preserved as an interrupted reply.
   */
  function handleStreamError(err: unknown, assistantId: string): void {
    const assistantMsg = useChatStore.getState().messages.find((m) => m.id === assistantId);
    const hasPartialContent = Boolean(assistantMsg && assistantMsg.content.length > 0);

    if (hasPartialContent) {
      updateMessage(assistantId, {
        status: "complete",
        streamInterrupted: true,
        interruptedReason: "fault",
      });
      return;
    }

    // Best-effort resolve to the dispatched model id for the streak key. The
    // resolved id isn't in scope here (this is the top-level safety net for
    // errors that escaped streamResponse), so recover it from the current
    // selection the same way resolveDispatch does.
    const modelKey = resolveSelectedModelId(useChatStore.getState().selectedModel);
    applyLocalGenerationError(err, assistantId, modelKey);
  }

  async function continueInterruptedMessageLocally(
    assistantId: string,
    apiMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    localModelId: string,
  ) {
    const localIntent = getLatestTurnIntent(apiMessages);
    const localSystemPrompt = buildQualitySystemPrompt(localModelId);
    const partialAssistantContent =
      useChatStore.getState().messages.find((message) => message.id === assistantId)?.content ?? "";
    // Same per-turn hint placement AND recaps as the primary dispatch path, in
    // the same order (KV contract: history must re-render byte-identically to
    // how it was sent). `apiMessages` is the whole branch here, unwindowed, so
    // the recaps derive from it directly.
    const localFallbackMessages = buildLocalFallbackMessages({
      systemPrompt: localSystemPrompt,
      messages: appendBranchRecaps(
        applyTurnHints(apiMessages, isLocalAiModel(localModelId), localModelId),
        buildBranchRecaps(apiMessages),
      ),
      partialAssistantContent,
    });
    const continueFinalMessage = partialAssistantContent.trim().length > 0;

    // Per-generation object (own abort + batcher + reader slot), same primitive
    // as streamResponse — this is the third former duplicated read loop.
    const generation = createGeneration(appendToMessage);
    setActiveGeneration(generation);
    updateMessage(assistantId, {
      status: "streaming",
      streamInterrupted: false,
      errorMessage: undefined,
      offlineDivider: true,
      currentGenerationId: generation.id,
      lastSeq: 0,
    });
    setError(null);
    setStreamPhase("generating");

    const localGenerationOptions = buildLocalGenerationOptions(
      localIntent,
      localModelId,
      continueFinalMessage,
    );
    const contextGuard = stopForUnsafeLocalContext(
      assistantId,
      localFallbackMessages,
      localSystemPrompt,
      localModelId,
      localGenerationOptions.max_new_tokens,
    );
    if (contextGuard.stopped) {
      clearActiveGeneration(generation);
      return;
    }
    localGenerationOptions.max_new_tokens = contextGuard.grantedNewTokens;

    // Same runtime-lease contract as streamResponse: never continue a reply
    // while a switch owns the runtime; wait out transient readiness/warmup.
    const leaseAcquisition = await acquireGenerationLease({
      signal: generation.abortController.signal,
    });
    if (!leaseAcquisition.ok) {
      if (!leaseAcquisition.aborted) {
        applyLocalGenerationError(new Error(leaseAcquisition.message), assistantId, localModelId);
      }
      clearActiveGeneration(generation);
      return;
    }

    try {
      const result = await runGeneration({
        generation,
        stream: v1LocalShim.generate(localFallbackMessages, localModelId, {
          ...localGenerationOptions,
          // Same cold-load "almost ready" signal as the primary path (above).
          onLifecycleEvent: (event) => {
            if (event.phase === "load-finish") setLoadAlmostReady(true);
          },
        }),
        assistantId,
        ...streamIO,
      });
      // The prior continue-path catch ran applyLocalGenerationError for EVERY
      // thrown error with no abort special-casing. A thrown stream surfaces as
      // either "error" or (when the abort signal is set) "aborted"; both route
      // through applyLocalGenerationError, which is itself a no-op when the
      // user-stop path already finalized the message as complete+interrupted.
      if (result.status !== "completed") {
        applyLocalGenerationError(
          result.status === "error" ? result.error : undefined,
          assistantId,
          localModelId,
        );
        return;
      }
      // v1: confidence is always null; the pipeline computes no heuristic score.
      updateMessage(assistantId, {
        status: "complete",
        inferenceMethod: "local",
        confidence: null,
      });
      // A clean continuation breaks any prior generic-failure streak.
      resetLocalGenerationFailureStreak();
      // Conversation-integrity guarantee (#27): the offline-continue path finalizes a
      // model-drafted reply too, so it must carry the SAME deterministic redaction as
      // the primary stream — otherwise a third-party draft interrupted and then
      // continued offline would bypass the backstop entirely and could leak a private
      // span. `apiMessages` is the whole branch here; the shared helper derives the
      // guard from it and strips any forbidden span before the body is persisted.
      const guardedContent =
        useChatStore.getState().messages.find((m) => m.id === assistantId)?.content ?? "";
      const redacted = redactReplyForIntegrity(apiMessages, guardedContent);
      if (redacted !== guardedContent) {
        updateMessage(assistantId, { content: redacted, lastSeq: 0 });
        generation.batcher.resetSeq();
      }
      // Reconcile persisted body with the deterministic display normalization
      // (this block is reached only on a clean "completed" continuation).
      finalizeAssistantMarkdown(assistantId, updateMessage);
      playMessageReceived(useSettingsStore.getState().soundsEnabled);
    } finally {
      leaseAcquisition.release();
      clearActiveGeneration(generation);
    }
  }

  async function sendMessage(content: string, parentId?: string | null) {
    const trimmed = content.trim();
    if (!trimmed || useChatStore.getState().isStreaming) return;

    setError(null);

    // Compute parentId for the user message: either explicitly provided,
    // or the last message in the current branch
    const currentMessages = useChatStore.getState().messages;
    const userParentId = parentId !== undefined
      ? parentId
      : (currentMessages.length > 0 ? currentMessages[currentMessages.length - 1]!.id : null);

    const userId = addMessage({ role: "user", content: trimmed, parentId: userParentId });
    const routeSnapshot = buildChatRouteRecommendationSnapshot({
      prompt: trimmed,
      selectedModel: useChatStore.getState().selectedModel,
      researchMode: false,
      fileAttachments: useChatStore.getState().fileAttachments,
    });
    useChatStore.getState().setRouteRecommendationSnapshot(routeSnapshot);
    // Honest cold-load feedback: "loading" when the target model isn't resident
    // yet (warmup pending / fresh model), else today's "thinking" (#4 W3a).
    setStreamPhase(
      resolveInitialStreamPhase(useChatStore.getState().selectedModel),
    );

    // Play wind-chime tone when sending (reads setting at call time, not reactively)
    playMessageSent(useSettingsStore.getState().soundsEnabled);

    const assistantId = addMessage({ role: "assistant", content: "", parentId: userId });
    updateMessage(assistantId, { status: "streaming" });

    // Save messages to IndexedDB immediately
    const convId = useConversationStore.getState().activeConversationId;
    if (convId) {
      const convStore = useConversationStore.getState();
      const userMsg = useChatStore.getState().messages.find((m) => m.id === userId);
      const assistantMsg = useChatStore.getState().messages.find((m) => m.id === assistantId);
      if (userMsg) convStore.saveMessage(toDbMessage(userMsg, convId));
      if (assistantMsg) convStore.saveMessage(toDbMessage(assistantMsg, convId));
      // Update activeLeafId immediately (before API call) to prevent UI flash
      convStore.updateConversation(convId, { activeLeafId: assistantId });
    }

    try {
      const allMsgs = useChatStore.getState().messages;
      const msgsForApi = allMsgs.filter((m) => m.id !== assistantId);
      // Apply context window: only send messages that fit in the model's context
      const windowedMsgs = selectMessagesForContext(
        msgsForApi,
        effectiveModelContextLength,
        composedSystemPrompt,
        { reservedOverheadTokens: estimateRenderingOverhead(msgsForApi, effectiveModelContextLength) },
      );
      const apiMessages = windowedMsgs.map((m) => ({ role: m.role, content: m.content }));

      // Derived from the FULL branch, never the window — see `streamResponse`.
      await streamResponse(assistantId, apiMessages, buildBranchRecaps(msgsForApi));
    } catch (err) {
      // Don't treat a user-stop abort as an error.
      if (!isActiveGenerationAborted()) {
        handleStreamError(err, assistantId);
      }
    } finally {
      setStreamPhase("idle");
    }
  }

  /**
   * Edit a user message: creates a new sibling user message with new content,
   * then streams a new assistant response on the new branch.
   */
  async function editMessage(messageId: string, newContent: string) {
    const trimmed = newContent.trim();
    if (!trimmed || useChatStore.getState().isStreaming) return;

    const currentMessages = useChatStore.getState().messages;
    const editedMsg = currentMessages.find((m) => m.id === messageId);
    if (!editedMsg) return;

    setError(null);

    // New user message is a sibling of the original (same parentId)
    const newUserId = addMessage({
      role: "user",
      content: trimmed,
      parentId: editedMsg.parentId ?? null,
    });
    useChatStore.getState().setRouteRecommendationSnapshot(
      buildChatRouteRecommendationSnapshot({
        prompt: trimmed,
        selectedModel: useChatStore.getState().selectedModel,
        researchMode: false,
        fileAttachments: useChatStore.getState().fileAttachments,
      }),
    );

    setStreamPhase(
      resolveInitialStreamPhase(useChatStore.getState().selectedModel),
    );

    // New assistant message is a child of the new user message
    const newAssistantId = addMessage({
      role: "assistant",
      content: "",
      parentId: newUserId,
    });
    updateMessage(newAssistantId, { status: "streaming" });

    // Save to IndexedDB and update activeLeafId IMMEDIATELY
    const convId = useConversationStore.getState().activeConversationId;
    if (convId) {
      const convStore = useConversationStore.getState();
      const userMsg = useChatStore.getState().messages.find((m) => m.id === newUserId);
      const assistantMsg = useChatStore.getState().messages.find((m) => m.id === newAssistantId);
      if (userMsg) convStore.saveMessage(toDbMessage(userMsg, convId));
      if (assistantMsg) convStore.saveMessage(toDbMessage(assistantMsg, convId));
      convStore.updateConversation(convId, { activeLeafId: newAssistantId });
    }

    // Rebuild the active branch for API: walk from the new user message up to root
    const allMsgs = useChatStore.getState().messages;

    // Walk up from the new user message's parent
    let currentId = editedMsg.parentId ?? null;
    const msgById = new Map(allMsgs.map((m) => [m.id, m]));
    const ancestors: ChatMessage[] = [];
    while (currentId) {
      const msg = msgById.get(currentId);
      if (!msg) break;
      ancestors.push(msg);
      currentId = msg.parentId ?? null;
    }
    ancestors.reverse();
    const latestUserPrompt = [...ancestors]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
    useChatStore.getState().setRouteRecommendationSnapshot(
      buildChatRouteRecommendationSnapshot({
        prompt: latestUserPrompt,
        selectedModel: useChatStore.getState().selectedModel,
        researchMode: false,
        fileAttachments: useChatStore.getState().fileAttachments,
      }),
    );

    // Build the full branch including the new user message
    const newUserMsg = allMsgs.find((m) => m.id === newUserId);
    const fullBranch = [...ancestors, ...(newUserMsg ? [newUserMsg] : [])];

    // Apply context window to the branch
    const windowedBranch = selectMessagesForContext(
      fullBranch,
      effectiveModelContextLength,
      composedSystemPrompt,
      { reservedOverheadTokens: estimateRenderingOverhead(fullBranch, effectiveModelContextLength) },
    );
    const branchForApi = windowedBranch.map((m) => ({ role: m.role, content: m.content }));

    // Update displayed messages to show the new branch
    const newBranch = [...ancestors, ...allMsgs.filter((m) => m.id === newUserId || m.id === newAssistantId)];
    useChatStore.getState().setMessages(newBranch);
    // CS-2: restore streaming state since setMessages resets it to idle/isStreaming=false.
    // Without this, the Stop button disappears and send/edit/regenerate guards open to
    // overlapping generation. Same pattern as regenerateMessage (~line 1845-1849).
    useChatStore
      .getState()
      .setStreamPhase(
        resolveInitialStreamPhase(useChatStore.getState().selectedModel),
      );

    try {
      await streamResponse(newAssistantId, branchForApi, buildBranchRecaps(fullBranch));
    } catch (err) {
      if (!isActiveGenerationAborted()) {
        handleStreamError(err, newAssistantId);
      }
    } finally {
      setStreamPhase("idle");
    }
  }

  /**
   * Regenerate the latest assistant message: creates a new sibling assistant
   * message with the same parent, then streams a new response.
   *
   * `overrides` shapes THAT ONE generation (forced intent and/or a model-facing
   * directive) without touching the conversation: the ancestors below are read
   * from the store and passed through unchanged, and the directive is composed
   * downstream in `buildPrompt` onto a copy. Omitted ⇒ a plain regenerate.
   */
  async function regenerateMessage(messageId: string, overrides?: RegenerateOverrides) {
    if (useChatStore.getState().isStreaming) return;

    const currentMessages = useChatStore.getState().messages;
    const originalMsg = currentMessages.find((m) => m.id === messageId);
    if (!originalMsg || originalMsg.role !== "assistant") return;

    // Verify it's the latest assistant message
    const lastAssistant = [...currentMessages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant || lastAssistant.id !== messageId) return;

    setError(null);

    // New assistant is a sibling of the original (same parentId)
    const newAssistantId = addMessage({
      role: "assistant",
      content: "",
      parentId: originalMsg.parentId ?? null,
    });
    updateMessage(newAssistantId, { status: "streaming" });
    setStreamPhase(
      resolveInitialStreamPhase(useChatStore.getState().selectedModel),
    );

    // Save to IndexedDB and update activeLeafId IMMEDIATELY
    const convId = useConversationStore.getState().activeConversationId;
    if (convId) {
      const convStore = useConversationStore.getState();
      const assistantMsg = useChatStore.getState().messages.find((m) => m.id === newAssistantId);
      if (assistantMsg) convStore.saveMessage(toDbMessage(assistantMsg, convId));
      convStore.updateConversation(convId, { activeLeafId: newAssistantId });
    }

    // Build API messages: all messages up to and including the parent of the original
    const allMsgs = useChatStore.getState().messages;
    const msgById = new Map(allMsgs.map((m) => [m.id, m]));
    const ancestors: ChatMessage[] = [];
    let currentId = originalMsg.parentId ?? null;
    while (currentId) {
      const msg = msgById.get(currentId);
      if (!msg) break;
      ancestors.push(msg);
      currentId = msg.parentId ?? null;
    }
    ancestors.reverse();
    // Apply context window to ancestors before sending
    const windowedAncestors = selectMessagesForContext(
      ancestors,
      effectiveModelContextLength,
      composedSystemPrompt,
      { reservedOverheadTokens: estimateRenderingOverhead(ancestors, effectiveModelContextLength) },
    );
    const apiMessages = windowedAncestors.map((m) => ({ role: m.role, content: m.content }));

    // Update displayed messages: show ancestors + new assistant (replacing old one)
    const newBranch = [...ancestors, ...allMsgs.filter((m) => m.id === newAssistantId)];
    useChatStore.getState().setMessages(newBranch);
    // Restore streaming state since setMessages resets it. Re-decide residency so
    // a cold-load regenerate keeps the honest "loading" phase (not "thinking").
    useChatStore
      .getState()
      .setStreamPhase(
        resolveInitialStreamPhase(useChatStore.getState().selectedModel),
      );

    try {
      await streamResponse(
        newAssistantId,
        apiMessages,
        buildBranchRecaps(ancestors),
        overrides,
      );
    } catch (err) {
      if (!isActiveGenerationAborted()) {
        handleStreamError(err, newAssistantId);
      }
    } finally {
      setStreamPhase("idle");
    }
  }

  async function retryMessage(messageId: string) {
    const allMessages = useChatStore.getState().messages;
    const failedIdx = allMessages.findIndex((m) => m.id === messageId);
    if (failedIdx < 0) return;
    const failedAssistant = allMessages[failedIdx];
    if (!failedAssistant || failedAssistant.role !== "assistant") {
      return;
    }
    // Find the preceding user message
    let userMsg: ChatMessage | undefined;
    for (let i = failedIdx - 1; i >= 0; i--) {
      if (allMessages[i]?.role === "user") { userMsg = allMessages[i]; break; }
    }
    if (!userMsg) return;

    const shouldContinueInterruptedReplyLocally =
      failedAssistant.streamInterrupted
      && failedAssistant.content.trim().length > 0
      && typeof navigator !== "undefined"
      && navigator.onLine === false;

    if (shouldContinueInterruptedReplyLocally) {
      const currentSlotModelId =
        getLocalAiSlot('eco-fast').model?.id
        ?? getLocalAiSlot('eco-smart').model?.id
        ?? null;
      const localModelId = await resolveReadyLocalRecoveryModelId({
        currentModelId: currentSlotModelId,
        preferredModelId: selectedModel,
      });

      if (localModelId) {
        const apiMessages = allMessages
          .slice(0, failedIdx)
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({ role: message.role, content: message.content }));

        try {
          await continueInterruptedMessageLocally(messageId, apiMessages, localModelId);
        } finally {
          setStreamPhase("idle");
        }
        return;
      }
    }

    // CS-1: regenerate-style retry — reuse the EXISTING user turn, create a
    // fresh assistant SIBLING. The old failed assistant stays as a hidden
    // sibling (same as regenerateMessage leaves the old one). The old code
    // called removeMessage + sendMessage, which added a SECOND identical user
    // turn (duplicate in the transcript + malformed user→user history for
    // apply_chat_template).
    setError(null);
    const retryAssistantId = addMessage({
      role: "assistant",
      content: "",
      parentId: failedAssistant.parentId ?? null,
    });
    updateMessage(retryAssistantId, { status: "streaming" });
    setStreamPhase(
      resolveInitialStreamPhase(useChatStore.getState().selectedModel),
    );

    // Save to IndexedDB immediately
    const convId = useConversationStore.getState().activeConversationId;
    if (convId) {
      const convStore = useConversationStore.getState();
      const assistantMsg = useChatStore.getState().messages.find((m) => m.id === retryAssistantId);
      if (assistantMsg) convStore.saveMessage(toDbMessage(assistantMsg, convId));
      convStore.updateConversation(convId, { activeLeafId: retryAssistantId });
    }

    // Build ancestors by walking up from failedAssistant.parentId (the user turn)
    const retryAllMsgs = useChatStore.getState().messages;
    const retryMsgById = new Map(retryAllMsgs.map((m) => [m.id, m]));
    const retryAncestors: ChatMessage[] = [];
    let retryCurrentId: string | null = failedAssistant.parentId ?? null;
    while (retryCurrentId) {
      const m = retryMsgById.get(retryCurrentId);
      if (!m) break;
      retryAncestors.push(m);
      retryCurrentId = m.parentId ?? null;
    }
    retryAncestors.reverse();

    // Apply context window to ancestors
    const retryWindowedAncestors = selectMessagesForContext(
      retryAncestors,
      effectiveModelContextLength,
      composedSystemPrompt,
      { reservedOverheadTokens: estimateRenderingOverhead(retryAncestors, effectiveModelContextLength) },
    );
    const retryApiMessages = retryWindowedAncestors.map((m) => ({ role: m.role, content: m.content }));

    // Update displayed messages: ancestors + new assistant (old failed stays as hidden sibling)
    const retryBranch = [...retryAncestors, ...retryAllMsgs.filter((m) => m.id === retryAssistantId)];
    useChatStore.getState().setMessages(retryBranch);
    // Restore streaming state since setMessages resets it (CS-2 pattern)
    useChatStore
      .getState()
      .setStreamPhase(
        resolveInitialStreamPhase(useChatStore.getState().selectedModel),
      );

    try {
      await streamResponse(retryAssistantId, retryApiMessages, buildBranchRecaps(retryAncestors));
    } catch (err) {
      if (!isActiveGenerationAborted()) {
        handleStreamError(err, retryAssistantId);
      }
    } finally {
      setStreamPhase("idle");
    }
  }

  // ── Invisible readiness retry ──────────────────────────────────────────
  // A send blocked by slot readiness leaves the user's message answered only
  // by an error card. When the blocking slot becomes ready (boot promotion,
  // the recovery card's driver, a Settings setup run), retry that turn
  // automatically — the person never has to resend (no-excuse-UI). Guarded
  // per message id so a retry that fails for a NEW reason is never looped.
  const autoRetriedMessageIdsRef = useRef<Set<string>>(new Set());

  function maybeAutoRetryReadinessFailure(slot: LocalAiSlot): void {
    const target = findAutoRetryTarget(useChatStore.getState().messages, slot);
    if (!target || autoRetriedMessageIdsRef.current.has(target)) return;
    autoRetriedMessageIdsRef.current.add(target);
    void (async () => {
      // The 'ready' flip usually lands while the repairing pipeline still
      // holds the heavy-work lease (released just after). Wait briefly for
      // the runtime to free rather than bouncing off the busy guard.
      for (let attempt = 0; attempt < 40; attempt++) {
        if (getActiveLocalHeavyWorkLease() === null) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await retryMessage(target);
    })();
  }

  useEffect(() => {
    const unsubscribe = subscribeLocalAiSlots((slot, state) => {
      if (state.status !== "ready") return;
      maybeAutoRetryReadinessFailure(slot);
    });
    // Boot-time promotion (reconcilePreparingSlots) can flip the slot before
    // this subscription exists — check once on mount so a stranded readiness
    // card from the previous visit finally gets its answer.
    for (const slot of ["eco-fast", "eco-smart"] as const) {
      if (getLocalAiSlot(slot).status === "ready") {
        maybeAutoRetryReadinessFailure(slot);
      }
    }
    return unsubscribe;
    // Mount-only: the subscription callback reads live store state itself.
  }, []);

  async function continueLatestTurnLocally(localModelId?: string) {
    const currentSlotModelId =
      getLocalAiSlot('eco-fast').model?.id
      ?? getLocalAiSlot('eco-smart').model?.id
      ?? null;
    const targetModel = localModelId ?? await resolveReadyLocalRecoveryModelId({
      currentModelId: currentSlotModelId,
      preferredModelId: useChatStore.getState().selectedModel,
    });
    if (!targetModel) {
      setError("No prepared local model is ready for this turn yet.");
      return;
    }
    const allMessages = useChatStore.getState().messages;
    const lastUserIndex = [...allMessages]
      .map((message, index) => ({ message, index }))
      .reverse()
      .find((entry) => entry.message.role === "user")?.index;

    if (lastUserIndex === undefined) {
      return;
    }

    const lastUser = allMessages[lastUserIndex];
    if (!lastUser) {
      return;
    }

    const assistantToReplace = allMessages
      .slice(lastUserIndex + 1)
      .find((message) => message.role === "assistant");

    if (useChatStore.getState().isStreaming) {
      stopGeneration();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (assistantToReplace) {
      removeMessage(assistantToReplace.id);
    }
    removeMessage(lastUser.id);

    // Request-local retarget, not a chosen model — same reasoning as the
    // normalization write in `resolveDispatch`.
    silentModelSwitchRef.current = true;
    useChatStore.getState().setSelectedModel(targetModel, {
      persist: false,
      explicit: false,
    });
    setError(null);
    await sendMessage(lastUser.content, lastUser.parentId ?? null);
  }

  function stopGeneration() {
    // Flush pending tokens first so explicit stop preserves the latest visible
    // partial reply before transitioning into the interrupted state.
    // interruptActiveGeneration() aborts the active generation's controller; the
    // v1 shim's ReadableStream cancel() callback forwards that abort to the
    // lifecycle's AbortController, so no separate abort call is needed.
    interruptActiveGeneration();
  }

  // Compute the context divider position for the current message list.
  // Memoized so it only recalculates when messages or context params change.
  const contextDividerIndex = useMemo(() => {
    if (messages.length === 0) return -1;
    const selection = selectContextWindow(
      messages,
      effectiveModelContextLength,
      composedSystemPrompt,
      { reservedOverheadTokens: estimateRenderingOverhead(messages, effectiveModelContextLength) },
    );
    return findContextDividerIndex(messages, selection);
  }, [messages, effectiveModelContextLength, composedSystemPrompt]);

  // The quiet "this model holds less of the conversation" note.
  //
  // Raised only when BOTH are true: the newly selected model's context window
  // is genuinely SMALLER than the one before it (switching to the deeper 2.6B
  // halves it, 8192 → 4096), and this conversation actually overflows the new
  // window, which is exactly when the divider moves. A shrink the chat fits
  // inside changes nothing the person can see, so it says nothing.
  //
  // The two normalization writes (`resolveDispatch`'s unbound-id rewrite and
  // the continue-locally retarget) also change `selectedModel`, but they are
  // Eco repairing its own state — not a choice the person made — so they arm
  // `silentModelSwitchRef` and the next run of this effect skips.
  useEffect(() => {
    const previousContextLength = priorContextLengthRef.current;
    priorContextLengthRef.current = effectiveModelContextLength;
    const wasSilent = silentModelSwitchRef.current;
    silentModelSwitchRef.current = false;
    if (previousContextLength === null || wasSilent) return;
    if (effectiveModelContextLength >= previousContextLength) return;
    if (contextDividerIndex < 0) return;
    useChatStore.getState().showContextWindowNotice();
  }, [selectedModel, effectiveModelContextLength, contextDividerIndex]);

  return { messages, isStreaming, streamPhase, error, sendMessage, editMessage, regenerateMessage, clearMessages, retryMessage, continueLatestTurnLocally, stopGeneration, contextDividerIndex, activeToolCalls };
}
