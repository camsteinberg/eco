// @ts-check
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Build a rules object that downgrades every `@typescript-eslint/*` error in
 * `baseConfig` to `"warn"`, preserving each rule's options tuple.
 *
 * The optional `ratcheted` set lets apps opt individual rules back to error —
 * any rule name in that set is skipped so it keeps its original severity.
 *
 * Usage (in an app eslint config):
 *
 *   import { stageStrictTypedAsWarnings } from '@eco/config/eslint/stage-strict-typed';
 *
 *   const RATCHETED = new Set([
 *     // Add rules here to promote back to error.
 *   ]);
 *   const staged = stageStrictTypedAsWarnings(myBaseConfig, { ratcheted: RATCHETED });
 *
 * @param {import("typescript-eslint").ConfigArray} baseConfig
 * @param {{ ratcheted?: Set<string> }} [options]
 * @returns {Record<string, unknown>}
 */
export function stageStrictTypedAsWarnings(baseConfig, { ratcheted = new Set() } = {}) {
  /** @type {Record<string, unknown>} */
  const result = {};

  for (const config of baseConfig) {
    for (const [rule, setting] of Object.entries(config.rules ?? {})) {
      if (!rule.startsWith("@typescript-eslint/")) continue;
      if (ratcheted.has(rule)) continue;

      const severity = Array.isArray(setting) ? setting[0] : setting;
      if (severity === "error" || severity === 2) {
        result[rule] = Array.isArray(setting)
          ? ["warn", ...setting.slice(1)]
          : "warn";
      }
    }
  }

  return result;
}
