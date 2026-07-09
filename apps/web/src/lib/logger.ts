// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Centralized application logger.
 *
 * In development and test environments this is a thin pass-through to the
 * browser/node `console`, so existing behavior (and console-spy tests) is
 * preserved exactly. In production it records structured Sentry breadcrumbs
 * instead of writing to the console, and additionally captures any `Error`
 * passed to `logger.error` as a Sentry exception.
 *
 * Usage mirrors `console`:
 *
 *   logger.warn("Failed to save draft:", err);
 *   logger.error("[boundary] render crashed", error, info);
 *
 * Levels: error, warn, info, debug.
 */

import * as Sentry from "@sentry/nextjs";

export type LogLevel = "error" | "warn" | "info" | "debug";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** Map our level names onto Sentry's `SeverityLevel` enum. */
function toSentryLevel(level: LogLevel): Sentry.SeverityLevel {
  switch (level) {
    case "warn":
      return "warning";
    case "error":
      return "error";
    case "info":
      return "info";
    case "debug":
      return "debug";
  }
}

function findError(args: unknown[]): Error | undefined {
  return args.find((arg): arg is Error => arg instanceof Error);
}

function record(level: LogLevel, message: unknown, args: unknown[]): void {
  if (!IS_PRODUCTION) {
    // Dev/test: identical to a direct console call so control flow and
    // test spies on `console.*` keep working.
    console[level](message, ...args);
    return;
  }

  // Production: structured breadcrumb instead of console output.
  Sentry.addBreadcrumb({
    category: "app",
    level: toSentryLevel(level),
    message: typeof message === "string" ? message : String(message),
    data: args.length > 0 ? { args } : undefined,
  });

  // Surface real errors logged at error level as captured exceptions.
  if (level === "error") {
    const error = findError([message, ...args]);
    if (error) {
      Sentry.captureException(error);
    }
  }
}

export const logger = {
  error(message: unknown, ...args: unknown[]): void {
    record("error", message, args);
  },
  warn(message: unknown, ...args: unknown[]): void {
    record("warn", message, args);
  },
  info(message: unknown, ...args: unknown[]): void {
    record("info", message, args);
  },
  debug(message: unknown, ...args: unknown[]): void {
    record("debug", message, args);
  },
} as const;
