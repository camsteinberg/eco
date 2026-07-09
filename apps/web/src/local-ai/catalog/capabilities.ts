// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Capabilities — per-model capability flags (intent fit, task fit, context).
 *
 * A thin passthrough to ModelConfig.capabilities. The data lives on the
 * catalog entry itself; this module exists as the named seam so that
 * selection / evidence consume capabilities through a stable surface
 * rather than reaching into the ModelConfig shape directly.
 */

import type { ModelConfig, Intent } from '../types';

export function getCapabilities(model: ModelConfig): {
  intent: Intent[];
  tasks: string[];
  contextTokens: number;
} {
  return {
    intent: [...model.capabilities.intent],
    tasks: [...model.capabilities.tasks],
    contextTokens: model.capabilities.contextTokens,
  };
}
