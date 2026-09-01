// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Presentation mapping for the first-run welcome card.
 *
 * The setup runner hands the gate the raw device-appropriate `ModelConfig`s to
 * offer (domain). This module turns each into the plain-language card copy a
 * casual user reads — short product name, honest size, one-sentence tagline,
 * and glanceable Speed/Depth meters. The curated copy is each catalog entry's
 * `display.welcome` block, so a new model's card ships with the model; a small
 * heuristic fallback keeps entries without curated copy presentable.
 */

import type { ModelConfig } from '../../local-ai/types';
import { getModel } from '../../local-ai/catalog/catalog';
import { getDisplayInfo } from '../../local-ai/display';
import type { WelcomeModelChoice } from './WelcomeCard';

/** "~0.8 GB" from a catalog sizeGB (one decimal, rounded). */
function sizeLabel(sizeGB: number): string {
  return `~${(Math.round(sizeGB * 10) / 10).toFixed(1)} GB`;
}

/** Map one offered model to its welcome-card copy. */
export function toWelcomeChoice(model: ModelConfig): WelcomeModelChoice {
  const curated = getModel(model.id)?.display?.welcome;
  if (curated) {
    return {
      id: model.id,
      name: curated.name,
      sizeLabel: sizeLabel(model.sizeGB),
      tagline: curated.tagline,
      speed: curated.speed,
      depth: curated.depth,
    };
  }

  // Fallback for a model without curated copy: derive a name from the display
  // map (dropping the "(Vendor)" suffix) and scale the meters by size.
  const info = getDisplayInfo(model.id, {
    friendlyName: model.friendlyName,
    vendor: model.vendor,
    sizeGB: model.sizeGB,
  });
  const name = info.friendlyName.replace(/\s*\([^)]*\)\s*$/, '');
  const small = model.sizeGB <= 0.9;
  const mid = model.sizeGB <= 1.4;
  return {
    id: model.id,
    name,
    sizeLabel: sizeLabel(model.sizeGB),
    tagline: info.qualityPhrase || 'Runs entirely on your device.',
    speed: small ? 4 : mid ? 3 : 2,
    depth: small ? 2 : mid ? 3 : 4,
  };
}

/** Map the offered models (best-first) to welcome-card choices. */
export function toWelcomeChoices(models: readonly ModelConfig[]): WelcomeModelChoice[] {
  return models.map(toWelcomeChoice);
}
