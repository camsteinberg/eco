#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/**
 * Does this capture run contain exactly the screenshots the manifest asked for?
 *
 * A capture run that quietly drops a state is worse than one that fails: the
 * whole point is an inventory you can trust to be complete. This compares the
 * expected-shot list `global-setup.ts` wrote from the manifest against what is
 * actually on disk, and fails on anything that would make the run misleading.
 *
 * Why it reads `expected.json` instead of the TypeScript manifest: the manifest
 * is TS with Playwright imports, and this repo has no TS runner for plain
 * scripts (no tsx dependency). `global-setup.ts` already evaluates the manifest
 * with the same `entryRunsInContext` the specs use, so its expected list IS the
 * manifest's answer — and it is written before any screenshot exists, so a run
 * that dies halfway still gets checked against the full expectation.
 *
 * Usage:
 *   node scripts/check-capture-coverage.mjs [runDir]
 * Defaults to the newest run under $ECO_CAPTURE_OUT (or ~/eco-artifacts/ui-baseline).
 */

const SUSPECT_BYTES = 8 * 1024;

function outputBase() {
  return process.env.ECO_CAPTURE_OUT ?? join(homedir(), "eco-artifacts", "ui-baseline");
}

function newestRunDir(base) {
  if (!existsSync(base)) {
    fail(`No capture output at ${base}. Run \`pnpm --filter @eco/web capture\` first.`);
  }
  const runs = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "expected.json")))
    .map((entry) => entry.name)
    .sort();
  if (runs.length === 0) {
    fail(`No capture runs with an expected.json under ${base}.`);
  }
  return join(base, runs.at(-1));
}

function fail(message) {
  console.error(`capture coverage: ${message}`);
  process.exit(1);
}

function walkPngs(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkPngs(path));
    } else if (entry.name.endsWith(".png")) {
      found.push(path);
    }
  }
  return found;
}

const runDir = process.argv[2] ?? newestRunDir(outputBase());
const expectedPath = join(runDir, "expected.json");
if (!existsSync(expectedPath)) {
  fail(`${expectedPath} is missing — this is not a capture run directory.`);
}

const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
const expectedByPath = new Map(expected.map((shot) => [shot.path, shot]));

const onDisk = new Map();
for (const absolute of walkPngs(join(runDir, "shots"))) {
  onDisk.set(relative(runDir, absolute).split("\\").join("/"), absolute);
}

const missing = [];
const orphan = [];
const zeroByte = [];
const suspect = [];
const byHash = new Map();

for (const [path] of expectedByPath) {
  if (!onDisk.has(path)) missing.push(path);
}

for (const [path, absolute] of onDisk) {
  if (!expectedByPath.has(path)) {
    orphan.push(path);
    continue;
  }

  const { size } = statSync(absolute);
  if (size === 0) {
    zeroByte.push(path);
    continue;
  }
  if (size < SUSPECT_BYTES) {
    suspect.push(`${path} (${String(size)} bytes)`);
  }

  const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  const bucket = byHash.get(hash) ?? [];
  bucket.push(path);
  byHash.set(hash, bucket);
}

/**
 * Identical pixels under two different ids mean one of the two states never
 * actually rendered — most often a dark shot that came out light because the
 * theme seed did not land, or a `prepare` that silently did nothing.
 */
const duplicates = [...byHash.values()]
  .filter((paths) => paths.length > 1)
  .map((paths) => paths.sort());

const report = (label, items) => {
  if (items.length === 0) return;
  console.error(`\n${label} (${String(items.length)}):`);
  for (const item of items) console.error(`  ${Array.isArray(item) ? item.join("  ==  ") : item}`);
};

console.log(`capture coverage: ${runDir}`);
console.log(`  expected ${String(expectedByPath.size)} · on disk ${String(onDisk.size)}`);

report("MISSING — expected but not captured", missing);
report("ORPHAN — captured but not in the manifest", orphan);
report("ZERO_BYTE — file exists but is empty", zeroByte);
report("DUPLICATE — different ids, identical pixels", duplicates);

if (suspect.length > 0) {
  console.warn(`\nSUSPECT — under ${String(SUSPECT_BYTES)} bytes, check these are not blank (${String(suspect.length)}):`);
  for (const item of suspect) console.warn(`  ${item}`);
}

const failures = missing.length + orphan.length + zeroByte.length + duplicates.length;
if (failures > 0) {
  console.error(`\ncapture coverage FAILED with ${String(failures)} problem(s).`);
  process.exit(1);
}

console.log("capture coverage OK — every expected shot is present, unique and non-empty.");
