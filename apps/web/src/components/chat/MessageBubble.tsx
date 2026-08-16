// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { getTransition } from "@eco/ui";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { StreamingCursor } from "./StreamingCursor";
import { TokenRate } from "./TokenRate";
import { MessageActions } from "./MessageActions";
import type { AssistantReplyControl } from "./MessageActions";
// MessageReactions removed — emoji reactions were cluttering the UI
import { ErrorMessage } from "./ErrorMessage";
import type { LocalModelPrepareState } from "./ErrorMessage";
import { StreamInterrupted } from "./StreamInterrupted";
import { BranchNavigation } from "./BranchNavigation";
import { EditMessage } from "./EditMessage";
import { FileBlock, parseFileBlocks } from "./FileBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { CitationBlock } from "./CitationBlock";
import { GroundingNotice } from "./GroundingNotice";
import { UncertaintyNote } from "./UncertaintyNote";
import { ThinkingBlock } from "./ThinkingBlock";

import { OfflineDivider } from "./OfflineDivider";
import { useSettingsStore } from "../../stores/settingsStore";
import { EcoLogo } from "../EcoLogo";
import { timeAgo } from "../../lib/time";
import { useChatStore } from "../../stores/chatStore";
import type {
  LocalModelReadinessAction,
  MessageStatus,
  StreamPhase,
} from "../../stores/chatStore";
import type { ToolCallDisplay } from "../../lib/tool-parser";
import type { Citation } from "../../lib/citation-parser";
import type { GroundingVerification } from "../../lib/tools";
import type { MessageReaction } from "../../lib/db";

type MessageBubbleProps = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
  isStreaming?: boolean;
  streamPhase?: StreamPhase;
  status?: MessageStatus;
  errorMessage?: string;
  onRetry?: () => void;
  localReadiness?: LocalModelReadinessAction;
  localPrepareState?: LocalModelPrepareState;
  onPrepareLocalModel?: (modelId: string) => void;
  tokenCount?: number;
  streamStartTime?: number | null;
  // Branch navigation
  siblingInfo?: { currentIndex: number; total: number };
  onNavigatePrev?: () => void;
  onNavigateNext?: () => void;
  // Edit/regenerate
  onEdit?: () => void;
  onRegenerate?: () => void;
  onAssistantAction?: (action: AssistantReplyControl) => void;
  isLatestAssistant?: boolean;
  /**
   * True only for the FIRST HIGH-CONFIDENCE grounded assistant message in the
   * conversation (computed in `MessageList`). Gates the once-per-chat grounding
   * notice — anchoring it to the first grounded reply instead of the latest stops it
   * reappearing under every new grounded answer, and requiring high confidence keeps
   * the "isn't guesswork" disclosure off fuzzy (fulltext/low/followup) groundings
   * whose cited article may be off-target.
   */
  isFirstGrounded?: boolean;
  /** Dev-gated (lib/dev-capture.ts): flag this reply into the eval capture set. */
  onFlagForEval?: () => void;
  isEditing?: boolean;
  onSaveEdit?: (content: string) => void;
  onCancelEdit?: () => void;
  toolCalls?: ToolCallDisplay[];
  /** When true, the message animates in with a fade-up entrance. */
  isNew?: boolean;
  /** When true, stream was interrupted mid-response (partial content). */
  streamInterrupted?: boolean;
  /** Why the stream was interrupted, when known — drives per-cause marker copy. */
  interruptedReason?: "user-stop" | "fault" | "restore-detected";
  /** When true, a local response ended near its generation limit. */
  possiblyTruncated?: boolean;
  /**
   * Completion tokens this reply produced, when known. Only used to decide
   * whether "Just the answer" has any length left to remove — see
   * `MessageActions`. Absent for any reply restored from IndexedDB.
   */
  localCompletionTokens?: number;
  /** Concrete model selected by orchestrator when user chose "auto". */
  resolvedModel?: string;
  /** Whether the message was generated locally or remotely. */
  inferenceMethod?: "remote" | "local";
  /** Confidence score from local inference (0-1). */
  confidence?: number | null;
  /** True when this message had a network drop and continued locally. */
  offlineDivider?: boolean;
  /** Called when user clicks re-ask CTA to send the same prompt via network. */
  onReask?: () => void;
  /** The user prompt that led to this assistant reply, when available. */
  promptContent?: string;
  /** Conversation ID for the device-privacy tooltip per-conversation dismissal. */
  conversationId?: string;
  /** Structured citations from research mode responses. */
  citations?: Citation[];
  /**
   * Grounding uncertainty marker from a grounding tool's no-source outcomes (hedge /
   * decline / degrade). When present on a finished reply with no sourced citation, the
   * bubble renders a deterministic "couldn't confirm this" note — the honest counterpart
   * to the source chip. Mutually exclusive with a sourced citation (a turn is FOUND xor not).
   */
  verification?: GroundingVerification;
  /**
   * True when this assistant message is a canonical exact-answer tool result
   * (calculator/datetime/unit) whose `content` IS the host-computed value. Set at
   * finalize and persisted, so an earlier canonical turn keeps its plain-text
   * treatment after a follow-up scrolls it out of the transient `toolCalls`
   * side-channel (which only reaches the last assistant message).
   */
  canonicalToolAnswer?: boolean;
  // Reactions
  reactions?: MessageReaction[];
  onReact?: (emoji: string) => void;
  onRemoveReaction?: (emoji: string) => void;
};

export function MessageBubble({
  role,
  content,
  timestamp,
  isStreaming = false,
  streamPhase,
  status,
  errorMessage,
  onRetry,
  localReadiness,
  localPrepareState,
  onPrepareLocalModel,
  tokenCount,
  streamStartTime,
  siblingInfo,
  onNavigatePrev,
  onNavigateNext,
  onEdit,
  onRegenerate,
  onAssistantAction,
  isLatestAssistant,
  isFirstGrounded,
  onFlagForEval,
  isEditing,
  onSaveEdit,
  onCancelEdit,
  toolCalls,
  offlineDivider,
  citations,
  verification,
  canonicalToolAnswer,
  conversationId: _conversationId,
  isNew: _isNew = false,
  streamInterrupted = false,
  interruptedReason,
  possiblyTruncated = false,
  localCompletionTokens,
  resolvedModel: _resolvedModel,
  reactions: _reactions,
  onReact: _onReact,
  onRemoveReaction: _onRemoveReaction,
}: MessageBubbleProps) {
  const autoAcceptTools = useSettingsStore((s) => s.autoAcceptTools);
  const showTechnicalDetails = useSettingsStore((s) => s.showTechnicalDetails);
  const groundingNoticeSeen = useSettingsStore((s) => s.groundingNoticeSeen);
  const shouldReduce = useReducedMotion();
  const isUser = role === "user";

  // A grounded answer carries exactly the citation the source chip renders: one
  // citation with a truthy `source` (e.g. "Wikipedia"). Same condition the chip
  // keys on, so the notice only ever sits under a real grounded reply.
  const hasGroundingCitation = !!citations?.some((c) => !!c.source);

  // The honest counterpart to the source chip: when grounding gave an answer it
  // couldn't confirm (hedge/decline/degrade), it sets `verification` instead of a
  // citation. Render the marker on the FINISHED reply only, and only when there's no
  // sourced citation — a turn is FOUND xor not, so the two never co-render.
  const showUncertaintyNote =
    !isStreaming && status !== "error" && !!verification && !hasGroundingCitation;

  // The grounding disclosure shows ONCE PER CHAT: under the FIRST high-confidence
  // grounded answer only (finished + grounded) — NOT the latest, otherwise it
  // reappears under every new grounded reply and the user has to dismiss it each
  // time (the bug Cam hit). The "first high-confidence grounded" decision lives in
  // `MessageList` (isFirstGrounded), so a fuzzy grounding never anchors the notice —
  // it keeps its chip but not the "isn't guesswork" claim. Still gated by the global
  // `groundingNoticeSeen` opt-out: Dismiss/Manage flips that flag → it never returns.
  const showGroundingNotice =
    !isStreaming &&
    hasGroundingCitation &&
    isFirstGrounded === true &&
    !groundingNoticeSeen;

  // Parse <think>...</think> blocks from assistant content
  const { thinkContent, displayContent } = useMemo(() => {
    if (isUser) return { thinkContent: null, displayContent: content };
    const match = /^<think>([\s\S]*?)<\/think>\s*/.exec(content);
    if (match) {
      return {
        thinkContent: match[1]?.trim() ?? null,
        displayContent: content.slice(match[0].length),
      };
    }
    return { thinkContent: null, displayContent: content };
  }, [isUser, content]);

  // Parse file blocks from user messages
  const parsedContent = useMemo(() => {
    if (!isUser || !content.includes("<file")) return null;
    return parseFileBlocks(content);
  }, [isUser, content]);

  // A CANONICAL exact-answer tool (calculator/datetime/unit — `presentation:
  // "tool-block"`) computes the authoritative answer on-device. Host-driven tool
  // SELECTION already keeps the model out of the decision; this keeps it out of the
  // ANSWER too. A sub-1B starter routinely writes a wrong number in prose ("2 + 2 =
  // 5") while the correct value sits in the tool result — so for these turns the
  // tool's `result` IS the answer and the model's prose is suppressed in its favour.
  // No raw-value-vs-contradicting-prose side-by-side. Keyed strictly on an explicit
  // `presentation === "tool-block"` (stamped by the host in tool-step) so nothing
  // else — grounding citations (no block), a future model-native code block — is
  // ever treated as a canonical answer. Match is conservative enough that these
  // tools only fire on arithmetic/exact turns, so nothing conversational is lost.
  // LIVE side-channel path (#222): the transient tool call reaches only the LAST
  // assistant message and carries the canonical result while streaming / just after.
  const canonicalToolCall = useMemo(() => {
    if (isUser || !toolCalls) return null;
    return (
      toolCalls.find((tc) => tc.presentation === "tool-block") ?? null
    );
  }, [isUser, toolCalls]);
  const liveCanonicalAnswer =
    canonicalToolCall?.status === "complete" &&
    typeof canonicalToolCall.result === "string" &&
    canonicalToolCall.result.trim() !== ""
      ? canonicalToolCall.result
      : null;

  // A canonical exact-answer turn is either LIVE (transient tool call present) or
  // PERSISTED (the `canonicalToolAnswer` flag, set at finalize and reloaded from
  // IndexedDB). The persisted path is what carries the treatment to an EARLIER turn
  // after a follow-up scrolls the answer out of the live side-channel — the fix for
  // "send 2+2 → see 4, send anything → scroll up → the wrong prose is back".
  const isCanonicalAnswer =
    !isUser && (canonicalToolCall !== null || canonicalToolAnswer === true);

  // The plain value to show. The live tool result wins while streaming. The
  // persisted `content` is the fallback ONLY on the finalized/reloaded path (the
  // `canonicalToolAnswer` flag) — never for a still-running LIVE tool call, where
  // `content` is transient model prose, not yet the canonical answer (that would
  // surface the wrong prose while the tool works). Rendered as plain text, never
  // through Markdown — a display like "17 * 23 = 391" would be mangled into italics.
  const canonicalAnswerText =
    liveCanonicalAnswer ??
    (canonicalToolAnswer === true && displayContent.trim() !== ""
      ? displayContent
      : null);

  const hasVisibleAssistantContent = isCanonicalAnswer
    ? canonicalAnswerText !== null
    : displayContent.trim().length > 0;

  return (
    <motion.div
      role="article"
      aria-label={`Message from ${role}`}
      initial={shouldReduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={getTransition("gentle", shouldReduce)}
      layout={false}
      className={[
        "group flex w-full items-start gap-2.5 px-4 py-3",
        isUser ? "justify-end" : "justify-start",
      ].join(" ")}
    >
      {!isUser && (
        <div className={`mt-3 shrink-0 transition-opacity ${isStreaming ? "opacity-70" : ""}`}>
          <EcoLogo iconOnly size="sm" />
        </div>
      )}

      <div className={isUser ? "max-w-[75%] space-y-1.5" : "max-w-[min(100%,48rem)] space-y-1.5"}>
        {/* Edit mode: show textarea instead of bubble content */}
        {isEditing && isUser && onSaveEdit && onCancelEdit ? (
          <EditMessage
            content={content}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
          />
        ) : (
          <div
            className={[
              "text-[15px]",
              isUser
                ? "ml-auto w-fit rounded-3xl bg-[var(--eco-primary)] dark:bg-gradient-to-br dark:from-[var(--eco-primary)] dark:to-[var(--eco-primary-hover)] px-4 py-3 text-[var(--eco-on-primary)] shadow-sm"
                : "w-full rounded-xl px-1 py-1 text-[var(--eco-text)]",
            ].join(" ")}
          >
            {isUser ? (
              parsedContent && parsedContent.files.length > 0 ? (
                <div className="space-y-2">
                  {parsedContent.files.map((f, i) => (
                    <FileBlock
                      key={`${f.name}-${String(i)}`}
                      filename={f.name}
                      size={f.size}
                      type={f.name.endsWith(".pdf") ? "pdf" : f.name.endsWith(".csv") ? "csv" : "text"}
                      content={f.content}
                    />
                  ))}
                  {parsedContent.userText && (
                    <p className="whitespace-pre-wrap leading-relaxed">{parsedContent.userText}</p>
                  )}
                </div>
              ) : (
                <p className="whitespace-pre-wrap leading-relaxed">{content}</p>
              )
            ) : (
              <div>
                {/* ThinkingBlock: collapsible reasoning block */}
                {thinkContent && (
                  <div className="mb-2">
                    <ThinkingBlock content={thinkContent} />
                  </div>
                )}
                {/* Offline divider when network dropped mid-stream */}
                {offlineDivider && <OfflineDivider />}
                {isStreaming && !hasVisibleAssistantContent && (
                  <StreamingPrelude phase={streamPhase} />
                )}
                {isCanonicalAnswer ? (
                  // Canonical exact-answer turn: the host-computed value is the
                  // answer. Render it as plain text (never through Markdown — a
                  // calculator display like "17 * 23 = 391" would otherwise be
                  // mangled into italics by the `*`). The model's prose is dropped
                  // so its wrong number can't compete with the correct value. Live,
                  // the value comes from the transient tool call; on scroll-back /
                  // reload it comes from the persisted `content` (same string). While
                  // the tool is still running the value is null and the running
                  // ToolCallBlock below carries the working state.
                  canonicalAnswerText !== null && (
                    <p
                      data-testid="canonical-tool-answer"
                      className="whitespace-pre-wrap text-[15px] font-medium leading-relaxed text-[var(--eco-text)]"
                    >
                      {canonicalAnswerText}
                    </p>
                  )
                ) : (
                  <>
                    <MarkdownRenderer content={displayContent} isStreaming={isStreaming} hasCitations={!!citations?.length} />
                    {isStreaming && hasVisibleAssistantContent && <StreamingCursor phase={streamPhase} />}
                  </>
                )}
                {/* Research mode citation sources */}
                {citations && citations.length > 0 && !isStreaming && (
                  <CitationBlock citations={citations} />
                )}
                {/* Deterministic "couldn't confirm this" marker — the honest
                    counterpart to the source chip, shown when grounding gave an
                    answer it couldn't back with a source. */}
                {showUncertaintyNote && verification && (
                  <UncertaintyNote status={verification.status} />
                )}
                {/* One-time grounding disclosure under the latest grounded answer */}
                {showGroundingNotice && <GroundingNotice />}
                {/* Tool call blocks */}
                {toolCalls && toolCalls.length > 0 && (
                  <div className="space-y-1 mt-2">
                    {toolCalls.map((tc) => (
                      <ToolCallBlock
                        key={tc.id}
                        name={tc.name}
                        status={tc.status}
                        input={tc.args}
                        output={tc.result}
                        summary={tc.summary}
                        defaultCollapsed={!autoAcceptTools && tc.status !== "running"}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Branch navigation: show when message has siblings */}
        {siblingInfo && siblingInfo.total > 1 && onNavigatePrev && onNavigateNext && (
          <div className={`flex ${isUser ? "justify-end" : "justify-start"} -mt-0.5`}>
            <BranchNavigation
              currentIndex={siblingInfo.currentIndex}
              totalSiblings={siblingInfo.total}
              onPrevious={onNavigatePrev}
              onNext={onNavigateNext}
            />
          </div>
        )}

        {/* Consolidated metadata row: actions + token count + timestamp (hover-reveal) */}
        {!isStreaming && content && !isEditing && (
          <div className={`flex items-center gap-2 mt-0.5 transition-opacity focus-within:opacity-100 motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 ${isUser ? "justify-end" : "justify-start"}`}>
            <MessageActions
              content={content}
              role={role as "user" | "assistant"}
              onEdit={isUser ? onEdit : undefined}
              onRegenerate={onRegenerate}
              onAssistantAction={onAssistantAction}
              isLatestAssistant={isLatestAssistant}
              localCompletionTokens={localCompletionTokens}
              onFlagForEval={onFlagForEval}
              plainText={isCanonicalAnswer}
            />
            {showTechnicalDetails && !isUser && (tokenCount ?? 0) > 0 && !isStreaming && (
              <span className="text-[10px] text-[var(--eco-text-secondary)]">
                {tokenCount} tokens
              </span>
            )}
            {timestamp && (
              <span className="text-[10px] text-[var(--eco-text-secondary)]">
                {timeAgo(timestamp)}
              </span>
            )}
          </div>
        )}

        {/* Token rate during active streaming — only when technical details are enabled */}
        {showTechnicalDetails && isStreaming && !isUser && (tokenCount ?? 0) > 0 && (
          <TokenRate
            tokenCount={tokenCount ?? 0}
            streamStartTime={streamStartTime ?? null}
            isStreaming={isStreaming}
          />
        )}

        {status === "error" && (
          <ErrorMessage
            onRetry={onRetry}
            message={errorMessage}
            localReadiness={localReadiness}
            localPrepareState={localPrepareState}
            onPrepareLocalModel={onPrepareLocalModel}
          />
        )}

        {streamInterrupted && !isStreaming && onRetry && (
          <StreamInterrupted onRetry={onRetry} reason={interruptedReason} />
        )}

        {possiblyTruncated && !isStreaming && role === "assistant" && onAssistantAction && (
          <div className="mt-2 rounded-2xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-3 py-2 text-sm text-[var(--eco-text-secondary)]">
            This local reply may have reached its length limit.
            <button
              type="button"
              onClick={() => onAssistantAction("continue")}
              className="ml-2 font-medium text-[var(--eco-primary)] hover:underline"
            >
              Continue
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// Cold-load copy ladder. A cached cold load spends ~1s emitting byte progress
// then falls silent through a much longer WebGPU session-create, so a
// determinate bar would sit pinned at 100% and read as dishonest. Instead the
// label escalates on wall-clock time — each tier stays truthful about WHY the
// wait is happening (privacy → on-device) rather than inventing a percentage.
const LOADING_LABEL_TIER_1 = "Warming up Eco…";
const LOADING_LABEL_TIER_2 =
  "Still warming up — the first reply takes a moment because everything runs privately on your device.";
const LOADING_LABEL_TIER_3 =
  "Still working — the first warm-up can take a few minutes on some devices. After this, replies start much faster.";
const LOADING_LABEL_ALMOST_READY = "Almost ready — gathering the first words…";

const LOADING_TIER_2_MS = 9_000;
const LOADING_TIER_3_MS = 45_000;

function StreamingPrelude({ phase }: { phase?: StreamPhase }) {
  const resolvedPhase: StreamPhase =
    phase === "generating" || !phase ? "thinking" : phase;

  // The cold-load window owns its own time-aware sub-component (elapsed timer +
  // escalating copy + "almost ready" store signal). The warm paths below are
  // deliberately left as the original dots/label pill, untouched.
  if (resolvedPhase === "loading") {
    return <LoadingPrelude />;
  }

  // The thinking wait gets its own time-aware pill: dots-only for the common
  // sub-second case, one honest label once the wait is clearly a prefill.
  if (resolvedPhase === "thinking") {
    return <ThinkingPrelude />;
  }

  // Some phases carry an honest context label; queued stays dots-only.
  // - looking-up: a web lookup is running — name the web so the user knows their
  //   question is leaving the device (matters most for anything sensitive).
  // - tool-executing: on-device tool work (calculator/date/unit) is running.
  const label =
    resolvedPhase === "looking-up"
      ? "Looking this up on the web…"
      : resolvedPhase === "tool-executing"
        ? "Working with tools"
        : null;

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--eco-border)]/70 bg-[var(--eco-surface-elevated)]/75 px-3 py-2 text-sm text-[var(--eco-text-secondary)] shadow-sm">
      <StreamingCursor phase={resolvedPhase} />
      {label && <span>{label}</span>}
    </div>
  );
}

// Thinking-wait label. Most thinking waits end in well under a second, so the
// dots stay label-free by default. Past this threshold the wait is almost
// always a full-history prefill — on a KV-reuse miss the model re-reads every
// prior token before its first word, the 5–8s-class pause long conversations
// hit each time the context window evicts. The copy names what the model is
// actually doing (same honesty rule as the cold-load ladder: explain the WHY,
// never invent progress).
const THINKING_LABEL = "Reading over the conversation…";
const THINKING_LABEL_MS = 4_000;

/**
 * The warm "thinking" pill. Breathing dots from mount; after
 * `THINKING_LABEL_MS` the honest prefill label fades in beside them (instant
 * under reduced motion). The label lives in an `aria-live="polite"` region so
 * its appearance is announced once. The component only mounts while the phase
 * is "thinking", so unmount clears the timer — no leaked timeout, fresh
 * threshold on the next turn.
 */
function ThinkingPrelude() {
  const shouldReduce = useReducedMotion();
  const [showLabel, setShowLabel] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShowLabel(true), THINKING_LABEL_MS);
    return () => clearTimeout(id);
  }, []);

  return (
    <div
      data-testid="thinking-prelude"
      className="inline-flex items-center gap-2 rounded-full border border-[var(--eco-border)]/70 bg-[var(--eco-surface-elevated)]/75 px-3 py-2 text-sm text-[var(--eco-text-secondary)] shadow-sm"
    >
      <StreamingCursor phase="thinking" />
      <span aria-live="polite" className="min-w-0">
        <AnimatePresence initial={false}>
          {showLabel && (
            <motion.span
              className="block"
              initial={shouldReduce ? false : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={getTransition("gentle", shouldReduce)}
            >
              {THINKING_LABEL}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </div>
  );
}

/**
 * The cold-load "warming up" affordance. Keeps the breathing botanical seed
 * throughout and escalates its copy as the wait grows — no progress bar, no
 * percentage (measured: byte progress is misleading on a cached cold load). One
 * honest lifecycle signal, `loadAlmostReady` (set on the runtime's `load-finish`
 * event = compile done, generation starting), overrides the time tiers.
 *
 * The pill grows from a one-line chip into a soft rounded multi-line card as the
 * copy lengthens, capped to a mobile-safe width. The label lives in an
 * `aria-live="polite"` region so each escalation is announced once; the seed
 * stays decorative. Elapsed tracking runs regardless of reduced motion (it
 * drives copy, not motion); the label crossfade collapses to instant when
 * reduced motion is requested.
 */
function LoadingPrelude() {
  // Deliberate leaf-level store read: subscribing here (rather than prop-drilling
  // loadAlmostReady down through four render layers) keeps the signal local to
  // the one component that consumes it.
  const loadAlmostReady = useChatStore((s) => s.loadAlmostReady);
  const shouldReduce = useReducedMotion();

  // 1s tick driving the copy ladder. The component only mounts while the phase
  // is "loading", so unmount (phase leaves loading) clears the interval and
  // resets elapsed — no leaked timers, no stale elapsed on the next cold load.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1_000);
    return () => clearInterval(id);
  }, []);

  const tier: "almost-ready" | "tier-3" | "tier-2" | "tier-1" = loadAlmostReady
    ? "almost-ready"
    : elapsedMs >= LOADING_TIER_3_MS
      ? "tier-3"
      : elapsedMs >= LOADING_TIER_2_MS
        ? "tier-2"
        : "tier-1";

  const label =
    tier === "almost-ready"
      ? LOADING_LABEL_ALMOST_READY
      : tier === "tier-3"
        ? LOADING_LABEL_TIER_3
        : tier === "tier-2"
          ? LOADING_LABEL_TIER_2
          : LOADING_LABEL_TIER_1;

  return (
    <div
      data-testid="loading-prelude"
      className="inline-flex max-w-[min(20rem,calc(100vw_-_2rem))] items-start gap-2 rounded-lg border border-[var(--eco-border)]/70 bg-[var(--eco-surface-elevated)]/75 px-3.5 py-2.5 text-sm text-[var(--eco-text-secondary)] shadow-sm"
    >
      {/* Fixed-height box so the seed optically centers on the first text line
          even when the copy wraps to several lines. */}
      <span className="flex h-5 shrink-0 items-center">
        <StreamingCursor phase="loading" />
      </span>
      <span aria-live="polite" className="min-w-0 leading-relaxed">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={tier}
            className="block"
            initial={shouldReduce ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={shouldReduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
            transition={getTransition("gentle", shouldReduce)}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  );
}
