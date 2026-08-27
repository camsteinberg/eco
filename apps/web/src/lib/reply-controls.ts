// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { getGenerationProfile } from "./chat-intent";
import type { ChatIntent } from "./chat-intent";

/**
 * The per-reply controls that re-run the SAME question with a different
 * treatment, rather than asking a new one. `continue` is deliberately not here:
 * continuing needs the partial reply in the history, so it stays a turn.
 */
export type ReplyRegenerateControl = "shorter" | "expand" | "simplify";

/** What one control asks the model for: an intent to sample by, and a directive. */
export type ReplyControlTreatment = {
  readonly intent: ChatIntent;
  readonly directive: string;
};

/**
 * ★ THE DIRECTIVE STRINGS ARE LOAD-BEARING. DO NOT REWORD THEM FOR TONE.
 *
 * A directive rides the END of the user turn for one generation. Whether the
 * per-intent hint is then appended AFTER it is decided by
 * `hasExplicitFormatInstruction` (answer-shape.ts) reading the directive's own
 * bytes — the same rule that applies to anything a person types. A directive
 * the detector does not recognise gets the hint appended after it, where the
 * hint wins by recency on a small model.
 *
 * For the two CLOSED-direction controls that is fatal: the hint they would
 * receive asks the model to develop the answer, which is the opposite of what
 * the user pressed. Both strings below are therefore chosen AGAINST the
 * detector, and both verdicts are pinned in
 * `apps/web/src/__tests__/reply-recovery-actions.test.ts`. The natural
 * rewordings — "Be concise.", "Shorter.", "Just the answer.", "Explain it in
 * plain, everyday language." on its own — all read as ordinary prose to the
 * detector and would silently restore the contradicting hint.
 *
 * `expand` is the exception, and knowingly so: its directive does NOT suppress
 * the hint, because no honest way to ask for MORE depth reads as a brevity or
 * format instruction. The hint that lands after it is derived from the turn's
 * own text and pulls the same direction on every model except Gemma-LiteRT,
 * where it is still a stop instruction — pinned as a live, narrowed defect.
 *
 * The user-facing LABEL and the model-facing DIRECTIVE are different strings.
 * Changing a menu label does not touch anything here.
 */
export const REPLY_CONTROL_TREATMENTS = {
  shorter: {
    intent: "quick",
    directive: "Keep it short. Lead with the answer itself.",
  },
  expand: {
    intent: "deep",
    directive:
      "Go deeper — cover what this is actually like in practice, not just the definition.",
  },
  simplify: {
    intent: "quick",
    directive: "Keep it simple. Explain it in plain, everyday language.",
  },
} as const satisfies Record<ReplyRegenerateControl, ReplyControlTreatment>;

/**
 * Floor, in completion tokens, below which "shorter" is a no-op.
 *
 * Roughly two short paragraphs. Under it there is no length left to remove:
 * a shorter regenerate can only drop content the user already has, so the
 * honest behaviour is to do nothing rather than to spend a generation making
 * a short answer worse.
 *
 * Measured against `ChatMessage.localCompletionTokens`, which useChat writes
 * on completion and which persists with the message (`db.ts` toDbMessage /
 * `conversationStore.ts` restore), so a restored reply is judged exactly like
 * a fresh one. The count is absent only for replies that never carried one
 * (older rows, non-local replies). Absent ⇒ allow the action: never block a
 * control on state we simply do not have.
 */
export const SHORTER_MIN_COMPLETION_TOKENS = 64;

/**
 * Can asking this model for more depth actually buy anything?
 *
 * Derived from the model's REAL generation profile, never a model list: the
 * open direction is only meaningful where a deep turn is allowed more room
 * than a quick one. On models whose ladder is flat, forcing `deep` moves
 * sampling and nothing else, so "expand" would be a promise the model cannot
 * keep. A new catalog entry is covered the day it lands.
 */
export function canDeepen(modelId: string): boolean {
  return (
    getGenerationProfile("quick", true, modelId).maxTokens
    < getGenerationProfile("deep", true, modelId).maxTokens
  );
}
