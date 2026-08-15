// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Shared utilities for the local-ai module. Intentionally narrow — only
 * helpers that need to live outside specific subdirectories belong here.
 */

import type { Slot } from './types';
import { getModel } from './catalog/catalog';
import { getEvalCandidateModel } from './eval/eval-candidates';
import { getSlot } from './lifecycle/slots';

const LOCAL_AI_SLOTS: ReadonlySet<string> = new Set<string>(['eco-fast', 'eco-smart']);

/**
 * Returns true when `modelId` refers to an on-device model.
 *
 * Semantic match for the legacy `isLocalModel` from `lib/local-models.ts`:
 *   - Slot names (`eco-fast`, `eco-smart`)
 *   - Concrete catalog ids in the legacy `LOCAL_MODELS` registry, all of
 *     which use the `local/` or `candidate/` prefix. (The v1 catalog
 *     subsets this; we use prefix matching to also cover model ids that
 *     exist in the legacy registry but have not been promoted into v1
 *     yet — e.g., `local/smollm3-3b`.)
 */
export function isLocalAiModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  if (LOCAL_AI_SLOTS.has(modelId)) return true;
  return modelId.startsWith('local/') || modelId.startsWith('candidate/');
}

/** Type guard narrowing a string to the `Slot` union. */
export function isLocalAiSlot(value: string | null | undefined): value is Slot {
  return !!value && LOCAL_AI_SLOTS.has(value);
}

/**
 * Resolve a model *choice* — a slot key (`eco-fast` / `eco-smart`) or a
 * concrete model id — to a concrete model id. A slot resolves to its bound
 * model id; if the slot is empty (no model bound) the choice passes through
 * unchanged, as does any non-slot value.
 */
export function resolveSelectedModelId(choice: string): string {
  return isLocalAiSlot(choice) ? (getSlot(choice).model?.id ?? choice) : choice;
}

/**
 * Conservative context-window fallback for ids the catalog doesn't know
 * (network models, legacy ids, slot names that haven't been resolved yet).
 * The per-model value is `capabilities.contextTokens` in `catalog-data.json`
 * — the single source of truth for context length. Raising a model's window
 * means editing its catalog entry, backed by real-WebGPU memory-headroom
 * evidence for that model; nothing else declares a context length.
 */
export const DEFAULT_CONTEXT_TOKENS = 4096;

export type ContextTokenLookupOptions = {
  /** Diagnostics/validation-only: allow non-shipping eval candidates. */
  allowValidationModel?: boolean;
};

/**
 * Look up the context-token window for a v1 catalog model, falling back to
 * `DEFAULT_CONTEXT_TOKENS` for non-catalog ids. Diagnostics callers may opt into
 * eval-candidate metadata without exposing those models to the shipping catalog.
 */
export function getContextTokens(
  modelId: string,
  fallback: number = DEFAULT_CONTEXT_TOKENS,
  options: ContextTokenLookupOptions = {},
): number {
  const model = getModel(modelId);
  if (model) return model.capabilities.contextTokens;

  if (options.allowValidationModel) {
    const candidate = getEvalCandidateModel(modelId);
    if (candidate) return candidate.capabilities.contextTokens;
  }

  return fallback;
}

// ─── Task intent inference ────────────────────────────────────────────────

/**
 * Union of task intents the recommendation engine and route snapshot use.
 * Matches the legacy `LocalModelIntentFit` from `lib/local-models.ts` and
 * the inline union in `ChatRouteRecommendationSnapshot.taskIntent`.
 */
export type TaskIntent =
  | 'quick'
  | 'explain'
  | 'deep'
  | 'code'
  | 'writing'
  | 'file'
  | 'research';

// ─── Narrowed CODE_RE for the snapshot path ─────────────────────────────
// Keep in sync with lib/chat-intent.ts CODE_RE. See that file for the
// narrowing rationale and lib/__tests__/code-intent-routing.test.ts for
// the corpus that pins it.
//
// ASSEMBLED WITH `+`, NOT TEMPLATE INTERPOLATION — same Turbopack caveat
// as WRITING_RE in chat-intent.ts.
const CODE_UNAMBIGUOUS_SNAPSHOT =
  "stack trace|traceback|refactor|typescript|javascript|regexp?|regex|sql"
  + "|segfault|null pointer|syntax error|runtime error|compil(?:e|er)"
  + "|npm|yarn|pnpm|css|html"
  + "|git (?:commit|rebase|merge|branch|push|clone|stash)";
const CODE_AMBIGUOUS_SNAPSHOT =
  "debug|bug|test|function|component|api|class|method|variable|array|loop|import|react|python|query|hook";
const CODE_SIGNALS_SNAPSHOT =
  "code|coding|script|program|error|exception|endpoint|repo|python|react";
const CODE_RE_SNAPSHOT = new RegExp(
  "```"
  + "|\\b(?:" + CODE_UNAMBIGUOUS_SNAPSHOT + ")\\b"
  + "|\\b(?:" + CODE_SIGNALS_SNAPSHOT + ")\\b[^.?!]{0,45}?\\b(?:" + CODE_AMBIGUOUS_SNAPSHOT + ")\\b"
  + "|\\b(?:" + CODE_AMBIGUOUS_SNAPSHOT + ")\\b[^.?!]{0,45}?\\b(?:" + CODE_SIGNALS_SNAPSHOT + ")\\b",
  "i",
);

/**
 * Infer the user's task intent from the prompt text. Pure function — no
 * side effects, no imports beyond what this file already has.
 *
 * Port of `inferLocalModelTaskIntent` from `lib/local-model-routing.ts`.
 *
 * ★ STALE DUPLICATE of `inferChatIntent` in `lib/chat-intent.ts`. The
 * canonical cascade is there; this copy serves only the route-snapshot
 * path. CODE_RE was narrowed identically (2026-08-15); RESEARCH_RE was
 * retired (same date). The remaining DEEP_RE / WRITING_RE copies here
 * are still the pre-narrowing versions — narrow them when next touched.
 */
export function inferTaskIntent(input: {
  prompt: string;
  hasFiles?: boolean;
  researchMode?: boolean;
}): TaskIntent {
  const text = input.prompt.trim();
  // RESEARCH_RE retired 2026-08-15 (see chat-intent.ts). Only the
  // explicit opt-in flag survives; no production caller sets it true.
  if (input.researchMode) {
    return 'research';
  }
  if (input.hasFiles || /<file\b/i.test(text)) return 'file';
  if (CODE_RE_SNAPSHOT.test(text)) {
    return 'code';
  }
  if (/\b(long|detailed|full|complete|comprehensive|step[- ]by[- ]step|in depth|thorough|analyze|compare|evaluate|strategy|plan|tradeoffs|pros and cons|deep|architecture)\b/i.test(text)) {
    return 'deep';
  }
  if (/\b(write|rewrite|draft|tone|copy|email|essay|story|post|message|headline|summarize in my voice|recipe|cook|bake|meal plan|ingredients?)\b/i.test(text)) {
    return 'writing';
  }
  if (/\b(explain|how does|why does|what is|teach me|walk me through)\b/i.test(text)) {
    return 'explain';
  }
  return text.length > 360 ? 'deep' : 'quick';
}
