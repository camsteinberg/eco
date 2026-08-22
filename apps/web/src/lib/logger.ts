// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Centralized application logger.
 *
 * A thin pass-through to the browser/node `console` in every environment.
 * The web app deliberately carries no error-reporting service (see the
 * privacy policy: on-device work never leaves the device, and the web app
 * itself sends no telemetry), so logs go only to the user's own console —
 * where they are visible and diagnosable, never transmitted.
 *
 * Kept as an indirection (rather than direct `console` calls) so call sites
 * stay uniform and any future opt-in reporting has a single seam.
 *
 * Usage mirrors `console`:
 *
 *   logger.warn("Failed to save draft:", err);
 *   logger.error("[boundary] render crashed", error, info);
 *
 * Levels: error, warn, info, debug.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

export const logger = {
  error(message: unknown, ...args: unknown[]): void {
    console.error(message, ...args);
  },
  warn(message: unknown, ...args: unknown[]): void {
    console.warn(message, ...args);
  },
  info(message: unknown, ...args: unknown[]): void {
    console.info(message, ...args);
  },
  debug(message: unknown, ...args: unknown[]): void {
    console.debug(message, ...args);
  },
} as const;
