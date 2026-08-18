#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Turn a capture run into something a person can actually review: an INDEX.md
 * grouped by manifest group, and one HTML contact sheet per group.
 *
 * Three hundred PNGs in nested folders is a data dump, not a review artifact.
 * The index gives each state its title, route, tier, what was asserted, and a
 * viewport x theme table of links; the contact sheets make a whole group
 * scannable in one screen.
 *
 * Usage: node scripts/build-capture-index.mjs [runDir]
 */

const runDir =
  process.argv[2]
  ?? newestRunDir(process.env.ECO_CAPTURE_OUT ?? join(homedir(), "eco-artifacts", "ui-baseline"));

function newestRunDir(base) {
  if (!existsSync(base)) {
    console.error(`build-capture-index: no capture output at ${base}`);
    process.exit(1);
  }
  const runs = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "run.json")))
    .map((entry) => entry.name)
    .sort();
  if (runs.length === 0) {
    console.error(`build-capture-index: no runs under ${base}`);
    process.exit(1);
  }
  return join(base, runs.at(-1));
}

const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
const shots = run.shots ?? [];

if (shots.length === 0) {
  console.warn("build-capture-index: run.json lists no shots — writing an empty index.");
}

const groupOf = (id) => id.split(".")[0];
const byGroup = new Map();
for (const shot of shots) {
  const group = groupOf(shot.id);
  const entries = byGroup.get(group) ?? new Map();
  const rows = entries.get(shot.id) ?? [];
  rows.push(shot);
  entries.set(shot.id, rows);
  byGroup.set(group, entries);
}

const VIEWPORTS = ["desktop", "tablet", "mobile"];
const escapeHtml = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── INDEX.md ────────────────────────────────────────────────────────────────

const lines = [
  "# Eco UI capture run",
  "",
  `- **Run:** \`${run.runId}\``,
  `- **Commit:** \`${run.gitSha}\`${run.gitDirty ? " *(working tree dirty — these pixels are not a clean commit)*" : ""}`,
  `- **Server:** ${run.server} (${run.baseURL})`,
  `- **Captured:** ${String(shots.length)} shots of ${String(run.entryCount ?? "?")} states`,
  `- **Started:** ${run.startedAt}${run.finishedAt ? ` · finished ${run.finishedAt}` : ""}`,
  "",
];

for (const [group, entries] of [...byGroup.entries()].sort()) {
  lines.push(`## ${group}`, "", `[Contact sheet](contact-sheets/${group}.html)`, "");

  for (const [id, rows] of [...entries.entries()].sort()) {
    const first = rows[0];
    lines.push(`### \`${id}\``, "");
    lines.push(`${first.title ?? id}`, "");
    lines.push(
      `- Route: \`${first.route}\``,
      `- Tier: ${first.tier} · Realism: ${first.realism}`,
      `- Asserted: ${(first.asserts ?? []).map((assertion) => `\`${assertion}\``).join(", ") || "—"}`,
    );
    if (first.realism === "mocked") {
      lines.push("- ⚠️ **Mocked** — a network response was faked for this state; do not read it as live behavior.");
    }
    lines.push("");

    const themes = [...new Set(rows.map((row) => row.theme))].sort();
    const extraProjects = rows.filter((row) => row.motion !== "no-preference" || row.fontSize !== "default");

    lines.push(`| viewport | ${themes.join(" | ")} |`, `| --- | ${themes.map(() => "---").join(" | ")} |`);
    for (const viewport of VIEWPORTS) {
      const cells = themes.map((theme) => {
        const match = rows.find(
          (row) =>
            row.viewport === viewport
            && row.theme === theme
            && row.motion === "no-preference"
            && row.fontSize === "default",
        );
        return match ? `[png](${relativeShot(match)})` : "—";
      });
      if (cells.every((cell) => cell === "—")) continue;
      lines.push(`| ${viewport} | ${cells.join(" | ")} |`);
    }
    lines.push("");

    if (extraProjects.length > 0) {
      lines.push("Axis variants:", "");
      for (const row of extraProjects) {
        lines.push(`- \`${row.project}\` — [png](${relativeShot(row)})`);
      }
      lines.push("");
    }
  }
}

function relativeShot(shot) {
  // run.json stores absolute paths; the index sits at the run root.
  const marker = `${runDir}/`;
  return shot.path.startsWith(marker) ? shot.path.slice(marker.length) : shot.path;
}

writeFileSync(join(runDir, "INDEX.md"), `${lines.join("\n")}\n`);

// ── contact sheets ──────────────────────────────────────────────────────────

const sheetsDir = join(runDir, "contact-sheets");
mkdirSync(sheetsDir, { recursive: true });

for (const [group, entries] of byGroup) {
  const cards = [...entries.entries()]
    .sort()
    .flatMap(([id, rows]) =>
      rows.map(
        (row) => `
      <figure>
        <a href="../${escapeHtml(relativeShot(row))}"><img src="../${escapeHtml(relativeShot(row))}" alt="${escapeHtml(id)} ${escapeHtml(row.project)}" loading="lazy" /></a>
        <figcaption><code>${escapeHtml(id)}</code><br /><small>${escapeHtml(row.project)}${row.realism === "mocked" ? " · ⚠️ mocked" : ""}</small></figcaption>
      </figure>`,
      ),
    )
    .join("\n");

  writeFileSync(
    join(sheetsDir, `${group}.html`),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Eco capture — ${escapeHtml(group)} (${escapeHtml(run.runId)})</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; background: Canvas; color: CanvasText; }
  h1 { font-size: 1.25rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1.25rem; }
  figure { margin: 0; }
  img { width: 100%; border: 1px solid rgba(128,128,128,.4); border-radius: 6px; background: #808080; }
  figcaption { margin-top: .4rem; word-break: break-all; }
</style>
</head>
<body>
<h1>${escapeHtml(group)} — ${escapeHtml(run.runId)}</h1>
<div class="grid">
${cards}
</div>
</body>
</html>
`,
  );
}

console.log(
  `[capture] index written: ${join(runDir, "INDEX.md")} (${String(byGroup.size)} group(s), ${String(shots.length)} shots)`,
);
