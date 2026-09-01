// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Display-layer mapping for v1.0 catalog models.
 *
 * The branded copy itself is each catalog entry's `display` block — a model's
 * name to a person lives with the model, not in a second table that a new entry
 * can silently miss. This module is the boundary that reads it: it composes the
 * provenance line from the entry's own `sizeGB`, and falls back to raw metadata
 * for ids the catalog doesn't know.
 *
 * Branding is deliberately benefit-oriented per DESIGN-REFERENCE.md:84 ("Never
 * expose model names, VRAM, or token counts in primary UI"); the raw metadata
 * still appears behind the "Show technical details" disclosure for transparency
 * (AGPL). No catalog data is mutated.
 */

import type { ModelConfig, Slot } from './types';
import { getModel } from './catalog/catalog';
import { SLOTS, type SlotStatus } from './lifecycle/slots';
import { isLocalAiSlot } from './util';

export type DisplayInfo = {
  /** Branded friendly name: "Eco Balanced (Bonsai)" */
  friendlyName: string;
  /** One-line quality phrase: "Quickest replies · small footprint" */
  qualityPhrase: string;
  /** Tertiary provenance line: "Hugging Face · 1.0 GB" */
  provenance: string;
};

/**
 * Return branded display copy for a catalog model id. Falls back to the raw
 * `ModelConfig.friendlyName` + vendor when the id isn't in the catalog (future
 * models, eval-lane candidates, test fixtures) — catalog entries themselves
 * always carry a `display` block, which `assertCatalogEntry` pins at load.
 */
export function getDisplayInfo(
  modelId: string,
  fallback: { friendlyName: string; vendor: string; sizeGB: number },
): DisplayInfo {
  const entry = getModel(modelId)?.display;
  if (entry) {
    return {
      friendlyName: entry.friendlyName,
      qualityPhrase: entry.qualityPhrase,
      provenance: `${entry.provider} · ${fallback.sizeGB.toFixed(1)} GB`,
    };
  }
  return {
    friendlyName: fallback.friendlyName,
    qualityPhrase: '',
    provenance: `${fallback.vendor} · ${fallback.sizeGB.toFixed(1)} GB`,
  };
}

/**
 * Collapse models that render as the same branded name into one row.
 *
 * Several catalog entries are the SAME model in different builds — the f16 and
 * plain-int4 1.2B both brand as "Eco Fast (Liquid)" on purpose, because the
 * choice between them is a graphics-hardware detail, not a choice a person
 * should be asked to make. A device that can serve both therefore renders two
 * visually identical rows, which reads as a bug.
 *
 * `preferredIds` decides which build survives, in order — pass the selected id
 * first, then the recommended one, so the surviving row is the one the rest of
 * the UI is already talking about. Otherwise the first build in list order
 * wins. Group order follows first appearance, so the list does not reshuffle
 * when the selection changes.
 */
export function dedupeByDisplayName<T extends ModelConfig>(
  models: readonly T[],
  preferredIds: readonly (string | null | undefined)[] = [],
): T[] {
  // Map preserves insertion order, so grouping alone keeps first-appearance order.
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const { friendlyName } = getDisplayInfo(model.id, model);
    const group = groups.get(friendlyName);
    if (group) {
      group.push(model);
    } else {
      groups.set(friendlyName, [model]);
    }
  }

  const kept: T[] = [];
  for (const group of groups.values()) {
    const preferred = preferredIds
      .map((id) => group.find((model) => model.id === id))
      .find((model): model is T => model !== undefined);
    const winner = preferred ?? group[0];
    if (winner) kept.push(winner);
  }
  return kept;
}

/**
 * The model to present as "currently running": the one the chat's current
 * selection resolves to, matching how dispatch resolves a selection into a
 * slot. Only when the selection resolves to an empty slot does it fall back
 * fast-then-smart. A pure view over the slot snapshot — no storage reads —
 * so Settings can never out-vote the slot the chat actually uses (a stale
 * eco-fast binding out-named the serving eco-smart model live, 2026-08-05).
 */
export function resolveRunningModel(
  selectedModel: string,
  slots: Record<Slot, { model: ModelConfig | null; status: SlotStatus }>,
): { model: ModelConfig | null; status: SlotStatus | null } {
  const selectedSlot = isLocalAiSlot(selectedModel)
    ? selectedModel
    : SLOTS.find((slot) => slots[slot].model?.id === selectedModel) ?? null;
  if (selectedSlot && slots[selectedSlot].model) {
    return { model: slots[selectedSlot].model, status: slots[selectedSlot].status };
  }
  const fallback = SLOTS.find((slot) => slots[slot].model !== null) ?? null;
  if (fallback) {
    return { model: slots[fallback].model, status: slots[fallback].status };
  }
  return { model: null, status: null };
}
