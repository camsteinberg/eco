// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The opt-in device summary attached to a feedback submission.
 *
 * Shown to the person VERBATIM in the feedback dialog before sending — this
 * string is exactly what leaves the device, nothing more. Keep it plain
 * factual values (no free prose) so that promise stays checkable at a glance.
 */

import { getDeviceProfileSnapshot } from "../local-ai/device/profile";
import { resolveActiveModelId } from "./active-model";

export function buildFeedbackDeviceSummary(): string {
  const profile = getDeviceProfileSnapshot();

  let modelId = "unknown";
  try {
    modelId = resolveActiveModelId();
  } catch {
    // The chat store may not be hydrated on public pages; "unknown" is honest.
  }

  const parts = [
    `browser: ${profile.browserClass}`,
    `engine: ${profile.webgpuSupport}`,
    `memory: ${profile.deviceMemoryGB} GB`,
    profile.isMobile ? "mobile" : "desktop",
    `model: ${modelId}`,
  ];
  return parts.join(" · ");
}
