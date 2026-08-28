// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useMemo, useState } from 'react';
import { canServe, listCatalog } from '../../local-ai/index';
import { dedupeByDisplayName } from '../../local-ai/display';
import { deriveFirstRunChoices } from '../../local-ai/selection/first-run-choices';
import { useDeviceProfile } from './useDeviceProfile';
import type { SwitchModelResult } from '../../local-ai/lifecycle/switch-model';
import type { ModelConfig, Slot } from '../../local-ai/types';

// Canonical result/reason/confidence types live with the switch primitive
// (lifecycle/switch-model). Re-exported here so dialog-side importers keep
// one stable path.
export type {
  FailedConfidence,
  SwitchFailureReason,
} from '../../local-ai/lifecycle/switch-model';

export type SwitchAIResult = SwitchModelResult;

/**
 * State container for the SwitchAIDialog.
 *
 * The dialog renders one calm list of every AI Eco can confidently run on
 * this device. `commit()` always binds the user's selected entry (falling
 * back to the recommendation when nothing is picked yet).
 *
 * The switch action is injected via `onSwitchRequested(modelId)` so the
 * dialog stays a pure controlled component.
 */

/**
 * Confidence source for a choice — exposed so the dialog can show a
 * subtle distinction (e.g. a "Recommended" tag on the top entry) if
 * desired. Not used to gate or warn — every choice surfaced has been
 * judged confident enough to offer.
 */
export type SwitchAIConfidence = 'benchmark' | 'calculated' | 'ledger';

export type SwitchAIChoice = {
  model: ModelConfig;
  confidence: SwitchAIConfidence;
  /** True for the top-ranked entry — the dialog marks it "Recommended for your device". */
  isTop: boolean;
};

export type UseSwitchAIOptions = {
  slot: Slot;
  /** Current model in this slot — the switch flow's rollback reference. */
  currentModel: ModelConfig | null;
  /** The model the chat's current selection resolves to. Used to initialize
   *  the radio selection so the prechecked row matches what "Currently
   *  running" says. Falls back to currentModel when absent. */
  runningModelId?: string | null;
  /**
   * Caller-provided commit action. Resolves with a result that the dialog
   * uses to either close (success) or surface an inline error with an
   * optional cascade suggestion (failure). In production wiring this
   * delegates to lifecycle + smoke + cascade.
   */
  onSwitchRequested(modelId: string): Promise<SwitchAIResult>;
};

export type UseSwitchAIReturn = {
  /** The recommended model for this slot/profile/intent. */
  recommendation: ModelConfig | null;

  /** Flat ranked list of choices rendered as the single calm list. */
  choices: SwitchAIChoice[];

  /** The currently-selected pick in the list. */
  selectedId: string | null;
  select(modelId: string): void;

  /** Commit the selection. Resolves with the result; never throws. */
  commit(): Promise<SwitchAIResult>;

  /**
   * Commit a specific model id directly, bypassing the radio's current
   * selection. The dialog uses this to retry a cascade-suggested model
   * after a smoke failure ("Try Qwen3?" button).
   */
  commitWith(modelId: string): Promise<SwitchAIResult>;

  /** True while a commit is in flight. */
  saving: boolean;
};

export function useSwitchAI(options: UseSwitchAIOptions): UseSwitchAIReturn {
  // Reactive device profile so the dialog's recommendation + runnable list
  // reflect the real adapter capability the instant the probe resolves, even
  // if the dialog opened mid-probe (the frozen useMemo never recomputed).
  const profile = useDeviceProfile();
  const cannotServe = useMemo(() => !canServe(profile), [profile]);

  // The recommended model follows the same single definition the welcome card
  // and composer use: `deriveFirstRunChoices`. On a capable device with a
  // two-model offer, the deeper pick is recommended (quality data, 2026-08-28);
  // on a constrained device it is the only available model.
  const recommendation = useMemo<ModelConfig | null>(() => {
    if (cannotServe) return null;
    try {
      const offer = deriveFirstRunChoices(options.slot, profile);
      const rec = offer.choices.find((c) => c.model.id === offer.recommendedId);
      return rec?.model ?? offer.choices[0]?.model ?? null;
    } catch {
      return null;
    }
  }, [cannotServe, profile, options.slot]);

  const choices = useMemo<SwitchAIChoice[]>(() => {
    if (cannotServe) return [];
    const { available } = listCatalog(profile, {
      currentlyBoundModelId: options.currentModel?.id ?? null,
    });
    const models = available.map((entry) => entry.model);
    const deduped = dedupeByDisplayName(models, [options.currentModel?.id]);
    const confidenceMap = new Map(available.map((e) => [e.model.id, e.confidence]));
    const recommendedId = recommendation?.id ?? null;
    return deduped.map((model) => ({
      model,
      confidence: confidenceMap.get(model.id) ?? 'calculated' as const,
      isTop: model.id === recommendedId,
    }));
  }, [cannotServe, profile, options.currentModel?.id, recommendation?.id]);

  // Precheck the model that "Currently running" displays, so an untouched
  // Save is a no-op rather than silently switching to the fast-first
  // reference model.
  const displayCurrentId = options.runningModelId ?? options.currentModel?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(
    displayCurrentId ?? recommendation?.id ?? null,
  );
  const [saving, setSaving] = useState(false);

  const select = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const commitWith = useCallback(async (modelId: string): Promise<SwitchAIResult> => {
    setSaving(true);
    try {
      const result = await options.onSwitchRequested(modelId);
      return result;
    } finally {
      setSaving(false);
    }
  }, [options]);

  const commit = useCallback(async (): Promise<SwitchAIResult> => {
    // The dialog is a single calm list: the user's pick (selectedId) is the
    // source of truth, falling back to the recommendation or current model
    // when nothing is selected yet.
    const target = selectedId ?? recommendation?.id ?? displayCurrentId ?? null;
    if (!target) {
      return {
        success: false,
        reason: 'unknown',
        failedModel: null,
        suggestedNext: null,
      };
    }
    return commitWith(target);
  }, [recommendation, selectedId, displayCurrentId, commitWith]);

  return {
    recommendation,
    choices,
    selectedId,
    select,
    commit,
    commitWith,
    saving,
  };
}
