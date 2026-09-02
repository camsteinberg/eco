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

import { mkdirSync, writeFileSync } from "node:fs";
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

/** Write both artefacts and return the paths written. */
export function writeReport(
  report: AcceptanceReport,
  jsonPath: string,
): { jsonPath: string; markdownPath: string } {
  const markdownPath = jsonPath.replace(/\.json$/, ".md");
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
  return { jsonPath, markdownPath };
}

export const REPORT_JSON_PATH = join(
  __dirname,
  "..",
  "..",
  "test-results",
  "acceptance-report.json",
);
