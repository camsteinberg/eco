// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Prompt assembly — the ONE place a prompt is composed.
 *
 * `assemble()` is pure: no store reads, no React, no I/O. Everything it needs
 * arrives as arguments, so the same function serves every dispatch path
 * (send / edit / regenerate / retry / offline-continue) and the eval harness.
 * Before this module those were five-plus separate compositions inside
 * `useChat`, and "the harness measures what production sends" was an assertion
 * rather than a fact.
 *
 * The shape is the reference-system consensus — chat template + one system
 * prompt + the messages — plus the two mechanisms Eco keeps on top of it:
 * fact recaps appended to user turns, and a host tool note joined onto the
 * system prompt for the single generation that used a tool.
 *
 * ── Ordering is load-bearing ────────────────────────────────────────────────
 * The step order in `assemble()` is not stylistic. Read the comments inline
 * before reordering anything; two of them record measurements.
 *
 * ── Not yet true here ───────────────────────────────────────────────────────
 * The target architecture (D1 item 4) says "nothing varies by intent". It still
 * does: `resolveOptions` classifies the turn and resolves per-intent sampling,
 * exactly as dispatch did before this module existed. Collapsing that to one
 * publisher row per model is deferred to Phase M, because no instrument exists
 * yet to judge the change on the ten shipping models. This module makes the
 * variation visible in one function instead of spread across a hook; it does
 * not endorse it.
 */

import { inferAnswerShape, type AnswerShape } from '../../lib/answer-shape';
import {
  getGenerationProfile,
  inferTurnIntent,
  type ChatIntent,
} from '../../lib/chat-intent';
import { appendBranchRecaps, type BranchRecaps } from '../../lib/detail-recap';
import { getOnDeviceSystemPrompt } from '../../lib/system-prompt';
import { resolveSelectedModelId } from '../util';

export type PromptRole = 'user' | 'assistant' | 'system';
export type PromptMessage = { role: PromptRole; content: string };

/**
 * Generation options in the shape the legacy inference seam takes. R4b moves
 * the seam to `AsyncIterable<TokenEvent>`; the wire names stay snake_case until
 * then so this slice changes no bytes.
 */
export type PromptOptions = {
  max_new_tokens: number;
  temperature: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  no_repeat_ngram_size?: number;
  continueFinalMessage?: true;
};

export type AssembleInput = {
  /** Concrete catalog id or a slot name — slot names resolve internally. */
  modelId: string;
  /** The conversation turns, already windowed by the caller. */
  messages: ReadonlyArray<PromptMessage>;
  /**
   * Each user turn's figure and detail recaps, by user-turn ordinal, derived by
   * the caller from the FULL branch. Required rather than optional on purpose:
   * an optional one silently no-ops, which is exactly how derived context has
   * gone unwired here before.
   */
  branchRecaps: BranchRecaps;
  /** The user's custom instructions, verbatim. Empty string when unset. */
  customInstructions: string;
  /**
   * A fully-composed base system prompt that replaces identity + custom
   * instructions. The eval harness uses it to measure prompt arms; dispatch
   * leaves it unset.
   */
  systemPrompt?: string;
  /**
   * Model-facing directive appended to the END of the final user turn for THIS
   * generation. The END placement keeps the directive visible to the model as
   * the last instruction in the user turn.
   */
  turnDirective?: string;
  /**
   * Intent to resolve generation options with, in place of the one classified
   * from the turn text. Substituted at the OPTIONS-RESOLUTION layer only — the
   * classifiers (`inferTurnIntent` / `inferAnswerShape`) keep their
   * strict-prefix purity contract: pure functions of (turn text, hasPriorTurns),
   * never handed a caller's preference.
   */
  intent?: ChatIntent;
  /**
   * A host tool's note for the model, joined onto the system prompt for this
   * single generation. The displayed tool result stays authoritative regardless
   * of the prose the model writes around it.
   */
  toolSystemNote?: string;
  /**
   * Partial assistant text to resume. Present only on the offline-continue
   * path; it becomes a trailing assistant turn and switches the runtime into
   * continue-final-message mode.
   */
  partialAssistantContent?: string;
  /** Diagnostics only: let eval-candidate metadata resolve context/sampling. */
  allowValidationModel?: boolean;
};

export type AssembledPrompt = {
  /** The intent sampling was resolved with (receipts report this same value). */
  turnIntent: ChatIntent;
  /** Shape of the latest turn (receipt observability; ⊥ task class). */
  turnShape: AnswerShape;
  /** The system prompt as sent, tool note included. */
  systemPrompt: string;
  /**
   * The conversation turns as the model will actually see them: directive
   * composed, then each user turn's recaps appended. Every rebuild path reads
   * THIS, never the raw input, so a re-render can never drift from what was
   * sent. (Named `hintedMessages` until R4a; per-turn hints were deleted in R1.)
   */
  conversation: PromptMessage[];
  /** The full message list handed to the runtime: system + conversation (+ partial). */
  messages: PromptMessage[];
  options: PromptOptions;
};

/**
 * Build the base system prompt: Eco's on-device identity plus the user's
 * custom instructions.
 *
 * v1.0 web is on-device-only, so the prompt is kept minimal: identity + custom
 * instructions only. User memories are intentionally not injected — that path
 * was network-only and small on-device models can't follow it reliably.
 *
 * `modelId` may be a concrete catalog id or a slot name (`eco-fast` /
 * `eco-smart`); slots resolve to their bound model id, everything else passes
 * through, so both spellings yield the same prompt.
 */
export function buildSystemPrompt(modelId: string, customInstructions: string): string {
  const parts: string[] = [getOnDeviceSystemPrompt(resolveSelectedModelId(modelId))];
  if (customInstructions.trim()) parts.push(customInstructions.trim());
  return parts.join('\n\n');
}

/** Index of the last user turn, or -1. */
function lastUserIndex(messages: ReadonlyArray<{ role: string; content: string }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return i;
  }
  return -1;
}

/**
 * Classify the latest user turn.
 *
 * hasPriorTurns = any message precedes the latest user turn in the list.
 */
export function latestTurnIntent(
  messages: ReadonlyArray<{ role: string; content: string }>,
): ChatIntent {
  const index = lastUserIndex(messages);
  return inferTurnIntent(index >= 0 ? messages[index]!.content : '', index > 0);
}

/**
 * Append a model-facing directive to the END of the final user turn.
 *
 * Returns a NEW array carrying the directive on a COPY of the last user
 * message — the input list is never mutated, which is what keeps the directive
 * out of the stored conversation.
 *
 * No-op for an absent/blank directive, or a list with no user turn.
 */
export function appendTurnDirective(
  messages: ReadonlyArray<PromptMessage>,
  directive: string | undefined,
): PromptMessage[] {
  const trimmed = directive?.trim() ?? '';
  const next = [...messages];
  if (trimmed.length === 0) return next;
  const index = lastUserIndex(next);
  const target = index >= 0 ? next[index] : undefined;
  if (!target) return next;
  next[index] = { ...target, content: `${target.content}\n\n${trimmed}` };
  return next;
}

export type ResolveOptionsInput = {
  modelId: string;
  /** Turns to classify. Only `role` and `content` are read. */
  messages: ReadonlyArray<{ role: string; content: string }>;
  intent?: ChatIntent;
  continueFinalMessage?: boolean;
  allowValidationModel?: boolean;
};

/**
 * Resolve the sampling row and token budget for a turn.
 *
 * Shared with the context-divider and per-turn-reserve call sites so the budget
 * the UI draws is the budget dispatch will actually request — those recomputed
 * it independently before R4a.
 */
export function resolveOptions(input: ResolveOptionsInput): PromptOptions {
  const intent = input.intent ?? latestTurnIntent(input.messages);
  const profile = getGenerationProfile(intent, true, input.modelId, {
    allowValidationModel: input.allowValidationModel ?? false,
  });
  return {
    max_new_tokens: profile.maxTokens,
    temperature: profile.temperature,
    ...(profile.topP != null && { top_p: profile.topP }),
    ...(profile.topK != null && { top_k: profile.topK }),
    ...(profile.repetitionPenalty != null && { repetition_penalty: profile.repetitionPenalty }),
    ...(profile.noRepeatNgramSize != null && {
      no_repeat_ngram_size: profile.noRepeatNgramSize,
    }),
    ...(input.continueFinalMessage ? { continueFinalMessage: true as const } : {}),
  };
}

/**
 * Compose the prompt and the generation options for one turn.
 *
 * Pure. Same function for every dispatch path and for the eval harness.
 */
export function assemble(input: AssembleInput): AssembledPrompt {
  // Compose the directive onto the final user turn FIRST, so everything below
  // — classification and the shape receipt — sees the turn exactly as the
  // model will.
  const composed = appendTurnDirective(input.messages, input.turnDirective);

  // A forced intent substitutes for the classified one HERE, at the options
  // layer — the classifiers themselves are never told about it. Receipts
  // report this same value, so diagnostics describe the sampling actually run.
  const turnIntent = input.intent ?? latestTurnIntent(composed);

  // Receipt observability only.
  const index = lastUserIndex(composed);
  const turnShape = inferAnswerShape((index >= 0 ? composed[index]!.content : '').trim(), {
    hasPriorTurns: index > 0,
  });

  const baseSystemPrompt =
    input.systemPrompt ?? buildSystemPrompt(input.modelId, input.customInstructions);
  const systemPrompt = input.toolSystemNote
    ? [baseSystemPrompt, input.toolSystemNote].join('\n\n')
    : baseSystemPrompt;

  // Recaps go on LAST, after every decision the turn's own text makes.
  // Measured: classifying recapped text flips this corpus's budget turn from
  // `explain` to `deep`, which would resolve different sampling options —
  // so nothing above this line may ever see a recap.
  const conversation = appendBranchRecaps(composed, input.branchRecaps);

  // The partial reply becomes a trailing assistant turn so the runtime resumes
  // it rather than restarting. KV contract: history must re-render
  // byte-identically to how it was sent, which is why the partial is appended
  // to the SAME composed+recapped list rather than to the raw input.
  const partial = input.partialAssistantContent ?? '';
  const continueFinalMessage = partial.trim().length > 0;
  const messages: PromptMessage[] = [
    { role: 'system', content: systemPrompt },
    ...conversation,
    ...(continueFinalMessage ? [{ role: 'assistant' as const, content: partial }] : []),
  ];

  return {
    turnIntent,
    turnShape,
    systemPrompt,
    conversation,
    messages,
    options: resolveOptions({
      modelId: input.modelId,
      messages: composed,
      intent: turnIntent,
      continueFinalMessage,
      ...(input.allowValidationModel !== undefined
        ? { allowValidationModel: input.allowValidationModel }
        : {}),
    }),
  };
}
