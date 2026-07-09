// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * System prompt suffix for v1 catalog models.
 *
 * Returns the catalog `systemDirective` for a model (model-specific behavioral
 * control), or null if the model has no directive. Appended to the lean
 * on-device system prompt.
 */

import { getModel } from '../catalog/catalog';

/**
 * Return the system-prompt suffix for a catalog model, or null for models
 * without one. Only returns the catalog systemDirective — no extra formatting
 * nudges (those caused content leakage on sub-2B models).
 */
export function getLocalModelSystemPromptSuffix(modelId: string): string | null {
  return getModel(modelId)?.systemDirective ?? null;
}
