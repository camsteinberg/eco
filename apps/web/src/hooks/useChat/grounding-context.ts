// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Derive the conversation's most recent grounded subject for tool match-context
 * (chat #7 W2.2). A pure scan over the chat message list — no store access — so
 * it is trivial to unit-test and cannot drift from live state.
 *
 * A follow-up like "how tall is it?" only makes sense relative to the subject the
 * prior turn grounded. The locked principle: a follow-up's antecedent is the SINGLE
 * most-recent grounded turn within the lookback window, REGARDLESS of which source
 * grounded it. So the scan stops at the first (most-recent) grounded turn and lets
 * that one citation's `source` decide the kind of antecedent. A later task feeds
 * the result into each tool's `match`.
 */

import type { ChatMessage } from "../../stores/chatStore";
import type { Citation } from "../../lib/citation-parser";
import type { ToolMatchContext } from "../../lib/tools";

/**
 * How far back to look for a grounded subject, in messages from the end. Pronoun
 * reference decays fast: by the time a grounded turn is this old, "it" almost
 * never still means that subject, and a stale antecedent would mis-ground a new
 * question more often than it helps. The bound is deliberately tight — better to
 * miss a long-range follow-up (it falls back to normal chat) than to confidently
 * ground the wrong thing.
 */
export const GROUNDED_TITLE_LOOKBACK = 6;

/**
 * Find the SINGLE most-recent grounded turn within the lookback window: the first
 * assistant message (scanning backward from the end) whose first citation has a
 * truthy `source`. Returns that citation, or `undefined` when none is recent
 * enough.
 *
 * Recency-correct by construction: it stops at the first grounded turn it sees, so
 * a more-recent non-Wikipedia citation is never skipped past to reach an older
 * Wikipedia one. The caller maps the citation's `source` to the right
 * `ToolMatchContext` field.
 *
 * Looks back at most {@link GROUNDED_TITLE_LOOKBACK} messages — see that constant
 * for the staleness rationale. The currently-streaming assistant message (typically
 * empty, no citations) does not interfere: it carries no citation, so it is skipped
 * naturally. Pass `excludeId` to skip a specific message outright (e.g. the
 * in-flight reply the caller is about to populate) without relying on its
 * empty-citation state.
 *
 * Pure: it reads only the array it is handed. Callers pass the already-sliced
 * active branch (edit/regenerate truncate the store to the active branch before
 * streaming), so a citation on a discarded later turn can never leak in.
 */
function findLastGroundedCitation(
  messages: readonly ChatMessage[],
  options?: { excludeId?: string },
): Citation | undefined {
  const excludeId = options?.excludeId;
  const start = messages.length - 1;
  // Inclusive lower bound: the window is the last GROUNDED_TITLE_LOOKBACK messages.
  const limit = Math.max(0, messages.length - GROUNDED_TITLE_LOOKBACK);

  for (let i = start; i >= limit; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    if (excludeId !== undefined && message.id === excludeId) continue;

    const citation = message.citations?.[0];
    // A truthy `source` is the grounded signal: the grounding path (#5 S3) writes a
    // single citation carrying it; ungrounded assistant turns have none. This is
    // the most-recent grounded turn — it decides the antecedent, whatever its
    // source. We do NOT keep scanning for a preferred source.
    if (citation?.source) {
      return citation;
    }
  }

  return undefined;
}

/**
 * Derive the {@link ToolMatchContext} for the next tool step from the single
 * most-recent grounded turn.
 *
 * Maps the most-recent grounded citation's `source` to an antecedent field:
 *  - `"Wikipedia"`   → `{ lastGroundedTitle }`   (factual pronoun follow-up)
 *  - any other / unknown source → `{}` (no antecedent — we do not guess)
 *  - no grounded turn in the window → `{}`
 *
 * The result is always a fresh object the caller can spread directly; an empty
 * `{}` lets the caller preserve its "omit matchContext when context-free" idiom.
 */
export function deriveGroundedMatchContext(
  messages: readonly ChatMessage[],
  options?: { excludeId?: string },
): ToolMatchContext {
  const citation = findLastGroundedCitation(messages, options);
  if (!citation) return {};

  switch (citation.source) {
    case "Wikipedia":
      return { lastGroundedTitle: citation.title };
    default:
      // Unknown/other source (e.g. Wikidata) — no antecedent. Don't guess which
      // tool it would belong to; a wrong antecedent mis-grounds more than it helps.
      return {};
  }
}
