// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The fourteen-task acceptance walk, on both shipping models, in a real browser.
 *
 * Run at session open whenever a serving-path or tool change merged last
 * session, and at every phase end.
 *
 * What it is: the scripted walkthrough a person would do before saying the
 * product is usable — a cold first run, a ten-turn conversation that has to
 * remember a number, a pasted document, the exact-answer tools, an edit
 * request, a conversation long enough to move the context window, an offline
 * reload, a model switch, a factual question with and without web lookups, a
 * question about right now with and without Web search, a tab killed
 * mid-reply, and the three things a person does mid-conversation: press Stop
 * and carry on, press Try again after a reply fails, and edit an earlier
 * message. It runs against a PRODUCTION build with real inference on the
 * machine's own GPU.
 *
 * `ECO_ACCEPTANCE_RUNTIME=webllm` walks the app's WebLLM models instead — the
 * ones it serves desktop Safari — on tasks 1, 12, 13 and 14 by default. Real
 * Chrome presents desktop Safari's user agent to get there.
 *
 * The run's exit status follows the report: any FAIL row ends the run red.
 * Only an EXPECTED-FAIL is allowed to pass, because it names a gap that is
 * already known. No task claims one today.
 *
 * What it is not: a scorer. Tasks whose quality only a person can judge are
 * recorded with the reply text and, where one exists, a mechanical check
 * (does the tenth reply still contain the rent figure; is the shortened draft
 * shorter). This file does not invent a quality rubric, and it does not fail
 * the run on a gap that is known and tracked. The offline reload used to be
 * recorded that way; since the worker captures the chat shell it is a real
 * PASS/FAIL row.
 *
 * Cost: two model downloads on a cold profile (~0.8 GB and ~1.7 GB), then
 * every turn is real generation. Budget the better part of an hour per model.
 * It is opt-in for that reason — `pnpm --filter @eco/web test:acceptance`,
 * never `pnpm qa` and never CI.
 */

import {
  expect,
  test,
  chromium,
  firefox,
  webkit,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { join } from "node:path";
import {
  assistantMessages,
  composer,
  setWebBaseUrl,
  stubAuth,
} from "../e2e-perf/lib/session";
import catalogData from "../src/local-ai/catalog/catalog-data.json";
import {
  MODEL_HOST_REMEDY,
  acceptanceModelHost,
  artifactFor,
  modelFileUrl,
  sampleFiles,
} from "./lib/model-host";
import { shellCapturedInPage } from "./lib/in-page";
import {
  assembleReport,
  clip,
  writePickFragment,
  type AcceptanceRow,
  type PickReport,
} from "./lib/report";
import {
  acceptancePlan,
  planPicks,
  planWalksTask,
} from "./lib/subset";
import {
  AFTER_RETRY_PROMPT,
  AFTER_STOP_PROMPT,
  BUDGET_TURNS,
  CONTEXT_MAX_TURNS,
  CONTEXT_PROMPT,
  ECO_COMPACT_WEBLLM,
  ECO_DEEPER,
  ECO_FAST,
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
  OFFLINE_PROMPT,
  RECALL_PROMPT,
  REOPEN_PROMPT,
  SEARCH_QUESTION,
  SHORTER_PROMPT,
  STOPPED_RECEIPT_TIMEOUT_MS,
  STOP_PROMPT,
  SUMMARY_PROMPT,
  SWITCH_BACK_PROMPT,
  SWITCH_PROMPT,
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
  judgeOfflineReload,
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
  judgeSwitch,
  judgeToolCard,
  type Verdict,
} from "./lib/tasks";
import {
  armGenerationFault,
  beginTurn,
  checkModelFilesServed,
  citations,
  contextDivider,
  contextWindowNotice,
  editUserMessage,
  finishGeneration,
  generationFaultArmed,
  kvReasonOf,
  newestGenerationId,
  openChatOnModel,
  outcomeReceipt,
  provisionBySeeding,
  provisionPick,
  sendTurn,
  setDeviceQuery,
  setWebLookupsInTab,
  setWebSearchInTab,
  startNewConversation,
  stopMidReply,
  stubSearchRelay,
  switchTo,
  tryAgainOn,
  uncertaintyNotes,
  userMessages,
  waitForUsableChat,
  watchLookupRequests,
  webSearchCitations,
  webSearchToggle,
  welcomeCard,
  wipeOrigin,
  type Pick,
  type TurnOutcome,
} from "./lib/walk";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3120";

/**
 * Full walk, the ten-minute self-test (`ECO_ACCEPTANCE_SMOKE=1`), an explicit
 * task list (`ECO_ACCEPTANCE_TASKS=2,4`), or a WebLLM run
 * (`ECO_ACCEPTANCE_RUNTIME=webllm`).
 *
 * Both models are still PROVISIONED either way — task 8 needs somewhere to
 * switch to — but a narrowed run walks only `WALK_PICKS` and only the tasks
 * the plan names. See `lib/subset`.
 */
const PLAN = acceptancePlan();
const WEBLLM = PLAN.runtime === "webllm";
/**
 * `ECO_ACCEPTANCE_BROWSER=chrome|firefox|webkit` picks the engine. Chrome is
 * the shipping path; Firefox and WebKit are Playwright's own builds, read to
 * learn what a non-Chromium browser gets (a notice and a fallback, or a load),
 * not to grade the product. Each engine keeps its own profile so a Chrome
 * model cache never masquerades as a WebKit one.
 */
const BROWSER = (process.env.ECO_ACCEPTANCE_BROWSER?.trim() || "chrome") as
  | "chrome"
  | "firefox"
  | "webkit";
if (WEBLLM && BROWSER !== "chrome") {
  throw new Error("ECO_ACCEPTANCE_RUNTIME=webllm runs in real Chrome only; unset ECO_ACCEPTANCE_BROWSER.");
}
/** The WebLLM run keeps its own profile, so its models never mix with the ONNX walk's cache. */
const PROFILE_DIR =
  process.env.ECO_ACCEPTANCE_PROFILE_DIR
  ?? join(
    __dirname,
    WEBLLM
      ? ".browser-profile-webllm"
      : BROWSER === "chrome"
        ? ".browser-profile"
        : `.browser-profile-${BROWSER}`,
  );

/**
 * What Chrome presents in a WebLLM run: desktop Safari's user agent. The app
 * classifies the browser from it and routes to the models it serves Safari,
 * which run on WebLLM, while the GPU underneath is Chrome's real WebGPU.
 */
const DESKTOP_SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/26.4 Safari/605.1.15";

// The picks themselves (ids, slots, tile and friendly names) live in
// `lib/tasks`, shared with every walk that judges by the same rules.
const PICKS: readonly Pick[] = WEBLLM
  ? [ECO_COMPACT_WEBLLM, ECO_MOBILE_WEBLLM]
  : [ECO_FAST, ECO_DEEPER];

/**
 * The slots a walk binds. The ONNX picks sit in different slots, so both are
 * bound and task 8 can switch between them; the WebLLM picks share one slot,
 * so each walk binds only its own.
 */
const bindingsFor = (pick: Pick): readonly Pick[] => (WEBLLM ? [pick] : PICKS);

/**
 * What provisioning noticed about each model — files the model host is
 * missing that the app fetched through its own proxy — handed to that
 * model's walk so the report carries it next to the model's table.
 */
const provisioningNotes = new Map<string, string[]>();

/**
 * `ECO_ACCEPTANCE_SLOT=eco-smart` picks WHICH model walks, instead of the
 * plan's default of the everyday pick; an unknown slot walks nothing, which is
 * the visible failure we want rather than a silent fallback to both.
 */
const SLOT_FILTER = process.env.ECO_ACCEPTANCE_SLOT?.trim();
const WALK_LABEL = (process.env.ECO_ACCEPTANCE_TASKS?.trim() || WEBLLM)
  ? `tasks ${PLAN.tasks.join(",")}`
  : PLAN.smoke
    ? "smoke subset"
    : "fourteen-task";
const WALK_PICKS: readonly Pick[] = SLOT_FILTER
  ? PICKS.filter((pick) => pick.slot === SLOT_FILTER)
  : planPicks(PLAN, PICKS);

/**
 * Deliberately NOT `mode: "serial"`. The lane runs one worker with parallelism
 * off, so the tests already execute in order — what serial mode would add is
 * SKIPPING every later test once one fails, and that is how the second run of
 * this lane lost a whole shipping model: the first walk ended red on a
 * recorded failure and the second walk never ran, leaving the report with no
 * section for it at all. A model that silently vanishes from the report is the
 * same defect as a green run with failures in its table.
 */

test.describe("acceptance walk", () => {
  let context: BrowserContext;
  /** The walk currently running, so a death outside a task can still be recorded. */
  let currentWalk: PickReport | null = null;

  test.beforeAll(async () => {
    setWebBaseUrl(BASE_URL);
    const engine = BROWSER === "firefox" ? firefox : BROWSER === "webkit" ? webkit : chromium;
    context = await engine.launchPersistentContext(PROFILE_DIR, {
      ...(BROWSER === "chrome" ? { channel: "chrome" } : {}),
      headless: false,
      // Let the app lay out to the real window. Playwright otherwise emulates a
      // fixed 1280x720 viewport inside a taller window, so the `h-dvh` shell
      // renders short and the run looks broken to anyone watching it.
      viewport: null,
      ...(WEBLLM ? { userAgent: DESKTOP_SAFARI_USER_AGENT } : {}),
    });
    // The forced profile names the browser class, which would override the
    // Safari user agent; a WebLLM run lets the browser describe itself.
    if (WEBLLM) setDeviceQuery("");
    await stubAuth(context);
  });

  /**
   * A walk that dies anywhere still leaves a row saying so.
   *
   * Individual tasks already turn their own failures into rows, but a test can
   * also die outside any of them — a Playwright-level timeout being the case a
   * try/catch inside the test would never see. Without this, such a walk
   * contributes an empty table and the report reads as though the model was
   * never meant to be walked.
   */
  // Playwright's "no fixtures" form. A plain parameter here would ask for
  // every fixture, including a browser this lane does not use.
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
    writePickFragment(walk);
  });

  test.afterAll(async () => {
    // Assembled from the fragments on disk, so this is the WHOLE run even when
    // an earlier walk ran in a worker that has since been replaced.
    const paths = assembleReport({ smoke: PLAN.smoke, tasks: PLAN.tasks, runtime: PLAN.runtime });
    console.log(`\nacceptance report: ${paths.jsonPath}\n                   ${paths.markdownPath}`);
    await context?.close();
  });

  /**
   * Cold device, then both models present.
   *
   * The wipe is what makes the first walk's task 1 a genuine first run. Both
   * models are then fetched through the switcher's own two-step flow, which is
   * the path a person takes — and which has to work before the per-model walks
   * can bind a slot and expect the bytes to be there.
   */
  test(WEBLLM ? "both WebLLM models provisioned" : "cold profile, both shipping models provisioned", async () => {
    test.setTimeout(3_600_000);
    if (WEBLLM) {
      // Each model's files are checked before anything waits on them, by the
      // app's own rule: the model host first, then — for a file the host is
      // missing — the app's own proxy, which the app falls back to. Only a file
      // neither serves fails here, in seconds and by name, rather than as a
      // download timeout; a file only the proxy serves is noted in the report.
      const host = acceptanceModelHost();
      console.log(`  model host: ${host || "(none — the app's own model proxy)"}`);
      for (const pick of PICKS) {
        const artifact = artifactFor(catalogData, pick.modelId);
        if (!artifact) throw new Error(`${pick.modelId} has no artifact in the catalog`);
        const files = sampleFiles(artifact).map((file) => ({
          file,
          hostUrl: host ? modelFileUrl(artifact, file, host, BASE_URL) : null,
          proxyUrl: modelFileUrl(artifact, file, "", BASE_URL),
        }));
        const notes = await checkModelFilesServed(pick, files, MODEL_HOST_REMEDY);
        notes.push(...(await provisionBySeeding(context, pick, MODEL_HOST_REMEDY)));
        provisioningNotes.set(pick.modelId, notes);
        for (const note of notes) console.log(`  ${pick.tileName}: note — ${note}`);
        console.log(`  ${pick.tileName} (${pick.modelId}): ready`);
      }
      return;
    }
    if (PLAN.wipesOrigin) {
      const bootstrap = await context.newPage();
      await bootstrap.goto(`${BASE_URL}/`, { waitUntil: "commit" });
      await wipeOrigin(context, bootstrap);
      await bootstrap.close();
    } else {
      // A smoke run keeps whatever the profile already has: the wipe would
      // re-download both models, and no ten-minute self-test survives that.
      console.log("  smoke subset: keeping the existing profile, no origin wipe");
    }

    // No slot binding here on purpose: this is the app's own first-run setup,
    // choosing and fetching a model for this device without being told which.
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/chat?eco-force-capability=webgpu&eco-force-browser=chromium&eco-force-platform=desktop&eco-force-device-memory=16`, {
      waitUntil: "commit",
    });
    // Answering the first-run choice with the everyday pick keeps the run to
    // the two downloads it needs: setup fetches Eco Fast, the switcher fetches
    // Eco Deeper.
    await waitForUsableChat(page, ECO_FAST.tileName);
    const afterSetup = await page.evaluate(
      () => window.__ecoPerf?.activeModelId() ?? null,
    );
    console.log(`  first-run setup landed on ${afterSetup ?? "(nothing resident)"}`);

    for (const pick of PICKS) {
      const how = await provisionPick(page, pick);
      console.log(`  ${pick.tileName} (${pick.modelId}): ${how}`);
    }
    await page.close();
  });

  // `WALK_PICKS`, not `PICKS`: a smoke run walks one model. `others` stays
  // derived from `PICKS`, because task 8 switches to a model it does not walk.
  for (const pick of WALK_PICKS) {
    const others = PICKS.filter((entry) => entry.modelId !== pick.modelId);

    // The title says what actually ran; a smoke run is not an eleven-task walk,
    // and an explicit task list is neither — it names its tasks.
    test(`${pick.tileName} — ${WALK_LABEL} walk`, async () => {
      test.setTimeout(5_400_000);
      const pickReport: PickReport = {
        order: PICKS.indexOf(pick),
        startedAt: new Date().toISOString(),
        finishedAt: "",
        modelId: pick.modelId,
        label: pick.tileName,
        slot: pick.slot,
        rows: [],
        ...(provisioningNotes.get(pick.modelId)?.length
          ? { notes: provisioningNotes.get(pick.modelId) }
          : {}),
      };
      currentWalk = pickReport;
      writePickFragment(pickReport);

      // Persisted after every row: a walk that dies still leaves everything it
      // had established, and any worker can assemble the whole run from disk.
      const push = (row: AcceptanceRow) => {
        pickReport.rows.push(row);
        pickReport.finishedAt = new Date().toISOString();
        writePickFragment(pickReport);
        console.log(
          `  task ${row.task}.${row.turn} ${row.result} — ${row.label}: ${clip(row.evidence, 90)}`,
        );
      };

      /** Record a turn that produced (or failed to produce) a generation. */
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
          modelId: receipt?.modelId ?? pick.modelId,
          firstTokenMs: receipt?.firstTokenMs ?? null,
          kvReason: kvReasonOf(receipt),
          result,
          evidence,
        };
      };

      /**
       * Run one task, turn a thrown assertion into a FAIL row instead of ending
       * the walk, and close every chat page it opened.
       *
       * The sweep is not tidiness. Each open chat page holds a loaded model, so
       * a page abandoned by a throwing task keeps a model resident — and the
       * lane's first run showed what that costs: one failed task leaked its
       * page, and every task after it, across both walks, then failed to get a
       * model resident at all. Ten product verdicts, all of them artefacts of
       * one leak. A task that cannot run is a finding; the tasks after it must
       * still be able to say something.
       */
      const task = async (
        number: number,
        label: string,
        body: () => Promise<void>,
      ): Promise<void> => {
        // A task outside this run's plan contributes no row at all, which is
        // what keeps the smoke report's rows identical in shape to a full one.
        if (!planWalksTask(PLAN, number)) return;
        try {
          await body();
        } catch (error) {
          push({
            task: number,
            turn: 0,
            label,
            modelId: pick.modelId,
            firstTokenMs: null,
            kvReason: null,
            result: "FAIL",
            evidence: `task threw: ${clip(
              error instanceof Error ? error.message : String(error),
              300,
            )}`,
          });
        } finally {
          // Close anything a task opened beyond the walk's own page. A page
          // left open holds a loaded model, and an earlier run showed one
          // leaked page taking every later task down with it.
          for (const leaked of context.pages()) {
            if (leaked !== walkPage && leaked.url().startsWith(BASE_URL)) {
              await leaked.close().catch(() => undefined);
            }
          }
        }
      };

      // ONE page for the whole walk. Each task starts a fresh conversation on
      // it rather than a fresh tab: a person does not reload the app between
      // questions, and a tab per task asks the machine for a copy of the model
      // per task — which is what wedged an earlier run.
      let walkPage: Page | null = null;
      const lookups = watchLookupRequests(context);

      const open = async (): Promise<Page> => {
        if (walkPage === null || walkPage.isClosed()) {
          walkPage = await openChatOnModel(context, pick, bindingsFor(pick));
          return walkPage;
        }
        await startNewConversation(walkPage);
        return walkPage;
      };

      /**
       * Close the walk's tab after a failure that may have left the runtime
       * stuck, so the next task starts on a fresh one instead of inheriting a
       * jam it did not cause — the same reason the task wrapper sweeps leaked
       * pages.
       */
      const retireWalkPage = async (): Promise<void> => {
        if (walkPage !== null && !walkPage.isClosed()) {
          await walkPage.close().catch(() => undefined);
        }
        walkPage = null;
      };

      /**
       * Did this turn answer, the way a person would judge it: a reply that
       * finished, whose first words came promptly, with no error card. Each
       * reason it did not is named, so a FAIL row says what went wrong.
       */
      const answered = async (
        page: Page,
        outcome: TurnOutcome,
      ): Promise<{ ok: boolean; why: string }> =>
        judgeAnswered(
          outcome,
          (await assistantMessages(page).last().getByRole("alert").count()) > 0,
        );

      // ── 1. Cold first run to first reply, no dead ends ────────────────────
      await task(1, "cold first run to a first reply", async () => {
        const startedAt = Date.now();
        const page = await open();
        const toChatMs = Date.now() - startedAt;
        const outcome = await sendTurn(page, FIRST_RUN_PROMPT);
        push(rowFor(1, 1, "first reply on a cold start", outcome, judgeFirstReply(outcome, toChatMs)));
      });

      // ── 2. Ten-turn budgeting chat: a running total and a recall ──────────
      await task(2, "ten-turn budgeting chat", async () => {
        const page = await open();
        for (const [index, prompt] of BUDGET_TURNS.entries()) {
          const turn = index + 1;
          const outcome = await sendTurn(page, prompt);
          push(
            rowFor(2, turn, `turn ${turn}: ${clip(prompt, 48)}`, outcome, judgeBudgetTurn(turn, prompt, outcome)),
          );
        }
      });

      // ── 3. Paste ~2 pages, ask for a summary ──────────────────────────────
      await task(3, "summarise a pasted document", async () => {
        const page = await open();
        const outcome = await sendTurn(page, SUMMARY_PROMPT, LONG_TURN_TIMEOUT_MS);
        push(rowFor(3, 1, "summary of a ~4,400-character paste", outcome, judgeSummary(outcome)));
      });

      // ── 4. The exact-answer tools ─────────────────────────────────────────
      await task(4, "tool cards show the right answer", async () => {
        const page = await open();
        for (const [index, item] of TOOL_CASES.entries()) {
          const outcome = await sendTurn(page, item.prompt);
          push(
            rowFor(4, index + 1, `tool card for "${item.prompt}"`, outcome, judgeToolCard(outcome, item.expect)),
          );
        }
      });

      // ── 5. Draft an email, then shorten it ────────────────────────────────
      await task(5, "draft an email, then shorten it", async () => {
        const page = await open();
        const first = await sendTurn(page, EMAIL_BRIEF, LONG_TURN_TIMEOUT_MS);
        push(rowFor(5, 1, "draft from three bullet points", first, judgeDraft(first)));
        const second = await sendTurn(page, SHORTER_PROMPT, LONG_TURN_TIMEOUT_MS);
        push(rowFor(5, 2, "shortened on request", second, judgeShorter(first, second)));
      });

      // ── 6. Long chat until the context boundary is admitted ───────────────
      await task(6, "context boundary is shown honestly", async () => {
        const page = await open();
        const maxTurns = CONTEXT_MAX_TURNS;
        let announced = false;
        for (let turn = 1; turn <= maxTurns && !announced; turn++) {
          const outcome = await sendTurn(page, CONTEXT_PROMPT, LONG_TURN_TIMEOUT_MS);
          const dividerCount = await contextDivider(page).count();
          const noticeCount = await contextWindowNotice(page).count();
          announced = dividerCount > 0 || noticeCount > 0;
          const copy = announced
            ? await (dividerCount > 0 ? contextDivider(page) : contextWindowNotice(page))
                .first()
                .innerText()
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
            modelId: pick.modelId,
            firstTokenMs: null,
            kvReason: null,
            ...judgeContextNeverShown(maxTurns),
          });
        }
      });

      // ── 8. Switch faster ↔ smarter ────────────────────────────────────────
      await task(8, "switch between models truthfully", async () => {
        const page = await open();
        for (const other of others) {
          const label = await switchTo(page, other);
          const outcome = await sendTurn(page, SWITCH_PROMPT, LONG_TURN_TIMEOUT_MS);
          push(rowFor(8, 1, `switched to ${other.tileName}`, outcome, judgeSwitch(label, outcome, other)));

          const backLabel = await switchTo(page, pick);
          const back = await sendTurn(page, SWITCH_BACK_PROMPT, LONG_TURN_TIMEOUT_MS);
          push(rowFor(8, 2, `switched back to ${pick.tileName}`, back, judgeSwitch(backLabel, back, pick)));
        }
      });

      // ── 9. A factual question, lookups off then on ────────────────────────
      await task(9, "web lookups off, then on", async () => {
        const question = LOOKUP_QUESTION;

        const offPage = await open();
        lookups.reset();
        const off = await sendTurn(offPage, question);
        const firedOff = (await citations(offPage).count()) > 0;
        const offRequests = lookups.urls();
        push(
          rowFor(9, 1, "lookups off: nothing should fire", off, judgeLookupsOff(off, firedOff, offRequests)),
        );

        // Flip it in THIS tab, and read it back after a reload. Both halves
        // matter: the preference is hydrated per tab at mount, so flipping it
        // in a second tab leaves this one still believing lookups are off; and
        // it is written encrypted and asynchronously, so "the switch moved" is
        // not yet "the setting is on".
        const lookupsOn = await setWebLookupsInTab(offPage, true, pick);

        const onPage = offPage;
        await startNewConversation(onPage);
        lookups.reset();
        const on = await sendTurn(onPage, question, LONG_TURN_TIMEOUT_MS);
        const sourceCard = await citations(onPage).count();
        const onRequests = lookups.urls();
        push(
          rowFor(
            9,
            2,
            "lookups on: a source card should appear",
            on,
            judgeLookupsOn(on, sourceCard, lookupsOn, onRequests),
          ),
        );

        // Leave the device as we found it — lookups are off by default.
        await setWebLookupsInTab(onPage, false, pick);
      });

      // ── 10. Kill the tab mid-generation, reopen ───────────────────────────
      await task(10, "no wedge after a tab dies mid-reply", async () => {
        // The walk's own tab is the one that dies — that is the scenario.
        // Closing it makes `open()` build a new one, which is the reopening.
        const victim = await open();
        await beginTurn(victim, KILL_PROMPT, KILL_NOT_STARTED);
        await victim.close();

        const revived = await open();
        const outcome = await sendTurn(revived, REOPEN_PROMPT, LONG_TURN_TIMEOUT_MS);
        push(rowFor(10, 1, "chat works after a mid-reply tab kill", outcome, judgeReopened(outcome)));
      });

      // ── 11. A live question, Web search off then on ───────────────────────
      // The relay is STUBBED for both arms. A live engine would make this
      // task's evidence depend on the weather in Chicago and on whether an
      // engine rate-limited us, and neither is the product behaviour being
      // asked about. The off arm goes through the stub too, so a request the
      // switch should have prevented is caught here rather than sent.
      await task(11, "a live question, Web search off then on", async () => {
        const question = SEARCH_QUESTION;
        const relay = await stubSearchRelay(context);
        try {
          // ── off ──────────────────────────────────────────────────────────
          const page = await open();
          const settledOff = await setWebSearchInTab(page, false, pick);
          relay.reset();
          const off = await sendTurn(page, question, LONG_TURN_TIMEOUT_MS);
          const offNotes = await uncertaintyNotes(page, "no-live-data").count();
          const offCalls = relay.calls();
          const offChips = await webSearchCitations(page).count();
          push(
            rowFor(
              11,
              1,
              "Web search off: the honest note, and nothing sent",
              off,
              judgeSearchOff(off, { notes: offNotes, calls: offCalls, chips: offChips, settledOff }),
            ),
          );

          // ── on ───────────────────────────────────────────────────────────
          const settledOn = await setWebSearchInTab(page, true, pick);
          const composerSwitch =
            (await webSearchToggle(page).getAttribute("aria-checked")) ?? "(absent)";
          await startNewConversation(page);
          relay.reset();
          const on = await sendTurn(page, question, LONG_TURN_TIMEOUT_MS);

          // The privacy claim, as a mechanical check: exactly one POST, and its
          // body carries the question as typed and NOTHING else.
          push(
            rowFor(
              11,
              2,
              "Web search on: one request, carrying only the question as typed",
              on,
              judgeSearchRequest({ calls: relay.calls(), settledOn, composerSwitch }),
            ),
          );

          // The chip is how a person tells a searched turn from an unsearched
          // one, so its absence is a product failure even when the search ran.
          const chips = webSearchCitations(page);
          const chipCount = await chips.count();
          const fetchedAt =
            chipCount > 0 ? await chips.last().getAttribute("data-fetched-at") : null;
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
          await setWebSearchInTab(page, false, pick);
        } finally {
          await relay.dispose();
        }
      });

      // ── 12. Stop mid-reply, then send the next message ─────────────────────
      // Stop used to leave the WebLLM engine locked: the stopped reply looked
      // fine, and the NEXT message hung until the chat gave up on it. So the
      // row that matters is the second one — the stop itself only proves the
      // walk got far enough to ask.
      await task(12, "Stop mid-reply, then the next message answers", async () => {
        const page = await open();
        const prompt = STOP_PROMPT;
        const before = await newestGenerationId(page);
        await beginTurn(page, prompt);
        const stop = await stopMidReply(page);
        if (!stop.stopped) {
          push({
            task: 12,
            turn: 1,
            label: "Stop pressed mid-reply",
            modelId: pick.modelId,
            firstTokenMs: null,
            kvReason: null,
            ...judgeStopNotPressed(stop.reason),
          });
          return;
        }

        const stopped = await finishGeneration(page, prompt, before, STOPPED_RECEIPT_TIMEOUT_MS);
        const bubble = assistantMessages(page).last();
        const notice = bubble.getByRole("status").filter({ hasText: /stopped/i });
        const noticeText = (await notice.count()) > 0 ? await notice.first().innerText() : "";
        const kept = (await bubble.innerText()).replace(noticeText, "").trim();
        const tryAgainOffered = (await tryAgainOn(bubble).count()) > 0;
        push(
          rowFor(
            12,
            1,
            "Stop pressed mid-reply",
            stopped,
            judgeStopped(stopped, { settledMs: stop.settledMs, noticeText, tryAgainOffered, kept }),
          ),
        );

        const next = await sendTurn(page, AFTER_STOP_PROMPT, LONG_TURN_TIMEOUT_MS);
        const check = await answered(page, next);
        push(rowFor(12, 2, "the next message after a Stop answers", next, judgeFollowUp(next, check)));
        if (!check.ok) await retireWalkPage();
      });

      // ── 13. A reply fails part-way; Try again answers ────────────────────
      // The failure is the harness's one-shot fault: the reply stops after its
      // first word with a generic on-device error, so the person sees the
      // usual card and its Try again. The retry then has to find the runtime
      // free, even though the failed reply stopped reading it part-way.
      await task(13, "a failed reply, then Try again answers", async () => {
        const page = await open();
        const prompt = FAULT_PROMPT;
        await armGenerationFault(page);
        const failed = await sendTurn(page, prompt, LONG_TURN_TIMEOUT_MS);
        const stillArmed = await generationFaultArmed(page);
        const bubble = assistantMessages(page).last();
        const offered = (await tryAgainOn(bubble).count()) > 0;
        const card = offered ? clip(await bubble.innerText(), 120) : "";
        const failure = judgeInjectedFailure(failed, { stillArmed, offered, card });
        push(
          rowFor(13, 1, "a reply fails part-way, and Try again is offered", failed, failure),
        );
        if (!failure.ourFault || !offered) {
          await retireWalkPage();
          return;
        }

        const assistantBubbles = await assistantMessages(page).count();
        const before = await newestGenerationId(page);
        await tryAgainOn(bubble).first().click();
        const retried = await finishGeneration(page, prompt, before, LONG_TURN_TIMEOUT_MS);
        const check = await answered(page, retried);
        const askedOnce = (await userMessages(page).filter({ hasText: prompt }).count()) === 1;
        const replacedInPlace = (await assistantMessages(page).count()) === assistantBubbles;
        push(rowFor(13, 2, "Try again answers", retried, judgeRetry(retried, check, { askedOnce, replacedInPlace })));
        if (!check.ok) {
          await retireWalkPage();
          return;
        }

        const after = await sendTurn(page, AFTER_RETRY_PROMPT, LONG_TURN_TIMEOUT_MS);
        const afterCheck = await answered(page, after);
        push(
          rowFor(13, 3, "the conversation carries on after the retry", after, judgeFollowUp(after, afterCheck)),
        );
      });

      // ── 14. Edit an earlier message and resend ───────────────────────────
      // Editing the FIRST message branches the conversation there: the later
      // exchange leaves the transcript, and the model must answer from the
      // edited text alone. The name is the witness — only the edit says Tomas,
      // and only the discarded original said Priya.
      //
      // The witness has to be the reply to the edited message ITSELF. A later
      // turn is built from the conversation as the app now shows it, which
      // already says Tomas, so it cannot tell whether the edited turn was
      // generated from the edit or from the original. Asking to be greeted by
      // name puts the name in the edited turn's own reply.
      await task(14, "edit an earlier message and resend", async () => {
        const page = await open();
        await sendTurn(page, EDIT_ORIGINAL_PROMPT);
        await sendTurn(page, EDIT_LATER_PROMPT);

        const before = await newestGenerationId(page);
        await editUserMessage(page, 0, EDIT_REPLACEMENT_PROMPT);
        const edited = await finishGeneration(page, EDIT_REPLACEMENT_PROMPT, before, LONG_TURN_TIMEOUT_MS);
        const check = await answered(page, edited);
        const userTexts = await userMessages(page).allInnerTexts();
        const oneReply = (await assistantMessages(page).count()) === 1;
        const versionsShown =
          (await userMessages(page).first().getByRole("button", { name: "Previous version" }).count()) > 0;
        push(
          rowFor(
            14,
            1,
            "the edited message is resent and answered",
            edited,
            judgeEdit(edited, check, { userTexts, oneReply, versionsShown }),
          ),
        );

        // The reply to "What is my name?" is judged the same three ways on
        // both runtimes; see `judgeRecall`.
        const recall = await sendTurn(page, RECALL_PROMPT);
        push(rowFor(14, 2, "the conversation continues from the edit", recall, judgeRecall(recall)));
      });

      // ── 7. Offline reload — LAST, because it ends the page ────────────────
      // A real check now that the worker captures the chat shell. The walk's
      // tab was opened before the worker existed, so no navigation has passed
      // through it yet: reload ONLINE first to let the worker take control and
      // capture the shell, then go offline and reload for real.
      await task(7, "reload the tab offline", async () => {
        const page = await open();
        let usable = false;
        let detail = "";
        let controlling = false;
        let captured = false;
        let capturedAfterS = 0;
        try {
          await page.reload({ waitUntil: "load", timeout: 120_000 });
          await expect(
            composer(page).or(welcomeCard(page)).first(),
          ).toBeVisible({ timeout: 120_000 });
          // This profile is already set up, so the reload must land straight in
          // chat. A welcome card here means the app failed to recognize a model
          // it already holds and asked the person to choose all over again.
          await expect(
            welcomeCard(page),
            "reloading a set-up profile re-showed the welcome card",
          ).toHaveCount(0);

          controlling = await page.evaluate(
            () => navigator.serviceWorker.controller !== null,
          );
          // Polled explicitly rather than with waitForFunction: an async
          // predicate hands waitForFunction a pending Promise, which is truthy,
          // so it resolves at once and reports a capture that never happened.
          const pollStartedAt = Date.now();
          while (!captured && Date.now() - pollStartedAt < 30_000) {
            captured = await page.evaluate(shellCapturedInPage);
            if (!captured) await page.waitForTimeout(1_000);
          }
          capturedAfterS = Math.round((Date.now() - pollStartedAt) / 1_000);

          await context.setOffline(true);
          await page.reload({ waitUntil: "commit", timeout: 120_000 });
          await expect(composer(page)).toBeVisible({ timeout: 120_000 });
          const outcome = await sendTurn(page, OFFLINE_PROMPT, LONG_TURN_TIMEOUT_MS);
          usable = outcome.replyText.trim().length > 0;
          detail = `reply offline: ${clip(outcome.replyText)}`;
        } catch (error) {
          detail = clip(error instanceof Error ? error.message : String(error), 200);
        } finally {
          await context.setOffline(false);
        }
        push({
          task: 7,
          turn: 1,
          label: "offline reload serves chat",
          modelId: pick.modelId,
          firstTokenMs: null,
          kvReason: null,
          ...judgeOfflineReload({ usable, detail, controlling, captured, capturedAfterS }),
        });
      });

      // The walk is over: let go of its tab so the next model does not begin on
      // a machine still holding this one's model.
      for (const remaining of context.pages()) {
        if (remaining.url().startsWith(BASE_URL)) {
          await remaining.close().catch(() => undefined);
        }
      }
      walkPage = null;
    });
  }

  /**
   * The exit status follows the report, or the report is a wish.
   *
   * It lives in its own test, after both walks, on purpose: asserting inside a
   * walk makes that walk red, and a red walk is exactly what would stop the
   * next model from being walked at all.
   */
  test("every walked model produced a table, and nothing failed that was not expected to", () => {
    // Read from disk, not from memory: a walk that ran in a worker Playwright
    // has since replaced left its rows in a fragment, and nowhere else.
    const { report } = assembleReport({
      smoke: PLAN.smoke,
      tasks: PLAN.tasks,
      runtime: PLAN.runtime,
    });
    expect(
      report.picks.length,
      `the report carries ${report.picks.length} model table(s), not ${WALK_PICKS.length}`,
    ).toBe(WALK_PICKS.length);
    const missing = WALK_PICKS.filter(
      (pick) => !report.picks.some((entry) => entry.modelId === pick.modelId),
    ).map((pick) => pick.tileName);
    expect(missing, "a shipping model produced no table at all").toEqual([]);

    const failures = report.picks.flatMap((entry) =>
      entry.rows
        .filter((row) => row.result === "FAIL")
        .map(
          (row) =>
            `${entry.label} task ${row.task}.${row.turn} — ${row.label}: ${clip(row.evidence, 120)}`,
        ),
    );
    expect(
      failures,
      "the walk recorded failures; the full tables are in test-results/acceptance-report.md",
    ).toEqual([]);
  });
});
