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

/**
 * The column a shot belongs in.
 *
 * NOT simply `theme`: the two system-theme projects both record
 * `theme: 'system'` and differ only in the OS scheme they emulate, so keying on
 * theme collapsed them into one cell and dropped a shot from the index
 * entirely (caught by comparing linked paths against the PNGs on disk —
 * 777 links for 779 files).
 */
const columnFor = (row) =>
  row.theme === "system" ? `system-${row.colorScheme ?? "?"}` : row.theme;
const escapeHtml = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── INDEX.md ────────────────────────────────────────────────────────────────

const tooling = run.tooling ?? {};
const toolingLine = Object.entries(tooling)
  .map(([name, version]) => `${name} ${version}`)
  .join(" · ");

const lines = [
  "# Eco UI capture run",
  "",
  `- **Run:** \`${run.runId}\``,
  `- **Commit:** \`${run.gitSha}\`${run.gitDirty ? " *(working tree dirty — these pixels are not a clean commit)*" : ""}`,
  `- **Server:** ${run.server} (${run.baseURL})`,
  `- **Captured:** ${String(shots.length)} shots of ${String(run.entryCount ?? "?")} states`,
  `- **Started:** ${run.startedAt}${run.finishedAt ? ` · finished ${run.finishedAt}` : ""}`,
  ...(toolingLine ? [`- **Tooling:** ${toolingLine}`] : []),
  ...(run.host ? [`- **Host:** ${run.host.platform} ${run.host.release}`] : []),
  "",
  "> **Keycaps are this machine's, not the design's.** The command palette and the",
  "> shortcuts sheet print their modifier as Cmd or Ctrl from `navigator.platform`,",
  `> which the lane does not control — these shots were taken on \`${run.host?.platform ?? "an unrecorded platform"}\`.`,
  "> A run on another OS differs in those keycaps for a reason that is not the UI",
  "> changing. Noted rather than faked, because faking it would mean lying about",
  "> what a reader's own machine will show them.",
  "",
  "> **Storage figures are this machine's too.** The settings storage panel reads a",
  "> real `navigator.storage.estimate()`, and a fresh browser profile reports a",
  "> different origin quota each time — measured 873 MB and 864 MB in two",
  "> back-to-back runs on 2026-08-19. So the “N MB available” line moves between",
  "> runs while nothing about the UI has changed. Review the layout and the copy,",
  "> not the number. (The setup-gate storage ERRORS are stable: their figures come",
  "> from the forced-failure seam, not from the disk.)",
  "",
];

const gaps = run.gaps ?? [];
const gapsByGroup = new Map();
for (const gap of gaps) {
  gapsByGroup.set(gap.group, [...(gapsByGroup.get(gap.group) ?? []), gap]);
}

// A contents block, because the point of this file is that a reviewer can find
// the one group they care about in a 300-shot inventory.
lines.push("## Contents", "");
for (const [group, entries] of [...byGroup.entries()].sort()) {
  const gapCount = (gapsByGroup.get(group) ?? []).length;
  lines.push(
    `- [${group}](#${group}) — ${String(entries.size)} states`
      + `${gapCount > 0 ? `, ${String(gapCount)} documented gap${gapCount === 1 ? "" : "s"}` : ""}`,
  );
}
lines.push("- [Honest gaps](#honest-gaps)", "");

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
    if (first.notes) {
      lines.push(`- Notes: ${first.notes}`);
    }
    if (first.realism === "mocked") {
      lines.push("- ⚠️ **Mocked** — a network response was faked for this state; do not read it as live behavior.");
    }
    if (first.server === "prod") {
      lines.push(
        "- ⚠️ **Production build only** — this state does not render on the dev server, so it is absent from any dev run.",
      );
    }
    lines.push("");

    const themes = [...new Set(rows.map(columnFor))].sort();
    const extraProjects = rows.filter((row) => row.motion !== "no-preference" || row.fontSize !== "default");

    lines.push(`| viewport | ${themes.join(" | ")} |`, `| --- | ${themes.map(() => "---").join(" | ")} |`);
    for (const viewport of VIEWPORTS) {
      const cells = themes.map((theme) => {
        const match = rows.find(
          (row) =>
            row.viewport === viewport
            && columnFor(row) === theme
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

// ── honest gaps ─────────────────────────────────────────────────────────────
//
// An inventory that only lists what it has is a sales brochure. Every state a
// wave decided it could not reach honestly is declared in the manifest next to
// the states it sits among (`<group>Gaps` in each manifest file), and printed
// here so the limits are read alongside the coverage rather than discovered
// later by someone looking for a screenshot that was never taken.

lines.push(
  "## Honest gaps",
  "",
  `${gaps.length === 0 ? "None declared." : `${String(gaps.length)} UI states are knowingly absent from this run.`}`,
  "",
  "These are not failures — every one was investigated and the reason is recorded.",
  "Two kinds are mixed here on purpose: states with no honest trigger (the app",
  "cannot be made to render them without editing `src/`), and states excluded by",
  "choice (harness-only copy that never ships, which would invite design critique",
  "of text no user sees). The reason line says which.",
  "",
);

for (const [group, groupGaps] of [...gapsByGroup.entries()].sort()) {
  lines.push(`### ${group}`, "");
  for (const gap of groupGaps) {
    lines.push(`- **\`${gap.id}\`** — ${gap.surface}`, `  ${gap.reason}`, "");
  }
}

const indexBody = `${lines.join("\n")}\n`;
writeFileSync(join(runDir, "INDEX.md"), indexBody);

/**
 * Every shot must be reachable from the index.
 *
 * An index that quietly omits a shot is worse than a missing index: the run
 * looks complete and the state is simply never reviewed. This exact bug shipped
 * once — the two system-theme projects share `theme: 'system'`, so a table keyed
 * on theme rendered one cell and dropped the other shot. Comparing what was
 * linked against what was recorded is the cheap check that would have caught it,
 * so it now runs on every build.
 */
const linked = new Set(
  [...indexBody.matchAll(/\]\((shots\/[^)]+)\)/g)].map((match) => match[1]),
);
const unlinked = shots.map(relativeShot).filter((path) => !linked.has(path));

if (unlinked.length > 0) {
  console.error(
    `\n[capture] INDEX.md links ${String(linked.size)} shots but the run recorded `
      + `${String(shots.length)} — ${String(unlinked.length)} would never be reviewed:`,
  );
  for (const path of unlinked.slice(0, 20)) console.error(`  ${path}`);
  process.exit(1);
}

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
        <figcaption><code>${escapeHtml(id)}</code><br /><small>${escapeHtml(row.project)}${row.realism === "mocked" ? " · ⚠️ mocked" : ""}${row.server === "prod" ? " · prod-only" : ""}</small></figcaption>
      </figure>`,
      ),
    )
    .join("\n");

  // The group's own limits travel with the sheet: this is the surface a
  // reviewer actually scans, so "what is missing" belongs on it, not only in
  // the index they may never open.
  const groupGaps = gapsByGroup.get(group) ?? [];
  const gapsSection =
    groupGaps.length === 0
      ? ""
      : `<section class="gaps">
<h2>Not captured (${String(groupGaps.length)})</h2>
<dl>
${groupGaps
  .map(
    (gap) =>
      `  <dt><code>${escapeHtml(gap.id)}</code> — ${escapeHtml(gap.surface)}</dt>\n  <dd>${escapeHtml(gap.reason)}</dd>`,
  )
  .join("\n")}
</dl>
</section>`;

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
  .gaps { margin-top: 2.5rem; border-top: 1px solid rgba(128,128,128,.4); padding-top: 1rem; max-width: 60rem; }
  .gaps h2 { font-size: 1rem; }
  .gaps dt { font-weight: 600; margin-top: .75rem; }
  .gaps dd { margin: .25rem 0 0; color: color-mix(in srgb, CanvasText 70%, Canvas); }
</style>
</head>
<body>
<h1>${escapeHtml(group)} — ${escapeHtml(run.runId)}</h1>
<div class="grid">
${cards}
</div>
${gapsSection}
</body>
</html>
`,
  );
}

console.log(
  `[capture] index written: ${join(runDir, "INDEX.md")} `
    + `(${String(byGroup.size)} group(s), ${String(shots.length)} shots, ${String(gaps.length)} documented gap(s))`,
);
