// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The acceptance lane's report: one row per turn, one table per model.
 *
 * A row is the smallest thing a reader can act on — which task, which turn,
 * which model answered, how long the first token took, what the KV cache
 * decided, and the evidence the verdict rests on. Verdicts are deliberately
 * coarse: a mechanical check either held or it did not, and everything a person
 * has to judge is carried as text rather than scored by a rubric this file
 * invents.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * PASS / FAIL come from a mechanical check. EXPECTED-FAIL is a known gap the
 * run must record without failing. RECORDED is a turn whose quality only a
 * person can judge; the evidence carries the reply.
 */
export type RowResult = "PASS" | "FAIL" | "EXPECTED-FAIL" | "RECORDED";

export type AcceptanceRow = {
  task: number;
  /** Turn within the task, 1-based. A single-turn task records turn 1. */
  turn: number;
  /** What this row exercises, in one short phrase. */
  label: string;
  /** The model the receipt names, or the model the row targeted when no receipt exists. */
  modelId: string;
  /** Null on a turn that produced no generation (a tool answer, or a failure). */
  firstTokenMs: number | null;
  /** `kvReuse.decision/reason` from the receipt, or null when there was none. */
  kvReason: string | null;
  result: RowResult;
  /** Why the verdict holds: a mechanical check's outcome, or the reply itself. */
  evidence: string;
};

export type PickReport = {
  /** Declaration order, so an assembled report keeps the order of the walks. */
  order: number;
  startedAt: string;
  finishedAt: string;
  /** The catalog id the walk targeted. */
  modelId: string;
  /** The product name a person sees for it. */
  label: string;
  slot: string;
  rows: AcceptanceRow[];
  /** Set when the walk stopped early; names the task that stopped it. */
  abortedAt?: { task: number; reason: string };
};

export type AcceptanceReport = {
  startedAt: string;
  finishedAt: string;
  /**
   * Present, and true, only on a smoke run (`ECO_ACCEPTANCE_SMOKE=1`): one
   * pick, three tasks, no origin wipe. Absent on a full walk, so a full run's
   * artefacts are unchanged by this field existing.
   */
  smoke?: true;
  picks: PickReport[];
};

function cell(value: string | number | null): string {
  if (value === null) return "—";
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ⏎ ");
}

/** Clip an evidence string so a table row stays readable. */
export function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function renderTable(pick: PickReport): string {
  const header =
    "| task | turn | modelId | firstTokenMs | kvReason | result | evidence |\n"
    + "| ---: | ---: | --- | ---: | --- | --- | --- |";
  const body = pick.rows
    .map((row) =>
      [
        row.task,
        row.turn,
        row.modelId,
        row.firstTokenMs === null ? null : Math.round(row.firstTokenMs),
        row.kvReason,
        row.result,
        `${row.label} — ${clip(row.evidence)}`,
      ]
        .map(cell)
        .join(" | "),
    )
    .map((line) => `| ${line} |`)
    .join("\n");
  return `${header}\n${body}`;
}

export function renderMarkdown(report: AcceptanceReport): string {
  const parts = [
    "# Acceptance run",
    "",
    `Started ${report.startedAt}, finished ${report.finishedAt}.`,
    "",
    ...(report.smoke
      ? [
          "**Smoke subset (`ECO_ACCEPTANCE_SMOKE=1`): one model, tasks 1, 4 and",
          "8 only, on whatever the profile already had.** This run is a self-test",
          "of the lane, not an acceptance verdict — read it as \"the walk still",
          "works\", never as \"the product passed\".",
          "",
        ]
      : []),
    "## Method",
    "",
    "Real inference on this machine's GPU against a production build, one row",
    "per turn. `PASS`/`FAIL` come from a mechanical check, `EXPECTED-FAIL` names",
    "a known gap, and `RECORDED` is a turn only a person can judge — its",
    "evidence carries the reply.",
    "",
    "Each model is walked in ONE tab, starting a fresh conversation between",
    "tasks, because a tab per task asks the machine for a copy of the model per",
    "task. Web lookups are switched on and off in that same tab: the preference",
    "is hydrated per tab when it mounts, so flipping it in a second tab leaves",
    "an already-open chat still believing what it believed when it loaded. That",
    "is a product nuance the walk works with, not a defect it reports.",
    "",
  ];
  for (const pick of report.picks) {
    parts.push(`## ${pick.label} (\`${pick.modelId}\`, slot \`${pick.slot}\`)`, "");
    if (pick.abortedAt) {
      parts.push(
        `**Stopped at task ${pick.abortedAt.task}:** ${pick.abortedAt.reason}`,
        "",
      );
    }
    parts.push(renderTable(pick), "");
    const counts = pick.rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.result] = (acc[row.result] ?? 0) + 1;
      return acc;
    }, {});
    parts.push(
      `Rows: ${pick.rows.length} — `
        + (["PASS", "FAIL", "EXPECTED-FAIL", "RECORDED"] as const)
          .map((key) => `${key} ${counts[key] ?? 0}`)
          .join(", "),
      "",
    );
  }
  return parts.join("\n");
}

export const REPORT_JSON_PATH = join(
  __dirname,
  "..",
  "..",
  "test-results",
  "acceptance-report.json",
);

/**
 * Where each walk's rows are kept while the run is in progress.
 *
 * The report cannot live in module memory. Playwright starts a FRESH WORKER
 * PROCESS after a failed test, which re-imports the spec and so re-creates any
 * module-level accumulator — and this lane learned that the hard way twice: one
 * run lost the second model's table because the first walk failed, the next run
 * lost the FIRST model's table because the second walk ran in a new worker and
 * its `afterAll` overwrote the file with only what that worker had seen.
 *
 * So each walk owns a fragment on disk, rewritten after every row, and the
 * report is assembled from every fragment present. Any worker can assemble it,
 * at any point, and get the whole run.
 */
const FRAGMENT_DIR = join(dirname(REPORT_JSON_PATH), "acceptance-picks");

function fragmentPath(pick: PickReport): string {
  const slug = pick.modelId.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return join(FRAGMENT_DIR, `${String(pick.order).padStart(2, "0")}-${slug}.json`);
}

/** Persist one walk's rows so far. Safe to call after every row. */
export function writePickFragment(pick: PickReport): void {
  mkdirSync(FRAGMENT_DIR, { recursive: true });
  writeFileSync(fragmentPath(pick), `${JSON.stringify(pick, null, 2)}\n`);
}

/** Every walk's fragment on disk, in declaration order. */
export function readPickFragments(): PickReport[] {
  let names: string[];
  try {
    names = readdirSync(FRAGMENT_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const picks: PickReport[] = [];
  for (const name of names.sort()) {
    try {
      picks.push(JSON.parse(readFileSync(join(FRAGMENT_DIR, name), "utf8")) as PickReport);
    } catch {
      // A fragment written mid-crash is not worth failing the assembly over.
    }
  }
  return picks.sort((a, b) => a.order - b.order);
}

/** Clear the previous run's fragments and report. Called once, before the run. */
export function resetReportArtefacts(): void {
  rmSync(FRAGMENT_DIR, { recursive: true, force: true });
  rmSync(REPORT_JSON_PATH, { force: true });
  rmSync(REPORT_JSON_PATH.replace(/\.json$/, ".md"), { force: true });
}

/**
 * Assemble every fragment into the report and write both artefacts.
 * Idempotent, so every worker can call it as it finishes.
 */
export function assembleReport(options: { smoke?: boolean } = {}): {
  report: AcceptanceReport;
  jsonPath: string;
  markdownPath: string;
} {
  const picks = readPickFragments();
  const report: AcceptanceReport = {
    startedAt: picks.map((pick) => pick.startedAt).sort()[0] ?? new Date().toISOString(),
    finishedAt:
      picks.map((pick) => pick.finishedAt).filter(Boolean).sort().pop()
      ?? new Date().toISOString(),
    // Omitted rather than set false, so a full run's JSON is byte-identical.
    ...(options.smoke ? { smoke: true as const } : {}),
    picks,
  };
  const markdownPath = REPORT_JSON_PATH.replace(/\.json$/, ".md");
  mkdirSync(dirname(REPORT_JSON_PATH), { recursive: true });
  writeFileSync(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
  return { report, jsonPath: REPORT_JSON_PATH, markdownPath };
}
