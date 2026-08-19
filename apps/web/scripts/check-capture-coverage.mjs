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

/**
 * Small shots that have been looked at and are correct.
 *
 * Both are `mode: 'element'` crops of a genuinely tiny region, so they land
 * under the blank-frame threshold every run. Without this list the same two
 * warnings reappear forever and a reviewer either re-checks them each time or —
 * far worse — learns to skim past the SUSPECT section, which is where a real
 * blank frame would show up. Listing them turns the section back into a signal:
 * anything printed under NEW is genuinely unverified.
 */
const EXPLAINED_SMALL_SHOTS = {
  "chat-interactions.guide-button-hover":
    "a 44px floating button, cropped to itself — about 2 KB",
  "settings.storage-measuring":
    "the storage panel's skeleton, a few flat bars while the estimate stalls — about 7.7 KB",
};

/** `shots/<project>/<group>.<name>.png` → `<group>.<name>`. */
function entryIdFromPath(path) {
  return path.split("/").at(-1)?.replace(/\.png$/, "") ?? path;
}

/**
 * Pairs that are SUPPOSED to be pixel-identical.
 *
 * The axis sweep shoots each of its states at the variant point AND at the
 * control point (motion `no-preference`, font size `default`) so the pair can be
 * compared. At that control point the state is, by construction, the same state
 * another group already owns — so the two ids agree exactly, which is the
 * evidence the axis does nothing there, not a sign one of them failed to render.
 *
 * Each pair was confirmed by opening both images. Anything NOT listed here still
 * fails the run: a dark shot that came out light because the theme seed did not
 * land looks exactly like this, and that is the case this check exists for.
 */
const EXPECTED_TWINS = [
  {
    ids: ["axes.reduce-setup-botanical", "setup-gate.setup-resuming"],
    reason:
      "the axis control point. Both reach the same WelcomeSetup surface — the legacy slot keys "
      + "the axes entry seeds steer the gate into the resume path, so both render "
      + "\"Finishing your model download…\" at percent 0. Verified by eye 2026-08-19. The reduce "
      + "variant is the shot that carries this entry's finding.",
  },
  {
    ids: ["axes.font-chat-conversation", "chat-surface.conversation"],
    reason: "the axis control point — font size `default` IS the state chat-surface already owns.",
  },
  {
    ids: ["axes.font-content-page", "routes.transparency"],
    reason: "the axis control point — font size `default` IS the state routes already owns.",
  },
];

/** Is this set of duplicate paths a pair we expect to be identical? */
function expectedTwinFor(paths) {
  const ids = [...new Set(paths.map(entryIdFromPath))].sort();
  return EXPECTED_TWINS.find(
    (twin) =>
      twin.ids.length === ids.length && [...twin.ids].sort().every((id, index) => id === ids[index]),
  );
}

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
const explainedSmall = [];
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
    const explanation = EXPLAINED_SMALL_SHOTS[entryIdFromPath(path)];
    if (explanation) {
      explainedSmall.push(`${path} (${String(size)} bytes) — ${explanation}`);
    } else {
      suspect.push(`${path} (${String(size)} bytes)`);
    }
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
const allDuplicates = [...byHash.values()]
  .filter((paths) => paths.length > 1)
  .map((paths) => paths.sort());

const duplicates = [];
const expectedTwins = [];
for (const paths of allDuplicates) {
  const twin = expectedTwinFor(paths);
  if (twin) {
    expectedTwins.push(`${paths.join("  ==  ")} — ${twin.reason}`);
  } else {
    duplicates.push(paths);
  }
}

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

if (expectedTwins.length > 0) {
  console.log(`\nexpected twins (${String(expectedTwins.length)}) — identical by design, each verified by eye:`);
  for (const item of expectedTwins) console.log(`  ${item}`);
}

if (explainedSmall.length > 0) {
  console.log(`\nsmall but explained (${String(explainedSmall.length)}) — element crops already reviewed:`);
  for (const item of explainedSmall) console.log(`  ${item}`);
}

if (suspect.length > 0) {
  console.warn(
    `\nSUSPECT — under ${String(SUSPECT_BYTES)} bytes and NOT on the explained list, `
      + `open these and check they are not blank (${String(suspect.length)}):`,
  );
  for (const item of suspect) console.warn(`  ${item}`);
}

const failures = missing.length + orphan.length + zeroByte.length + duplicates.length;
if (failures > 0) {
  console.error(`\ncapture coverage FAILED with ${String(failures)} problem(s).`);
  process.exit(1);
}

console.log("capture coverage OK — every expected shot is present, unique and non-empty.");
