// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { getModel } from "../local-ai/catalog/catalog";
import { isLocalAiSlot } from "../local-ai/util";
import { getSlotForModel } from "../local-ai/lifecycle/slots";
import type { SlotStatus } from "../local-ai/lifecycle/slots";
import type { SlotState } from "../local-ai/lifecycle/slots";

export type LocalReadinessSlotLabel =
  | "Eco"
  | "this local model";

export type LocalReadinessStatus =
  | "not-downloaded"
  | "partial"
  | "downloaded-needs-test";

export function getLocalReadinessSlotLabel(
  selection: string,
  modelId: string,
): LocalReadinessSlotLabel {
  // One identity: both on-device slots present to the user as "Eco". The
  // internal eco-fast / eco-smart split is never surfaced in copy.
  if (selection === "eco-fast" || selection === "eco-smart") return "Eco";

  const slot = getSlotForModel(modelId);
  if (slot === "eco-fast" || slot === "eco-smart") return "Eco";

  return "this local model";
}

export function buildLocalReadinessFailure({
  selectedModelChoice,
  model,
  lifecycleStatus,
}: {
  selectedModelChoice: string;
  model: string;
  lifecycleStatus: SlotStatus | 'not-ready' | 'partial' | 'downloaded-needs-test' | 'unavailable' | 'checking' | 'downloading' | 'cancelled';
}): {
  message: string;
  modelName: string;
  slotLabel: LocalReadinessSlotLabel;
  readinessStatus: LocalReadinessStatus;
  slotId?: "eco-fast" | "eco-smart";
} {
  const slotLabel = getLocalReadinessSlotLabel(selectedModelChoice, model);
  const localModel = getModel(model);
  const modelName = localModel
    ? localModel.friendlyName
    : model;
  const message =
    lifecycleStatus === "partial"
      ? `${slotLabel} is only partly downloaded. Resume preparation in Manage Models before sending this locally.`
      : lifecycleStatus === "downloaded-needs-test"
        ? `${slotLabel} is downloaded but still needs a quick readiness check before Eco can answer. Manage Models can test it.`
        : `${slotLabel} needs preparation before Eco can answer locally. Manage Models can download it and run the readiness check.`;
  const readinessStatus =
    lifecycleStatus === "partial" || lifecycleStatus === "downloaded-needs-test"
      ? lifecycleStatus
      : "not-downloaded";
  const slotId = isLocalAiSlot(selectedModelChoice)
    ? selectedModelChoice
    : getSlotForModel(model) ?? undefined;

  return {
    message,
    modelName,
    slotLabel,
    readinessStatus,
    ...(slotId && { slotId }),
  };
}

/**
 * V2 — local-AI v1.0 path.
 *
 * Same return shape as `buildLocalReadinessFailure` so the caller's
 * `updateMessage(... localReadiness: ...)` block is unchanged. The two
 * differences vs the legacy builder:
 *
 *   1. Uses the new `SlotState` from `local-ai/lifecycle/slots` instead of
 *      the legacy file-presence ledger. A slot is `ready` only after the
 *      smoke pipeline has signed off, so the readiness bar is strictly
 *      higher.
 *
 *   2. Honors Invariant 10 (no technical IDs in user copy): renders
 *      `modelName` from `ModelConfig.friendlyName`, not the technical id.
 *
 * Caller contract: only invoke when `slot.status !== 'ready'`. A 'ready'
 * slot is the happy path and shouldn't reach this builder.
 */
export function buildLocalReadinessFailureV2({
  slot,
}: {
  slot: SlotState;
}): {
  message: string;
  modelName: string;
  slotLabel: LocalReadinessSlotLabel;
  readinessStatus: LocalReadinessStatus;
  slotId: "eco-fast" | "eco-smart";
} {
  // Unified identity — the internal slot never shows in user copy.
  const slotLabel: LocalReadinessSlotLabel = "Eco";

  const modelName = slot.model?.friendlyName ?? slotLabel;

  const readinessStatus: LocalReadinessStatus =
    slot.status === "preparing"
      ? "partial"
      : slot.status === "error"
        ? "downloaded-needs-test"
        : "not-downloaded";

  const message =
    slot.status === "preparing"
      ? `${slotLabel} is still preparing. Finish setup in Settings → Eco before sending this locally.`
      : slot.status === "error"
        ? `${slotLabel} hit a snag during its last readiness check. Re-run setup in Settings → Eco to recover.`
        : `${slotLabel} needs one-time setup before Eco can answer locally. Settings → Eco can download it and run the readiness check.`;

  return {
    message,
    modelName,
    slotLabel,
    readinessStatus,
    slotId: slot.slot,
  };
}

/**
 * Decide whether a slot flipping to 'ready' should invisibly retry the
 * conversation's last turn.
 *
 * A send blocked by readiness leaves the user's message answered only by an
 * error card. When the blocking slot later becomes ready — boot promotion,
 * the recovery card's driver, a Settings run — the person should get their
 * answer without being told to resend (no-excuse-UI). This picks the retry
 * target: the LAST message, only when it is a readiness-failure card for the
 * slot that just became ready. Anything after it (a newer turn, a streaming
 * reply) means the conversation moved on — never retry into that.
 *
 * Pure; structural message shape so callers can pass store messages directly.
 */
export function findAutoRetryTarget(
  messages: ReadonlyArray<{
    id: string;
    role: string;
    status?: string;
    localReadiness?: { slotId?: string } | null;
  }>,
  readySlot: "eco-fast" | "eco-smart",
): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  if (last.status !== "error" || !last.localReadiness) return null;
  if (last.localReadiness.slotId && last.localReadiness.slotId !== readySlot) {
    return null;
  }
  return last.id;
}
