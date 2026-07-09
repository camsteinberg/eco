// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Captured-failure schema + builders — the failure-capture loop's pure core.
 *
 * When a real conversation produces a bad answer, the dev-gated "Flag for
 * eval" affordance turns it into a `CapturedFailure`: the prior turns, the
 * prompt that failed, the bad output, and (best-effort) the generation
 * receipt's forensics. Captures persist via `capture-store.ts`, replay as
 * multi-turn probes through the eval harness (`capturedFailureToPromptSpec`),
 * and the durable ones graduate into `felt-probes.ts` by PR — Cam's real
 * failing transcripts become the felt-eval set every Wave-2 change is judged
 * against, instead of proxy probes.
 *
 * Pure logic on purpose: no store/browser imports, so the whole module runs
 * in plain Vitest. The chat UI adapts its store messages to
 * `CaptureSourceMessage` at the call site.
 */

import type { ChatIntent } from '../../lib/chat-intent';
import { inferChatIntent } from '../../lib/chat-intent';
import type { GenerationReceipt } from '../lifecycle/generation-receipt';
import type { EvalHistoryTurn, EvalPromptSpec } from './types';

// ─── Schema ────────────────────────────────────────────────────────────────

export const CAPTURE_SCHEMA_VERSION = 1;

/**
 * Total chars of prior history kept (oldest turns dropped first). Production
 * context is 4096 tokens — history beyond ~16k chars cannot influence the
 * failing generation anyway, and the bound keeps localStorage usage sane.
 */
export const HISTORY_CHAR_BUDGET = 16_000;

/** Cap on the failing-output excerpt (≈2048 tokens — the largest budget we grant). */
export const OUTPUT_CHAR_CAP = 8_000;

export const FAILURE_TAGS = [
  'hallucination',
  'formatting',
  'depth',
  'instructions',
  'other',
] as const;
export type FailureTag = (typeof FAILURE_TAGS)[number];

/** The receipt fields worth persisting for forensics (a snapshot, not a live ref). */
export type CapturedReceipt = {
  templateName: string | null;
  systemPromptHash: string;
  samplingProfile: GenerationReceipt['samplingProfile'];
  promptTokens: number;
  completionTokens: number;
  status: GenerationReceipt['status'];
};

export type CapturedCitation = { title: string; url: string; source?: string };

export type CapturedFailure = {
  schemaVersion: 1;
  /** `cap-…` — doubles as the harness promptId (stable join to run results). */
  captureId: string;
  /** ISO timestamp. */
  capturedAt: string;
  tags: FailureTag[];
  note: string;
  /** Prior turns replayed before `prompt` (bounded, user-first). */
  history: EvalHistoryTurn[];
  historyTruncated: boolean;
  /** The user turn that produced the failure. */
  prompt: string;
  /** The assistant reply that failed (capped). */
  failingOutput: string;
  /** Provenance from the receipt — forensic metadata, NOT a run constraint. */
  modelId: string | null;
  intent: ChatIntent | null;
  receipt: CapturedReceipt | null;
  citations: CapturedCitation[];
};

/** Structural subset of chatStore's ChatMessage — keeps this module store-free. */
export type CaptureSourceMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: { title: string; url: string; source?: string }[];
};

export type BuildCaptureInput = {
  messages: CaptureSourceMessage[];
  failingMessageId: string;
  tags: FailureTag[];
  note: string;
  /** Best-effort: in-memory receipts are gone after a reload. */
  receipt: GenerationReceipt | null;
  now?: () => number;
  generateId?: () => string;
};

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Local, typed list so an unknown string from a persisted receipt can never
 * smuggle itself into the ChatIntent union.
 */
const KNOWN_INTENTS: readonly ChatIntent[] = [
  'quick',
  'explain',
  'deep',
  'code',
  'writing',
  'file',
  'research',
];

function toChatIntent(value: string | undefined): ChatIntent | null {
  return (KNOWN_INTENTS as readonly string[]).includes(value ?? '')
    ? (value as ChatIntent)
    : null;
}

function defaultGenerateCaptureId(): string {
  return `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function snapshotReceipt(receipt: GenerationReceipt): CapturedReceipt {
  return {
    templateName: receipt.templateName,
    systemPromptHash: receipt.systemPromptHash,
    samplingProfile: { ...receipt.samplingProfile },
    promptTokens: receipt.promptTokens,
    completionTokens: receipt.completionTokens,
    status: receipt.status,
  };
}

/**
 * Bound history to the char budget by dropping oldest turns first, then drop
 * any leading assistant turns so the remainder stays user-first (strict
 * alternation templates — Gemma-class — reject assistant-first history).
 */
function boundHistory(turns: EvalHistoryTurn[]): { history: EvalHistoryTurn[]; truncated: boolean } {
  let total = turns.reduce((sum, t) => sum + t.content.length, 0);
  let start = 0;
  while (start < turns.length && total > HISTORY_CHAR_BUDGET) {
    total -= turns[start]!.content.length;
    start++;
  }
  let truncated = start > 0;
  while (start < turns.length && turns[start]!.role === 'assistant') {
    start++;
    truncated = true;
  }
  return { history: turns.slice(start), truncated };
}

// ─── Builders ──────────────────────────────────────────────────────────────

/**
 * Slice a conversation into a `CapturedFailure` around the flagged assistant
 * message. Returns `null` when the flag target can't form a valid capture
 * (missing, not an assistant turn, empty, or no preceding user prompt).
 */
export function buildCapturedFailure(input: BuildCaptureInput): CapturedFailure | null {
  const { messages, failingMessageId, tags, note, receipt } = input;
  const now = input.now ?? Date.now;
  const generateId = input.generateId ?? defaultGenerateCaptureId;

  const failingIndex = messages.findIndex((m) => m.id === failingMessageId);
  if (failingIndex === -1) return null;
  const failing = messages[failingIndex]!;
  if (failing.role !== 'assistant' || failing.content.trim().length === 0) return null;

  // The nearest preceding user turn is the failing prompt.
  let promptIndex = -1;
  for (let i = failingIndex - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex === -1) return null;
  const prompt = messages[promptIndex]!.content;

  // History = user/assistant turns before the prompt, non-empty only.
  const rawHistory: EvalHistoryTurn[] = [];
  for (let i = 0; i < promptIndex; i++) {
    const m = messages[i]!;
    if (m.role === 'system') continue;
    if (m.content.trim().length === 0) continue;
    rawHistory.push({ role: m.role, content: m.content });
  }
  const { history, truncated } = boundHistory(rawHistory);

  const failingOutput =
    failing.content.length > OUTPUT_CHAR_CAP
      ? `${failing.content.slice(0, OUTPUT_CHAR_CAP)}…`
      : failing.content;

  const citations: CapturedCitation[] = (failing.citations ?? []).slice(0, 3).map((c) => ({
    title: c.title,
    url: c.url,
    ...(c.source !== undefined ? { source: c.source } : {}),
  }));

  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    captureId: generateId(),
    capturedAt: new Date(now()).toISOString(),
    tags: [...tags],
    note,
    history,
    historyTruncated: truncated,
    prompt,
    failingOutput,
    modelId: receipt?.modelId ?? null,
    intent: toChatIntent(receipt?.samplingProfile.intent),
    receipt: receipt ? snapshotReceipt(receipt) : null,
    citations,
  };
}

/**
 * Convert a capture into a runnable multi-turn probe.
 *
 * Deliberately carries NO automated expectations: the always-computed rubric
 * dims (repetition, leakage) still apply, and the judge dims carry quality.
 * Auto-deriving e.g. `expectDecline` from a hallucination tag would bake in
 * the wrong fix — the right behavior may be ground-and-answer, not decline.
 * Intent prefers the capture's production-true provenance; the fallback runs
 * the same classifier production routing uses.
 */
export function capturedFailureToPromptSpec(capture: CapturedFailure): EvalPromptSpec {
  return {
    id: capture.captureId,
    category: 'captured',
    // Fallback mirrors production per-turn classification, including thread
    // context (captures with history are mid-conversation turns — the shape
    // classifier's follow-up guard needs to see that).
    intent:
      capture.intent
      ?? inferChatIntent(capture.prompt, { hasPriorTurns: capture.history.length > 0 }),
    prompt: capture.prompt,
    ...(capture.history.length > 0 ? { history: capture.history } : {}),
    judge: ['coherence', 'taskFit'],
    notes:
      `Captured failure (${capture.tags.join(', ')})` +
      (capture.note ? `: ${capture.note}` : '') +
      `. Model at capture: ${capture.modelId ?? 'unknown'}; captured ${capture.capturedAt}.`,
  };
}
