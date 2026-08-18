// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShotRecord } from "./types";

/**
 * Fold the per-worker shot logs into one run manifest, then build the index.
 *
 * Workers each append to their own `.shots-<pid>.jsonl` because concurrent
 * appends to a single JSON file lose records. Merging here is the only moment
 * the whole run exists in one place.
 */
export default function globalTeardown(): void {
  const runDir = process.env.ECO_CAPTURE_RUN_DIR;
  if (!runDir || !existsSync(runDir)) {
    return;
  }

  const shards = readdirSync(runDir).filter(
    (name) => name.startsWith(".shots-") && name.endsWith(".jsonl"),
  );

  const shots: ShotRecord[] = [];
  for (const shard of shards) {
    const shardPath = join(runDir, shard);
    for (const line of readFileSync(shardPath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      shots.push(JSON.parse(line) as ShotRecord);
    }
    rmSync(shardPath);
  }

  shots.sort((left, right) =>
    left.id === right.id ? left.project.localeCompare(right.project) : left.id.localeCompare(right.id),
  );

  const runPath = join(runDir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8")) as Record<string, unknown>;
  run.finishedAt = new Date().toISOString();
  run.shots = shots;
  run.shotCount = shots.length;
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

  // Resolved from cwd rather than the module's own path: Playwright transpiles
  // this file, and neither __dirname nor import.meta.dirname survives that
  // reliably. `pnpm --filter @eco/web capture` runs with cwd = apps/web.
  const indexBuilder = [
    join(process.cwd(), "scripts", "build-capture-index.mjs"),
    join(process.cwd(), "apps", "web", "scripts", "build-capture-index.mjs"),
  ].find((candidate) => existsSync(candidate));

  try {
    if (!indexBuilder) {
      throw new Error(`build-capture-index.mjs not found from cwd ${process.cwd()}`);
    }
    execFileSync(process.execPath, [indexBuilder, runDir], { stdio: "inherit" });
  } catch (error) {
    // A failed index is a reporting problem, not a capture problem — the PNGs
    // and run.json are already on disk and the coverage script reads those.
    console.warn(
      `[capture] index build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log(`[capture] ${String(shots.length)} shots recorded in ${runPath}`);
}
