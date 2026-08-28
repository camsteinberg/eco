// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Derive the conversation's most recent user-stated APR for tool match-context
 * (s20). A pure scan over the chat message list — no store access — so it is
 * trivial to unit-test and cannot drift from live state.
 *
 * The money tool's payoff op needs a rate, and people state the rate once ("my
 * card says 24% APR") and then ask the follow-up ("if I owe $600 and pay $100 a
 * month…"). Without this the follow-up falls back to the model, which is exactly
 * the turn the s19 sampling caught being ~12× wrong.
 */

import type { ChatMessage } from "../../stores/chatStore";
import type { ToolMatchContext } from "../../lib/tools";
import { extractAprPercent } from "../../lib/tools/money-tool";

/**
 * How far back to look for a stated APR, in messages from the end. Wider than the
 * grounded-subject window (a rate someone quoted is a durable fact about their
 * card, not a decaying pronoun antecedent) but still bounded, so a different card
 * discussed much earlier in a long conversation can't bleed into a new question.
 */
export const RECENT_APR_LOOKBACK = 12;

/**
 * Derive the {@link ToolMatchContext} APR hint from the most recent USER turn
 * that states one. Assistant turns are skipped deliberately — see
 * {@link ToolMatchContext.recentAprPercent}.
 *
 * Returns `{ recentAprPercent }` or `{}`; an empty object lets the caller keep its
 * "omit matchContext when context-free" idiom. Pass `excludeId` to skip a specific
 * message (e.g. the in-flight reply).
 */
export function deriveMoneyMatchContext(
  messages: readonly ChatMessage[],
  options?: { excludeId?: string },
): ToolMatchContext {
  const excludeId = options?.excludeId;
  const limit = Math.max(0, messages.length - RECENT_APR_LOOKBACK);

  for (let i = messages.length - 1; i >= limit; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (excludeId !== undefined && message.id === excludeId) continue;

    const apr = extractAprPercent(message.content);
    if (apr !== null) {
      return { recentAprPercent: apr };
    }
  }

  return {};
}
