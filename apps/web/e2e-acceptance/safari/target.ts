// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * What a Safari acceptance run walks, and where: read once from the
 * environment, validated before anything launches.
 *
 * Pure and env-injected, like `../lib/subset`, so it is unit-tested without a
 * browser.
 */

import { isLoopbackHostname } from "../../src/lib/validation-harness";
import { ACCEPTANCE_TASKS } from "../lib/subset";

/** `mac` (desktop Safari on this Mac) or `ios` (an iPhone over USB). */
export const TARGET_ENV_VAR = "ECO_SAFARI_TARGET";
/** The origin Safari opens, e.g. `http://127.0.0.1:3132`. */
export const BASE_URL_ENV_VAR = "ECO_SAFARI_BASE_URL";
/** Where safaridriver listens. */
export const DRIVER_URL_ENV_VAR = "ECO_SAFARI_DRIVER_URL";
/** The port of the stub api the build's `API_URL` points at. */
export const STUB_PORT_ENV_VAR = "ECO_SAFARI_STUB_PORT";
/** Comma-separated task numbers, shared with the Chrome lane. */
export const TASKS_ENV_VAR = "ECO_ACCEPTANCE_TASKS";

export const DEFAULT_DRIVER_URL = "http://127.0.0.1:4444";
export const DEFAULT_STUB_PORT = 3131;

/**
 * The tasks this lane can walk so far, in the walk's own order. A task not
 * listed here has no Safari mechanism yet; asking for one is an error rather
 * than a silent skip, so a run never claims a task it did not walk.
 */
export const SAFARI_TASKS: readonly number[] = [1, 2, 12];

export type SafariTarget = "mac" | "ios";

export type SafariLaneConfig = {
  target: SafariTarget;
  /** Origin only, no trailing slash. */
  baseUrl: string;
  driverUrl: string;
  stubPort: number;
  /** The tasks this run walks, in the walk's own order. */
  tasks: readonly number[];
  /** True unless the run walks every one of the lane's fourteen tasks. */
  narrowed: boolean;
};

function parseTarget(raw: string | undefined): SafariTarget {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "mac" || value === "ios") return value;
  throw new Error(
    `${TARGET_ENV_VAR}=${String(raw)}: set it to "mac" (desktop Safari on this Mac) or "ios" (an iPhone over USB).`,
  );
}

/**
 * The origin Safari opens. The validation harness — receipts, the fault
 * lever — only turns on for a loopback host, so a Mac run must be on one; a
 * phone cannot reach the Mac's loopback, and WebGPU needs a secure context,
 * so an iPhone run must be https on a LAN address.
 */
function parseBaseUrl(raw: string | undefined, target: SafariTarget): string {
  let url: URL;
  try {
    url = new URL((raw ?? "").trim());
  } catch {
    throw new Error(`${BASE_URL_ENV_VAR}=${String(raw)} is not a URL; e.g. http://127.0.0.1:3132.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${BASE_URL_ENV_VAR}=${url.href} must be http or https.`);
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (target === "mac" && !loopback) {
    throw new Error(
      `${BASE_URL_ENV_VAR}=${url.origin}: a Mac run needs a loopback host (127.0.0.1 or localhost) — the harness is off anywhere else.`,
    );
  }
  if (target === "ios" && (loopback || url.protocol !== "https:")) {
    throw new Error(
      `${BASE_URL_ENV_VAR}=${url.origin}: an iPhone run needs https on the Mac's LAN address — the phone cannot reach its loopback, and WebGPU needs a secure context.`,
    );
  }
  return url.origin;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_STUB_PORT;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${STUB_PORT_ENV_VAR}=${raw} is not a port.`);
  }
  return port;
}

/**
 * The tasks to walk. An explicit list is narrowed to the walk's own order;
 * a task the lane cannot walk on Safari yet is fatal, by name.
 */
function parseTasks(raw: string | undefined): readonly number[] {
  const asked = new Set(
    (raw ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(Number),
  );
  if (asked.size === 0) return SAFARI_TASKS;
  const unknown = [...asked].filter((task) => !SAFARI_TASKS.includes(task));
  if (unknown.length > 0) {
    throw new Error(
      `${TASKS_ENV_VAR} asks for task(s) ${unknown.join(", ")}, which the Safari lane does not walk yet `
        + `(it walks ${SAFARI_TASKS.join(", ")}).`,
    );
  }
  return SAFARI_TASKS.filter((task) => asked.has(task));
}

export function safariLaneConfig(
  env: Record<string, string | undefined> = process.env,
): SafariLaneConfig {
  const target = parseTarget(env[TARGET_ENV_VAR]);
  const tasks = parseTasks(env[TASKS_ENV_VAR]);
  return {
    target,
    baseUrl: parseBaseUrl(env[BASE_URL_ENV_VAR], target),
    driverUrl: (env[DRIVER_URL_ENV_VAR]?.trim() || DEFAULT_DRIVER_URL).replace(/\/+$/, ""),
    stubPort: parsePort(env[STUB_PORT_ENV_VAR]),
    tasks,
    narrowed: tasks.length < ACCEPTANCE_TASKS.length,
  };
}

/** The report and fragment names a run writes, so it never overwrites another browser's. */
export function artefactName(target: SafariTarget): string {
  return `safari-${target}`;
}
