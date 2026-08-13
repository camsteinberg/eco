// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Presentation mapping for the first-run welcome card.
 *
 * The setup runner hands the gate the raw device-appropriate `ModelConfig`s to
 * offer (domain). This module turns each into the plain-language card copy a
 * casual user reads — short product name, honest size, one-sentence tagline,
 * and glanceable Speed/Depth meters. Curated per shipping model; a small
 * heuristic fallback keeps future/unmapped models presentable.
 *
 * Kept out of the domain layer on purpose: taglines and meters are UI copy, not
 * catalog facts.
 */

import type { ModelConfig } from '../../local-ai/types';
import { getDisplayInfo } from '../../local-ai/display';
import type { WelcomeModelChoice } from './WelcomeCard';

type Presentation = {
  /** Short product name for the card, no vendor suffix, e.g. "Eco Fast". */
  name: string;
  /** One plain sentence a casual user understands. */
  tagline: string;
  /** 1–4 filled dots: relative snappiness of replies. */
  speed: number;
  /** 1–4 filled dots: relative depth / thoroughness. */
  depth: number;
};

const PRESENTATION: Record<string, Presentation> = {
  'candidate/lfm2.5-1.2b-instruct-onnx': {
    name: 'Eco Fast',
    tagline: 'Smaller and faster. Good for everyday questions.',
    speed: 4,
    depth: 2,
  },
  // Plain-int4 build of the same 1.2B for older graphics hardware — same model,
  // same card copy.
  'candidate/lfm2.5-1.2b-instruct-q4-onnx': {
    name: 'Eco Fast',
    tagline: 'Smaller and faster. Good for everyday questions.',
    speed: 4,
    depth: 2,
  },
  'candidate/lfm2-2.6b-onnx': {
    name: 'Eco Deeper',
    tagline: 'Bigger and slower. Better at reasoning, math, and detail.',
    speed: 2,
    depth: 4,
  },
  'candidate/lfm2.5-350m-onnx': {
    name: 'Eco Light',
    tagline: 'Smallest and quickest. Best for older devices.',
    speed: 4,
    depth: 1,
  },
};

/** "~0.8 GB" from a catalog sizeGB (one decimal, rounded). */
function sizeLabel(sizeGB: number): string {
  return `~${(Math.round(sizeGB * 10) / 10).toFixed(1)} GB`;
}

/** Map one offered model to its welcome-card copy. */
export function toWelcomeChoice(model: ModelConfig): WelcomeModelChoice {
  const curated = PRESENTATION[model.id];
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
