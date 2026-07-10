// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Classify a raw worker-side generation failure message into an
 * `AdapterErrorCode`-shaped bucket. Kept separate from the worker entry so it
 * has plain unit coverage (the worker itself has no vitest harness — jsdom has
 * no Worker/WebGPU context).
 *
 * Matchers are conservative lowercased-substring checks. WebGPU/Dawn OOM
 * surfaces under several phrasings — a bare "out of memory", the runtime's
 * "oom", and Dawn's allocation wording ("Failed to allocate memory for buffer
 * mapping") — so allocation-failure phrasings map to 'oom' too. We deliberately
 * do NOT match a bare "buffer mapping": it appears in benign mapping logs that
 * are not OOM, and over-matching would trigger a false cooldown + unload.
 */
export function classifyGenerationError(
  message: string,
): 'oom' | 'device-lost' | 'generation-failed' {
  const m = message.toLowerCase();
  if (
    m.includes('out of memory') ||
    m.includes('oom') ||
    m.includes('failed to allocate') ||
    m.includes('allocation failed')
  ) {
    return 'oom';
  }
  if (m.includes('device') && m.includes('lost')) {
    return 'device-lost';
  }
  return 'generation-failed';
}
