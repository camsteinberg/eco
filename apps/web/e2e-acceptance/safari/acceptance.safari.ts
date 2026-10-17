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
  AFTER_RETRY_PROMPT,
  AFTER_STOP_PROMPT,
  BUDGET_TURNS,
  CONTEXT_MAX_TURNS,
  CONTEXT_PROMPT,
  ECO_COMPACT_WEBLLM,
  ECO_MOBILE_WEBLLM,
  EDIT_LATER_PROMPT,
  EDIT_ORIGINAL_PROMPT,
  EDIT_REPLACEMENT_PROMPT,
  EMAIL_BRIEF,
  FAULT_PROMPT,
  FIRST_RUN_PROMPT,
  KILL_NOT_STARTED,
  KILL_PROMPT,
  LONG_TURN_TIMEOUT_MS,
  LOOKUP_QUESTION,
  RECALL_PROMPT,
  REOPEN_PROMPT,
  SEARCH_QUESTION,
  SHORTER_PROMPT,
  STOPPED_RECEIPT_TIMEOUT_MS,
  STOP_PROMPT,
  SUMMARY_PROMPT,
  TOOL_CASES,
  judgeAnswered,
  judgeBudgetTurn,
  judgeContextNeverShown,
  judgeContextTurn,
  judgeDraft,
  judgeEdit,
  judgeFirstReply,
  judgeFollowUp,
  judgeInjectedFailure,
  judgeLookupsOff,
  judgeLookupsOn,
  judgeRecall,
  judgeReopened,
  judgeRetry,
  judgeSearchChip,
  judgeSearchOff,
  judgeSearchRequest,
  judgeShorter,
  judgeStopNotPressed,
  judgeStopped,
  judgeSummary,
  judgeToolCard,
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
  ASSISTANT_MESSAGES,
  CHAT_LOG,
  USER_MESSAGES,
  allTextsInPage,
  armGenerationFault,
  beginTurn,
  count,
  countInPage,
  editUserMessage,
  finishGeneration,
  firstRun,
  firstTextInPage,
  generationFaultArmed,
  lastAttributeInPage,
  lastReply,
  lookupRequestsInPage,
  newestGenerationId,
  pressTryAgain,
  reopenChat,
  replaceTab,
  resetResourceTimingsInPage,
  sendTurn,
  setWebLookupsInTab,
  setWebSearchInTab,
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
 * What task 9's request count is: the page's own resource timings. The Chrome
 * lane watches the network; Safari offers no observer, so the row says which
 * witness it rests on.
 */
const LOOKUP_WITNESS = "lookup requests read from the page's own resource timings, not a network observer";

/** The same verdict, with a note on how its evidence was gathered. */
const noting = (verdict: Verdict, note: string): Verdict => ({ ...verdict, evidence: `${verdict.evidence}; ${note}` });

const SOURCE_CARDS = `${CHAT_LOG} [data-testid="grounding-citation"]`;
const WEB_SEARCH_CHIPS = `${CHAT_LOG} [data-testid="web-search-citation"]`;
const NO_LIVE_DATA_NOTES = `${CHAT_LOG} [data-testid="uncertainty-note"][data-status="no-live-data"]`;
const CONTEXT_DIVIDER = `${CHAT_LOG} [role="note"][aria-label="Context window boundary"]`;
const CONTEXT_NOTICE = '[data-testid="context-window-notice"]';

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

      // ── 3. Paste ~2 pages, ask for a summary ────────────────────────────
      await task(3, "summarise a pasted document", async () => {
        await open();
        const outcome = await sendTurn(chat, SUMMARY_PROMPT, LONG_TURN_TIMEOUT_MS);
        push(rowFor(3, 1, "summary of a ~4,400-character paste", outcome, judgeSummary(outcome)));
      });

      // ── 4. The exact-answer tools ───────────────────────────────────────
      await task(4, "tool cards show the right answer", async () => {
        await open();
        for (const [index, item] of TOOL_CASES.entries()) {
          const outcome = await sendTurn(chat, item.prompt);
          push(
            rowFor(4, index + 1, `tool card for "${item.prompt}"`, outcome, judgeToolCard(outcome, item.expect)),
          );
        }
      });

      // ── 5. Draft an email, then shorten it ──────────────────────────────
      await task(5, "draft an email, then shorten it", async () => {
        await open();
        const first = await sendTurn(chat, EMAIL_BRIEF, LONG_TURN_TIMEOUT_MS);
        push(rowFor(5, 1, "draft from three bullet points", first, judgeDraft(first)));
        const second = await sendTurn(chat, SHORTER_PROMPT, LONG_TURN_TIMEOUT_MS);
        push(rowFor(5, 2, "shortened on request", second, judgeShorter(first, second)));
      });

      // ── 6. Long chat until the context boundary is admitted ─────────────
      await task(6, "context boundary is shown honestly", async () => {
        await open();
        const maxTurns = CONTEXT_MAX_TURNS;
        let announced = false;
        for (let turn = 1; turn <= maxTurns && !announced; turn++) {
          const outcome = await sendTurn(chat, CONTEXT_PROMPT, LONG_TURN_TIMEOUT_MS);
          const dividerCount = await count(chat, CONTEXT_DIVIDER);
          const noticeCount = await count(chat, CONTEXT_NOTICE);
          announced = dividerCount > 0 || noticeCount > 0;
          const copy = announced
            ? ((await chat.session.run(firstTextInPage, dividerCount > 0 ? CONTEXT_DIVIDER : CONTEXT_NOTICE)) ?? "")
            : "";
          push(
            rowFor(
              6,
              turn,
              `paste turn ${turn} of at most ${maxTurns}`,
              outcome,
              judgeContextTurn(outcome, announced, copy),
            ),
          );
        }
        if (!announced) {
          push({
            task: 6,
            turn: maxTurns + 1,
            label: "context boundary never appeared",
            modelId: PICK.modelId,
            firstTokenMs: null,
            kvReason: null,
            ...judgeContextNeverShown(maxTurns),
          });
        }
      });

      // ── 9. A factual question, lookups off then on ──────────────────────
      // The Chrome lane counts lookup requests on the network. Safari has no
      // observer, so the page's own resource timings are the witness, and
      // each row says so.
      await task(9, "web lookups off, then on", async () => {
        await open();
        await chat.session.run(resetResourceTimingsInPage);
        const off = await sendTurn(chat, LOOKUP_QUESTION);
        const firedOff = (await count(chat, SOURCE_CARDS)) > 0;
        const offRequests = await chat.session.run(lookupRequestsInPage);
        push(
          rowFor(
            9,
            1,
            "lookups off: nothing should fire",
            off,
            noting(judgeLookupsOff(off, firedOff, offRequests), LOOKUP_WITNESS),
          ),
        );

        // Flip it in THIS tab and read it back after a reload (see page.ts).
        // Returning to chat lands /chat again, so the timings start empty.
        const lookupsOn = await setWebLookupsInTab(chat, true, PICK);
        await startNewConversation(chat);
        await chat.session.run(resetResourceTimingsInPage);
        const on = await sendTurn(chat, LOOKUP_QUESTION, LONG_TURN_TIMEOUT_MS);
        const sourceCard = await count(chat, SOURCE_CARDS);
        const onRequests = await chat.session.run(lookupRequestsInPage);
        push(
          rowFor(
            9,
            2,
            "lookups on: a source card should appear",
            on,
            noting(judgeLookupsOn(on, sourceCard, lookupsOn, onRequests), LOOKUP_WITNESS),
          ),
        );

        // Leave the device as we found it — lookups are off by default.
        await setWebLookupsInTab(chat, false, PICK);
      });

      // ── 10. Close the tab mid-generation, reopen ────────────────────────
      // As in the Chrome lane the walk's own tab is closed mid-reply. A
      // spare tab is opened first, because closing a session's only tab
      // ends the session; the walk then opens chat in the spare.
      await task(10, "no wedge after a tab dies mid-reply", async () => {
        await open();
        await beginTurn(chat, KILL_PROMPT, KILL_NOT_STARTED);
        await retireWalkTab();
        await open();
        const outcome = await sendTurn(chat, REOPEN_PROMPT, LONG_TURN_TIMEOUT_MS);
        push(rowFor(10, 1, "chat works after a mid-reply tab kill", outcome, judgeReopened(outcome)));
      });

      // ── 11. A live question, Web search off then on ─────────────────────
      // The relay is the lane's stub, behind the app's own /v1 proxy, for both
      // arms; a request the OFF arm should never have made lands there too.
      await task(11, "a live question, Web search off then on", async () => {
        await open();
        const settledOff = await setWebSearchInTab(chat, false, PICK);
        stub.reset();
        const off = await sendTurn(chat, SEARCH_QUESTION, LONG_TURN_TIMEOUT_MS);
        const offNotes = await count(chat, NO_LIVE_DATA_NOTES);
        const offCalls = stub.calls();
        const offChips = await count(chat, WEB_SEARCH_CHIPS);
        push(
          rowFor(
            11,
            1,
            "Web search off: the honest note, and nothing sent",
            off,
            judgeSearchOff(off, { notes: offNotes, calls: offCalls, chips: offChips, settledOff }),
          ),
        );

        const settledOn = await setWebSearchInTab(chat, true, PICK);
        const composerSwitch =
          (await chat.session.run(lastAttributeInPage, '[data-testid="web-search-toggle"]', "aria-checked"))
          ?? "(absent)";
        await startNewConversation(chat);
        stub.reset();
        const on = await sendTurn(chat, SEARCH_QUESTION, LONG_TURN_TIMEOUT_MS);
        push(
          rowFor(
            11,
            2,
            "Web search on: one request, carrying only the question as typed",
            on,
            judgeSearchRequest({ calls: stub.calls(), settledOn, composerSwitch }),
          ),
        );

        const chipCount = await count(chat, WEB_SEARCH_CHIPS);
        const fetchedAt =
          chipCount > 0 ? await chat.session.run(lastAttributeInPage, WEB_SEARCH_CHIPS, "data-fetched-at") : null;
        push(
          rowFor(
            11,
            3,
            "Web search on: the reply is marked with a fetched-at chip",
            on,
            judgeSearchChip(off, on, { chipCount, fetchedAt, settledOn }),
          ),
        );

        // Leave the device as we found it — Web search is off by default.
        await setWebSearchInTab(chat, false, PICK);
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

      // ── 13. A reply fails part-way; Try again answers ───────────────────
      await task(13, "a failed reply, then Try again answers", async () => {
        await open();
        const prompt = FAULT_PROMPT;
        await armGenerationFault(chat);
        const failed = await sendTurn(chat, prompt, LONG_TURN_TIMEOUT_MS);
        const stillArmed = await generationFaultArmed(chat);
        const reply = await lastReply(chat);
        const offered = reply.tryAgainOffered;
        const card = offered ? clip(reply.text, 120) : "";
        const failure = judgeInjectedFailure(failed, { stillArmed, offered, card });
        push(rowFor(13, 1, "a reply fails part-way, and Try again is offered", failed, failure));
        if (!failure.ourFault || !offered) {
          await retireWalkTab();
          return;
        }

        const assistantBubbles = await count(chat, ASSISTANT_MESSAGES);
        const before = await newestGenerationId(chat);
        if (!(await pressTryAgain(chat))) throw new Error("Try again was offered but could not be pressed");
        const retried = await finishGeneration(chat, prompt, before, LONG_TURN_TIMEOUT_MS);
        const check = await answered(retried);
        const askedOnce =
          (await chat.session.run(allTextsInPage, USER_MESSAGES)).filter((text) => text.includes(prompt)).length === 1;
        const replacedInPlace = (await count(chat, ASSISTANT_MESSAGES)) === assistantBubbles;
        push(rowFor(13, 2, "Try again answers", retried, judgeRetry(retried, check, { askedOnce, replacedInPlace })));
        if (!check.ok) {
          await retireWalkTab();
          return;
        }

        const after = await sendTurn(chat, AFTER_RETRY_PROMPT, LONG_TURN_TIMEOUT_MS);
        const afterCheck = await answered(after);
        push(
          rowFor(13, 3, "the conversation carries on after the retry", after, judgeFollowUp(after, afterCheck)),
        );
      });

      // ── 14. Edit an earlier message and resend ──────────────────────────
      // The same witness as the Chrome lane: the reply to the edited message
      // itself, then a recall (see `judgeEdit` and `judgeRecall`).
      await task(14, "edit an earlier message and resend", async () => {
        await open();
        await sendTurn(chat, EDIT_ORIGINAL_PROMPT);
        await sendTurn(chat, EDIT_LATER_PROMPT);

        const before = await newestGenerationId(chat);
        await editUserMessage(chat, 0, EDIT_REPLACEMENT_PROMPT);
        const edited = await finishGeneration(chat, EDIT_REPLACEMENT_PROMPT, before, LONG_TURN_TIMEOUT_MS);
        const check = await answered(edited);
        const userTexts = await chat.session.run(allTextsInPage, USER_MESSAGES);
        const oneReply = (await count(chat, ASSISTANT_MESSAGES)) === 1;
        const versionsShown =
          (await chat.session.run(countInPage, 'button[aria-label="Previous version"]', USER_MESSAGES, 0)) > 0;
        push(
          rowFor(
            14,
            1,
            "the edited message is resent and answered",
            edited,
            judgeEdit(edited, check, { userTexts, oneReply, versionsShown }),
          ),
        );

        const recall = await sendTurn(chat, RECALL_PROMPT);
        push(rowFor(14, 2, "the conversation continues from the edit", recall, judgeRecall(recall)));
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
