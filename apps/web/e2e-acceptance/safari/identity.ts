// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Which Safari, on which device, a run walked — as the driver reported it.
 *
 * It is kept on disk beside the report for the same reason the rows are (see
 * `../lib/report`): Playwright replaces a worker after a failed test, and the
 * test that assembles the final report may run in a process that never saw
 * the session.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserIdentity, ReportArtefacts } from "../lib/report";
import type { SafariTarget } from "./target";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The identity a new session's capabilities describe. */
export function identityFromCapabilities(
  target: SafariTarget,
  capabilities: Record<string, unknown>,
): BrowserIdentity {
  const deviceName = text(capabilities["safari:deviceName"]);
  const osVersion = text(capabilities["safari:platformVersion"]) ?? text(capabilities.platformVersion);
  return {
    engine: "safari",
    device: target,
    version: text(capabilities.browserVersion) ?? "unknown",
    ...(deviceName === undefined ? {} : { deviceName }),
    ...(osVersion === undefined ? {} : { osVersion }),
  };
}

export function identityPath(artefacts: ReportArtefacts): string {
  return artefacts.jsonPath.replace(/\.json$/, ".browser.json");
}

export function writeIdentity(artefacts: ReportArtefacts, identity: BrowserIdentity): void {
  mkdirSync(dirname(identityPath(artefacts)), { recursive: true });
  writeFileSync(identityPath(artefacts), `${JSON.stringify(identity, null, 2)}\n`);
}

/** The identity the run recorded, or undefined when no session ever started. */
export function readIdentity(artefacts: ReportArtefacts): BrowserIdentity | undefined {
  try {
    return JSON.parse(readFileSync(identityPath(artefacts), "utf8")) as BrowserIdentity;
  } catch {
    return undefined;
  }
}

export function clearIdentity(artefacts: ReportArtefacts): void {
  rmSync(identityPath(artefacts), { force: true });
}
