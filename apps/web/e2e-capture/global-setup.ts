// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";
import { entryRunsInContext, shotRelativePath } from "./capture";
import { captureOutputBase, parseProjectName } from "./fixtures";
import { allGaps, allStates } from "./manifest";

/**
 * Run header + route warm-up.
 *
 * Two jobs, both about making the run trustworthy rather than fast:
 *
 * 1. Mint the run id and write `run.json` and `expected.json` BEFORE any
 *    screenshot exists. `expected.json` is the manifest's own answer to "what
 *    should this run produce", which `check-capture-coverage.mjs` then compares
 *    against the disk — a run that dies halfway still leaves the evidence that
 *    it was supposed to produce more.
 * 2. Hit each distinct route once so the dev server's per-route compilation
 *    happens outside the tests. Otherwise the first capture of each route pays
 *    a 5-20s compile and its screenshot races the compile-time layout.
 */

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * What produced these pixels, beyond the app's own commit.
 *
 * A baseline is compared against a LATER run, and "the UI changed" and "the
 * browser changed" look identical in a PNG. Recording the browser and framework
 * versions is what lets a future reviewer tell those apart instead of filing a
 * font-rendering delta as a regression.
 */
function toolingVersions(): Record<string, string> {
  // Resolved from cwd, not from this module: Playwright transpiles this file and
  // `import.meta` does not survive that reliably (global-teardown.ts hit the same
  // thing). `pnpm --filter @eco/web capture` runs with cwd = apps/web, which is
  // exactly where these packages should resolve from anyway.
  const resolve = createRequire(join(process.cwd(), "package.json"));
  const version = (name: string): string => {
    try {
      return (resolve(`${name}/package.json`) as { version: string }).version;
    } catch {
      return "unknown";
    }
  };

  return {
    node: process.version,
    playwright: version("@playwright/test"),
    next: version("next"),
    react: version("react"),
    tailwindcss: version("tailwindcss"),
  };
}

function mintRunId(gitSha: string): string {
  const stamp = new Date().toISOString().replace(/[:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `${stamp}-${gitSha.slice(0, 7)}`;
}

async function warmRoutes(baseURL: string): Promise<string[]> {
  const routes = [...new Set(allStates.map((entry) => entry.route))].sort();
  const failures: string[] = [];

  for (const route of routes) {
    try {
      const response = await fetch(new URL(route, baseURL));
      // Drain the body so the server finishes rendering rather than being
      // abandoned mid-stream on the very first hit.
      await response.text();
      if (!response.ok) {
        failures.push(`${route} → HTTP ${String(response.status)}`);
      }
    } catch (error) {
      failures.push(`${route} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return failures;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const gitSha = git(["rev-parse", "HEAD"]);
  const gitDirty = git(["status", "--porcelain"]).length > 0;
  const runId = process.env.ECO_CAPTURE_RUN_ID ?? mintRunId(gitSha);
  const runDir = join(captureOutputBase(), runId);

  mkdirSync(join(runDir, "shots"), { recursive: true });
  process.env.ECO_CAPTURE_RUN_ID = runId;
  process.env.ECO_CAPTURE_RUN_DIR = runDir;

  const expected = config.projects.flatMap((project) => {
    const axes = parseProjectName(project.name);
    const ctx = { ...axes, outputRoot: runDir, runId };
    return allStates
      .filter((entry) => entryRunsInContext(entry, ctx))
      .map((entry) => ({
        id: entry.id,
        project: project.name,
        path: shotRelativePath(entry.id, project.name),
      }));
  });

  writeFileSync(join(runDir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);

  const baseURL = config.projects[0]?.use.baseURL ?? "http://localhost:3300";
  const warmFailures = await warmRoutes(baseURL);

  writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify(
      {
        runId,
        startedAt: new Date().toISOString(),
        gitSha,
        gitDirty,
        server: process.env.ECO_CAPTURE_SERVER === "prod" ? "prod" : "dev",
        baseURL,
        node: process.version,
        tooling: toolingVersions(),
        // The palette and shortcuts sheet print "Cmd" or "Ctrl" from
        // navigator.platform, which the lane does not control — so the host OS
        // is part of what a reader is looking at. See the index's caveat.
        host: { platform: platform(), release: release() },
        entryCount: allStates.length,
        projects: config.projects.map((project) => project.name),
        expectedShots: expected.length,
        warmFailures,
        gaps: allGaps,
        shots: [],
      },
      null,
      2,
    )}\n`,
  );

  if (warmFailures.length > 0) {
    // Not fatal: a route can legitimately 404 for a guest, and the per-entry
    // assertions are the real gate. But an unexplained list here is the first
    // thing to read when a wave comes back mysteriously red.
    console.warn(`[capture] route warm-up reported ${String(warmFailures.length)} problem(s):`);
    for (const failure of warmFailures) console.warn(`  - ${failure}`);
  }

  console.log(`[capture] run ${runId} → ${runDir} (${String(expected.length)} shots expected)`);
}
