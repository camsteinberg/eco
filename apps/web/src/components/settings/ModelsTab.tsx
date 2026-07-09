// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { LocalAiSettingsAdapter } from '../local-ai/LocalAiSettingsAdapter'

/**
 * Settings → Models tab.
 *
 * LocalAiSettingsAdapter connects the SettingsEcoTab + SwitchAIDialog
 * to live local-ai/ state.
 */
export function ModelsTab() {
  return <LocalAiSettingsAdapter />
}
