// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Context-window resolution seam (Wave 3 scaffolding).
 *
 * `resolveContextTokens(model, profile)` is the single, tested place that
 * decides the KV-cache window a model runs with on a given device. TODAY it
 * returns the model's fixed catalog `capabilities.contextTokens` unchanged on
 * every device — a behavior-neutral default that is byte-for-byte what the
 * runtime adapters already use.
 *
 * Wave 3b will scale the window to the device's VRAM here — a bigger adapter
 * (read from `profile.webgpuMaxBufferBytes`) earns a bigger window, capped at
 * BOTH the model's native maximum AND a measured latency-safe ceiling. Those
 * per-VRAM bands are intentionally NOT populated in the scaffolding: only 4GB
 * M1 Pro data exists today, and 4GB is latency-bound (6-8k prefills are
 * OOM-safe but unusably slow), so setting high-VRAM bands blind would violate
 * measure-first. The bands land once a 2nd device class is measured.
 *
 * When they do, the three runtime load sites that currently read
 * `model.capabilities.contextTokens` directly get their value from here
 * instead:
 *   - runtime/webllm-adapter.ts   → engine `contextWindowSize`
 *   - runtime/litert-adapter.ts   → engine `maxNumTokens`
 *   - runtime/webllm-cache-bridge.ts
 * That wiring threads the DeviceProfile through `load()` and is Wave 3b's
 * behavior change — deliberately out of scope for the neutral scaffolding.
 */

import type { DeviceProfile, ModelConfig } from '../types';

/**
 * The KV-cache context window (in tokens) to run `model` with on `profile`.
 *
 * Scaffolding default: the model's fixed catalog window, identical on every
 * device. `profile` is the seam Wave 3b modulates (per-VRAM bands); it is
 * unused today by design, so the resolved window equals
 * `model.capabilities.contextTokens` exactly.
 */
export function resolveContextTokens(model: ModelConfig, _profile: DeviceProfile): number {
  return model.capabilities.contextTokens;
}
