// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The acceptance walk in REAL Safari — desktop Safari on this Mac today —
 * driven over WebDriver, with the Chrome lane's own tasks, prompts and
 * verdict rules (`../lib/tasks`) and its report format (`../lib/report`).
 *
 * Why it exists: Playwright cannot drive real Safari, and Safari's GPU path
 * and memory limits are its own, so the Chrome lane's verdicts say nothing
 * about it. Each task here is the Chrome task's mechanism translated to
 * WebDriver (`./page`); where a translation changes what is observed, the
 * report's Method section says so.
 *
 * It walks the tasks it has a Safari mechanism for (`SAFARI_TASKS` in
 * `./target`); `ECO_ACCEPTANCE_TASKS` narrows them further. It is opt-in —
 * `pnpm --filter @eco/web test:acceptance:safari`, never `pnpm qa` and never
 * CI — and needs a server the operator started (see the README).
 *
 * The run's exit status follows the report, as the Chrome lane's does: any
 * FAIL row ends it red.
 */

import { expect, test } from "@playwright/test";
import catalogData from "../../src/local-ai/catalog/catalog-data.json";
import {
  MODEL_HOST_REMEDY,
  acceptanceModelHost,
  artifactFor,
  modelFileUrl,
  sampleFiles,
} from "../lib/model-host";
import {
  assembleReport,
  clip,
  reportArtefacts,
  writePickFragment,
  type AcceptanceRow,
  type PickReport,
} from "../lib/report";
import {
  AFTER_STOP_PROMPT,
  BUDGET_TURNS,
  ECO_COMPACT_WEBLLM,
  ECO_MOBILE_WEBLLM,
  FIRST_RUN_PROMPT,
  LONG_TURN_TIMEOUT_MS,
  STOPPED_RECEIPT_TIMEOUT_MS,
  STOP_PROMPT,
  judgeAnswered,
  judgeBudgetTurn,
  judgeFirstReply,
  judgeFollowUp,
  judgeStopNotPressed,
  judgeStopped,
  kvReasonOf,
  outcomeReceipt,
  type Pick,
  type TurnOutcome,
  type Verdict,
} from "../lib/tasks";
import { checkModelFilesServed } from "../lib/walk";
import { guardDisk, quitSafari, safariRunning } from "./host";
import { identityFromCapabilities, readIdentity, writeIdentity } from "./identity";
import {
  beginTurn,
  finishGeneration,
  firstRun,
  lastReply,
  newestGenerationId,
  reopenChat,
  replaceTab,
  sendTurn,
  startNewConversation,
  stopMidReply,
  type SafariChat,
} from "./page";
import { startStubApi, type StubApi } from "./stub-api";
import { artefactName, safariLaneConfig } from "./target";
import { createSession, driverReady, isSessionDeath, type SafariSession } from "./webdriver";

const CONFIG = safariLaneConfig();
const ARTEFACTS = reportArtefacts(artefactName(CONFIG.target));

/**
 * The model this device is served: desktop Safari gets Eco Compact; an iPhone
 * gets Eco Mobile. Both slots hold it (catalog tiers `safari-desktop` and
 * `webkit-mobile`), so the walk binds the everyday slot, as the app does.
 */
const PICK: Pick = CONFIG.target === "mac" ? ECO_COMPACT_WEBLLM : ECO_MOBILE_WEBLLM;

const REPORT_OPTIONS = () => ({
  smoke: CONFIG.narrowed,
  tasks: CONFIG.tasks,
  ...(readIdentity(ARTEFACTS) ? { browser: readIdentity(ARTEFACTS) } : {}),
});

const log = (line: string) => console.log(`  ${line}`);

/**
 * The same file check the Chrome lane's WebLLM run makes before it waits on a
 * download: each sampled file from the model host or, failing that, the
 * app's own proxy. A file neither serves stops the walk in seconds, by URL.
 */
async function checkPickFiles(pick: Pick): Promise<string[]> {
  const host = acceptanceModelHost();
  const artifact = artifactFor(catalogData, pick.modelId);
  if (!artifact) throw new Error(`${pick.modelId} has no artifact in the catalog`);
  const files = sampleFiles(artifact).map((file) => ({
    file,
    hostUrl: host ? modelFileUrl(artifact, file, host, CONFIG.baseUrl) : null,
    proxyUrl: modelFileUrl(artifact, file, "", CONFIG.baseUrl),
  }));
  return checkModelFilesServed(pick, files, MODEL_HOST_REMEDY);
}

/**
 * The server is this lane's: a harness build whose `API_URL` is the stub.
 * A search request sent from here must arrive at the stub through the app's
 * own proxy; if it does not, every auth and search answer in the walk would
 * come from somewhere else, so the walk does not start.
 */
async function checkServerUsesStub(stub: StubApi): Promise<void> {
  stub.reset();
  let status: string;
  try {
    const response = await fetch(`${CONFIG.baseUrl}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: CONFIG.baseUrl },
      body: JSON.stringify({ q: "lane preflight" }),
      signal: AbortSignal.timeout(15_000),
    });
    status = String(response.status);
  } catch (error) {
    status = `unreachable (${error instanceof Error ? error.message : String(error)})`;
  }
  const seen = stub.calls().length;
  stub.reset();
  if (seen !== 1) {
    throw new Error(
      `${CONFIG.baseUrl} did not forward /v1/search to the stub on 127.0.0.1:${stub.port} (status ${status}). `
        + `Start the server with API_URL=http://127.0.0.1:${stub.port} — see the README.`,
    );
  }
}

test.describe("Safari acceptance walk", () => {
  /** The walk currently running, so a death outside a task can still be recorded. */
  let currentWalk: PickReport | null = null;

  // Playwright's "no fixtures" form, as in the Chrome spec: this lane uses no
  // Playwright browser at all.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(({}, testInfo) => {
    const walk = currentWalk;
    currentWalk = null;
    if (!walk || testInfo.status === testInfo.expectedStatus) return;
    walk.abortedAt = {
      task: 0,
      reason: clip(testInfo.error?.message ?? `test ended ${testInfo.status ?? "unknown"}`, 300),
    };
    walk.rows.push({
      task: 0,
      turn: 0,
      label: "the walk itself did not finish",
      modelId: walk.modelId,
      firstTokenMs: null,
      kvReason: null,
      result: "FAIL",
      evidence: `walk ended ${testInfo.status ?? "unknown"}: ${clip(
        testInfo.error?.message ?? "no error message",
        300,
      )}`,
    });
    walk.finishedAt = new Date().toISOString();
    writePickFragment(walk, ARTEFACTS);
  });

  test(`${PICK.tileName} — Safari (${CONFIG.target}) tasks ${CONFIG.tasks.join(",")} walk`, async () => {
    test.setTimeout(5_400_000);
    if (CONFIG.target === "ios") {
      throw new Error("ECO_SAFARI_TARGET=ios is not wired yet: the iPhone needs the harness on a LAN host first.");
    }

    const pickReport: PickReport = {
      order: 0,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      modelId: PICK.modelId,
      label: PICK.tileName,
      slot: PICK.slot,
      rows: [],
    };
    currentWalk = pickReport;
    writePickFragment(pickReport, ARTEFACTS);

    const push = (row: AcceptanceRow) => {
      pickReport.rows.push(row);
      pickReport.finishedAt = new Date().toISOString();
      writePickFragment(pickReport, ARTEFACTS);
      log(`task ${row.task}.${row.turn} ${row.result} — ${row.label}: ${clip(row.evidence, 90)}`);
    };

    const rowFor = (
      task: number,
      turn: number,
      label: string,
      outcome: TurnOutcome,
      { result, evidence }: Verdict,
    ): AcceptanceRow => {
      const receipt = outcomeReceipt(outcome);
      return {
        task,
        turn,
        label,
        modelId: receipt?.modelId ?? PICK.modelId,
        firstTokenMs: receipt?.firstTokenMs ?? null,
        kvReason: kvReasonOf(receipt),
        result,
        evidence,
      };
    };

    // ── Preflight: nothing launches until every check holds ───────────────
    if (!(await driverReady(CONFIG.driverUrl))) {
      throw new Error(`safaridriver is not ready at ${CONFIG.driverUrl}: start it with \`safaridriver -p 4444\`.`);
    }
    if (safariRunning()) {
      throw new Error("Safari is already running — it may be someone's own browsing. Quit it by hand and rerun.");
    }
    await guardDisk("before launch", log);
    const stub = await startStubApi(CONFIG.stubPort);
    let session: SafariSession | null = null;
    let launched = false;
    try {
      await checkServerUsesStub(stub);
      const notes = await checkPickFiles(PICK);
      if (notes.length > 0) {
        pickReport.notes = notes;
        writePickFragment(pickReport, ARTEFACTS);
      }

      launched = true;
      session = await createSession(CONFIG.driverUrl, { browserName: "safari" });
      const identity = identityFromCapabilities(CONFIG.target, session.capabilities);
      writeIdentity(ARTEFACTS, identity);
      log(`session ${session.id}: Safari ${identity.version}`);
      const chat: SafariChat = { session, target: CONFIG.target, baseUrl: CONFIG.baseUrl, log };

      // ONE tab for the whole walk, as in the Chrome lane. The first `open()`
      // is the genuine first run; later ones start a fresh conversation, or
      // land on chat again in a replacement tab after a failure.
      let tab: "blank" | "chat" | "replaced" = "blank";
      let firstRunMs: number | null = null;
      const open = async (): Promise<void> => {
        if (tab === "blank") {
          firstRunMs = await firstRun(chat, PICK);
        } else if (tab === "replaced") {
          await reopenChat(chat, PICK);
        } else {
          await startNewConversation(chat);
        }
        tab = "chat";
      };
      const retireWalkTab = async (): Promise<void> => {
        await replaceTab(chat);
        tab = "replaced";
      };

      /** Did this turn answer — the same rule as the Chrome lane, with the error card read here. */
      const answered = async (outcome: TurnOutcome) =>
        judgeAnswered(outcome, (await lastReply(chat)).errorCard);

      /**
       * Run one task, turning a thrown error into a FAIL row. A dead session
       * ends the walk: every later step would fail the same way, and the
       * report should name where it died, once.
       */
      let deadAt: number | null = null;
      const task = async (number: number, label: string, body: () => Promise<void>): Promise<void> => {
        if (!CONFIG.tasks.includes(number) || deadAt !== null) return;
        try {
          await guardDisk(`task ${number}`, log);
          await body();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          push({
            task: number,
            turn: 0,
            label,
            modelId: PICK.modelId,
            firstTokenMs: null,
            kvReason: null,
            result: "FAIL",
            evidence: `task threw: ${clip(message, 300)}`,
          });
          if (isSessionDeath(error)) {
            deadAt = number;
            pickReport.abortedAt = {
              task: number,
              reason: "the WebDriver session ended (a killed tab ends it on Safari); read `log show` for the WebContent process",
            };
            writePickFragment(pickReport, ARTEFACTS);
          }
        }
      };

      // ── 1. Cold first run to first reply, no dead ends ──────────────────
      await task(1, "cold first run to a first reply", async () => {
        await open();
        const outcome = await sendTurn(chat, FIRST_RUN_PROMPT);
        push(rowFor(1, 1, "first reply on a cold start", outcome, judgeFirstReply(outcome, firstRunMs ?? 0)));
      });

      // ── 2. Ten-turn budgeting chat: a running total and a recall ────────
      await task(2, "ten-turn budgeting chat", async () => {
        await open();
        for (const [index, prompt] of BUDGET_TURNS.entries()) {
          const turn = index + 1;
          const outcome = await sendTurn(chat, prompt);
          push(
            rowFor(2, turn, `turn ${turn}: ${clip(prompt, 48)}`, outcome, judgeBudgetTurn(turn, prompt, outcome)),
          );
        }
      });

      // ── 12. Stop mid-reply, then send the next message ──────────────────
      await task(12, "Stop mid-reply, then the next message answers", async () => {
        await open();
        const prompt = STOP_PROMPT;
        const before = await newestGenerationId(chat);
        await beginTurn(chat, prompt);
        const stop = await stopMidReply(chat);
        if (!stop.stopped) {
          push({
            task: 12,
            turn: 1,
            label: "Stop pressed mid-reply",
            modelId: PICK.modelId,
            firstTokenMs: null,
            kvReason: null,
            ...judgeStopNotPressed(stop.reason),
          });
          return;
        }

        const stopped = await finishGeneration(chat, prompt, before, STOPPED_RECEIPT_TIMEOUT_MS);
        const reply = await lastReply(chat);
        const kept = reply.text.replace(reply.stoppedNotice, "").trim();
        push(
          rowFor(
            12,
            1,
            "Stop pressed mid-reply",
            stopped,
            judgeStopped(stopped, {
              settledMs: stop.settledMs,
              noticeText: reply.stoppedNotice,
              tryAgainOffered: reply.tryAgainOffered,
              kept,
            }),
          ),
        );

        const next = await sendTurn(chat, AFTER_STOP_PROMPT, LONG_TURN_TIMEOUT_MS);
        const check = await answered(next);
        push(rowFor(12, 2, "the next message after a Stop answers", next, judgeFollowUp(next, check)));
        if (!check.ok) await retireWalkTab();
      });
    } finally {
      if (session !== null) await session.end();
      await stub.close();
      if (launched && CONFIG.target === "mac") {
        const quit = await quitSafari();
        log(quit ? "Safari quit (checked)" : "SAFARI IS STILL RUNNING — quit it by hand");
        if (!quit) {
          push({
            task: 0,
            turn: 0,
            label: "Safari quit after the run (checked)",
            modelId: PICK.modelId,
            firstTokenMs: null,
            kvReason: null,
            result: "FAIL",
            evidence: "Safari was still running 50 s after the session ended and a quit was requested; quit it by hand",
          });
        }
      }
      pickReport.finishedAt = new Date().toISOString();
      writePickFragment(pickReport, ARTEFACTS);
      currentWalk = null;
    }
  });

  /** The exit status follows the report, as in the Chrome lane. */
  test("the walk produced a table, and nothing failed that was not expected to", () => {
    const { report, markdownPath } = assembleReport(REPORT_OPTIONS(), ARTEFACTS);
    console.log(`\nSafari acceptance report: ${markdownPath}`);
    expect(report.picks.length, "the report carries no table for the walked model").toBe(1);
    const failures = report.picks.flatMap((entry) =>
      entry.rows
        .filter((row) => row.result === "FAIL")
        .map((row) => `${entry.label} task ${row.task}.${row.turn} — ${row.label}: ${clip(row.evidence, 120)}`),
    );
    expect(failures, `the walk recorded failures; the full table is in ${markdownPath}`).toEqual([]);
  });
});
