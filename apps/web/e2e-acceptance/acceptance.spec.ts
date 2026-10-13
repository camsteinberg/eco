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
import {
  assembleReport,
  clip,
  writePickFragment,
  type AcceptanceRow,
  type PickReport,
  type RowResult,
} from "./lib/report";
import {
  acceptancePlan,
  planPicks,
  planWalksTask,
} from "./lib/subset";
import {
  INJECTED_FAULT_MESSAGE,
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
  WEB_SEARCH_STUB_FETCHED_AT,
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

/** A long generation, so there is time to kill the tab mid-reply (task 10). */
const LONG_TURN_TIMEOUT_MS = 480_000;

/**
 * The slowest first token a reply after a Stop or a retry may take and still
 * count as answered. Measured after the fix, those first tokens arrive in well
 * under two seconds; the defect this guards against never produced one, and
 * the chat gave up after 90 s. Thirty seconds separates the two with room.
 */
const FIRST_TOKEN_CEILING_MS = 30_000;

/** How long a stopped turn gets to record its receipt. */
const STOPPED_RECEIPT_TIMEOUT_MS = 30_000;

/**
 * The two shipping picks, one per slot. Ids and slots come from the catalog
 * (`local-ai/catalog/catalog-data.json`); the tile names are the curated
 * welcome copy the switcher shows, and the friendly names are the branded
 * names the switcher's accessible label uses — the catalog's `display`
 * block, not its raw `friendlyName`, which is the model's technical name and
 * never reaches the UI.
 */
const ECO_FAST: Pick = {
  modelId: "candidate/lfm2.5-1.2b-instruct-onnx",
  slot: "eco-fast",
  tileName: "Eco Fast",
  friendlyName: "Eco Fast (Liquid)",
};
const ECO_DEEPER: Pick = {
  modelId: "candidate/lfm2-2.6b-onnx",
  slot: "eco-smart",
  tileName: "Eco Deeper",
  friendlyName: "Eco Deeper (Liquid)",
};

/**
 * The two models the app serves desktop Safari, both on WebLLM: Eco Compact
 * first, Eco Mobile as its fallback. Each is walked alone in the everyday slot,
 * the slot a desktop-Safari device fills first.
 */
const ECO_COMPACT_WEBLLM: Pick = {
  modelId: "candidate/qwen3-0.6b-mlc-q0f16",
  slot: "eco-fast",
  tileName: "Eco Compact",
  friendlyName: "Eco Compact (Qwen)",
};
const ECO_MOBILE_WEBLLM: Pick = {
  modelId: "candidate/qwen2.5-0.5b-mlc",
  slot: "eco-fast",
  tileName: "Eco Mobile",
  friendlyName: "Eco Mobile (Qwen)",
};

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
 * The numeric side of one turn, for the evidence column: what the prompt and
 * reply cost, what the KV gate saw, and where the history window started.
 *
 * A ten-turn chat that loses a figure is only diagnosable with these: the same
 * `windowStart` as the previous turn with an `equal-or-shorter` miss is
 * re-tokenization, a moved `windowStart` is eviction, and the decoded
 * divergence says which tokens differed. Missing fields print as `?` rather
 * than being omitted, so the columns line up across turns.
 */
function turnCounts(outcome: TurnOutcome): string {
  const receipt = outcomeReceipt(outcome);
  const kv = receipt?.kvReuse;
  const parts = [
    `prompt=${receipt?.promptTokens ?? "?"}`,
    `completion=${receipt?.completionTokens ?? "?"}`,
    `cachedLen=${kv?.cachedLen ?? "?"}`,
    `promptLen=${kv?.promptLen ?? "?"}`,
    `commonPrefix=${kv?.commonPrefixLen ?? "-"}`,
    `durationMs=${receipt?.durationMs ?? "?"}`,
    `windowStart=${receipt?.windowStartIndex ?? "?"}`,
  ];
  const divergence = kv?.divergence;
  if (divergence) {
    parts.push(
      `DIV cached=${JSON.stringify(clip(divergence.cached, 80))}`,
      `next=${JSON.stringify(clip(divergence.next, 80))}`,
    );
  }
  return parts.join(" ");
}

/** ~4,400 chars ≈ 1,100 estimator-tokens. Plain prose, not a token-stuffer. */
const PASTE_BLOCK = (
  "The greenhouse effect of a well-tended garden is easy to underestimate. "
  + "Raised beds warm earlier in the year than open ground, and a gardener who "
  + "plans the season around that difference can start harvesting weeks ahead of "
  + "the almanac. Companion planting matters too: beans fix nitrogen that heavy "
  + "feeders like squash consume, while marigolds keep certain pests away from "
  + "tomatoes. Water management is the quiet discipline underneath all of it — "
  + "deep, infrequent watering trains roots downward, while daily sprinkling "
  + "keeps them shallow and fragile. "
).repeat(8);

/** The ten-turn budgeting conversation. Turn 5 checks a running total, turn 10 a recall. */
const BUDGET_TURNS: readonly string[] = [
  "I want to get my monthly budget under control.",
  "My rent is $1,450 a month and I take home about $3,200.",
  "Groceries run me around $400, and I spend $120 on transit.",
  "My phone and internet come to $95 together.",
  "Adding those up, what am I spending each month so far?",
  "I'd like to put $300 into savings every month.",
  "Does that still leave me anything?",
  "What would you cut first?",
  "Give me one habit that would help me stick to this.",
  "What was my rent again?",
];

/** Turn numbers inside task 2 that carry a mechanical check. */
const RUNNING_TOTAL_TURN = 5;
const RENT_RECALL_TURN = 10;

const contains = (text: string, ...needles: string[]): boolean =>
  needles.some((needle) => text.includes(needle));

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
        result: RowResult,
        evidence: string,
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
      ): Promise<{ ok: boolean; why: string }> => {
        const receipt = outcomeReceipt(outcome);
        const problems: string[] = [];
        if (!receipt) {
          problems.push("no generation ran");
        } else {
          if (receipt.status !== "complete") {
            problems.push(
              `the reply ended '${receipt.status}'${
                receipt.errorCode ? ` (${clip(receipt.errorCode, 90)})` : ""
              }`,
            );
          }
          if (receipt.firstTokenMs == null) {
            problems.push("no first word ever arrived");
          } else if (receipt.firstTokenMs > FIRST_TOKEN_CEILING_MS) {
            problems.push(
              `the first word took ${Math.round(receipt.firstTokenMs)} ms (ceiling ${FIRST_TOKEN_CEILING_MS} ms)`,
            );
          }
        }
        if ((await assistantMessages(page).last().getByRole("alert").count()) > 0) {
          problems.push("an error card is showing");
        }
        if (outcome.replyText.trim().length === 0) problems.push("the reply is empty");
        return { ok: problems.length === 0, why: problems.join("; ") };
      };

      // ── 1. Cold first run to first reply, no dead ends ────────────────────
      await task(1, "cold first run to a first reply", async () => {
        const startedAt = Date.now();
        const page = await open();
        const toChatMs = Date.now() - startedAt;
        const outcome = await sendTurn(page, "Hi — what can you help me with?");
        push(
          rowFor(
            1,
            1,
            "first reply on a cold start",
            outcome,
            outcome.replyText.trim().length > 0 ? "PASS" : "FAIL",
            `chat usable in ${toChatMs} ms, no setup error surface; reply: ${clip(
              outcome.replyText,
            )}`,
          ),
        );
      });

      // ── 2. Ten-turn budgeting chat: a running total and a recall ──────────
      await task(2, "ten-turn budgeting chat", async () => {
        const page = await open();
        for (const [index, prompt] of BUDGET_TURNS.entries()) {
          const turn = index + 1;
          const outcome = await sendTurn(page, prompt);
          const stored = outcome.storedUserText;
          // The input can be the defect. A reply is only evidence about the
          // model if the app stored the sentence we meant to send.
          const inputIntact = stored === null || stored.trim() === prompt.trim();
          let result: RowResult = "RECORDED";
          // The counts are the point of this task as an instrument: a lost
          // figure is diagnosable only alongside what the window held and
          // whether the cache was reused on the turn that lost it.
          const counts = turnCounts(outcome);
          let evidence = `${counts}; reply: ${clip(outcome.replyText)}`;
          if (!inputIntact) {
            result = "FAIL";
            evidence = `stored input differs from what was typed: ${clip(stored ?? "")}`;
          } else if (turn === RUNNING_TOTAL_TURN) {
            const ok = contains(outcome.replyText, "2,065", "2065");
            result = ok ? "PASS" : "FAIL";
            evidence = `${counts}; running total 2,065 ${ok ? "present" : "absent"}; reply: ${clip(
              outcome.replyText,
            )}`;
          } else if (turn === RENT_RECALL_TURN) {
            const ok = contains(outcome.replyText, "1,450", "1450");
            result = ok ? "PASS" : "FAIL";
            evidence = `${counts}; rent figure from turn 2 ${ok ? "recalled" : "lost"}; reply: ${clip(
              outcome.replyText,
            )}`;
          }
          push(rowFor(2, turn, `turn ${turn}: ${clip(prompt, 48)}`, outcome, result, evidence));
        }
      });

      // ── 3. Paste ~2 pages, ask for a summary ──────────────────────────────
      await task(3, "summarise a pasted document", async () => {
        const page = await open();
        const document = `${PASTE_BLOCK}\n\nSummarise the text above in a few sentences.`;
        const outcome = await sendTurn(page, document, LONG_TURN_TIMEOUT_MS);
        const shorter = outcome.replyText.length < PASTE_BLOCK.length;
        push(
          rowFor(
            3,
            1,
            "summary of a ~4,400-character paste",
            outcome,
            shorter && outcome.replyText.trim().length > 0 ? "RECORDED" : "FAIL",
            `${outcome.replyText.length} chars back from ${PASTE_BLOCK.length} in; summary: ${clip(
              outcome.replyText,
              240,
            )}`,
          ),
        );
      });

      // ── 4. The exact-answer tools ─────────────────────────────────────────
      await task(4, "tool cards show the right answer", async () => {
        const page = await open();
        const cases: { prompt: string; expect: string }[] = [
          { prompt: "What's 18% of $62.50", expect: "= 11.25" },
          { prompt: "what date is 6 weeks from today", expect: "6 weeks from today is" },
        ];
        for (const [index, item] of cases.entries()) {
          const outcome = await sendTurn(page, item.prompt);
          const card = outcome.toolCardText ?? "";
          const ok = outcome.toolAnswered && card.includes(item.expect);
          push(
            rowFor(
              4,
              index + 1,
              `tool card for "${item.prompt}"`,
              outcome,
              ok ? "PASS" : "FAIL",
              outcome.toolAnswered
                ? `card: ${clip(card)}${card.includes(item.expect) ? "" : ` (expected "${item.expect}")`}`
                : `no tool fired — the model answered instead: ${clip(outcome.replyText)}`,
            ),
          );
        }
      });

      // ── 5. Draft an email, then shorten it ────────────────────────────────
      await task(5, "draft an email, then shorten it", async () => {
        const page = await open();
        const brief = [
          "Draft a short email to my landlord from these three points:",
          "- the kitchen tap has been dripping for a week",
          "- I am home on Thursday afternoon",
          "- ask when a plumber can come",
        ].join("\n");
        const first = await sendTurn(page, brief, LONG_TURN_TIMEOUT_MS);
        push(
          rowFor(5, 1, "draft from three bullet points", first, "RECORDED", `draft (${first.replyText.length} chars): ${clip(first.replyText, 240)}`),
        );
        const second = await sendTurn(page, "Can you make that shorter?", LONG_TURN_TIMEOUT_MS);
        const shorter = second.replyText.length < first.replyText.length;
        push(
          rowFor(
            5,
            2,
            "shortened on request",
            second,
            shorter ? "PASS" : "FAIL",
            `${second.replyText.length} chars vs ${first.replyText.length}; reply: ${clip(
              second.replyText,
              240,
            )}`,
          ),
        );
      });

      // ── 6. Long chat until the context boundary is admitted ───────────────
      await task(6, "context boundary is shown honestly", async () => {
        const page = await open();
        const maxTurns = 6;
        let announced = false;
        for (let turn = 1; turn <= maxTurns && !announced; turn++) {
          const outcome = await sendTurn(
            page,
            `${PASTE_BLOCK}\nBriefly, what is this text about?`,
            LONG_TURN_TIMEOUT_MS,
          );
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
              announced ? "PASS" : "RECORDED",
              announced
                ? `the app says: ${clip(copy)}`
                : `no boundary shown yet; promptTokens=${
                    outcomeReceipt(outcome)?.promptTokens ?? "?"
                  }`,
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
            result: "RECORDED",
            evidence: `${maxTurns} pastes of ${PASTE_BLOCK.length} chars did not surface a divider or notice`,
          });
        }
      });

      // ── 8. Switch faster ↔ smarter ────────────────────────────────────────
      await task(8, "switch between models truthfully", async () => {
        const page = await open();
        for (const other of others) {
          const label = await switchTo(page, other);
          const outcome = await sendTurn(page, "In one line, say hello.", LONG_TURN_TIMEOUT_MS);
          const receipt = outcomeReceipt(outcome);
          const truthful =
            label.includes(other.friendlyName) && receipt?.modelId === other.modelId;
          push(
            rowFor(
              8,
              1,
              `switched to ${other.tileName}`,
              outcome,
              truthful ? "PASS" : "FAIL",
              `switcher says "${clip(label, 80)}"; the receipt says ${
                receipt?.modelId ?? "no generation"
              }`,
            ),
          );

          const backLabel = await switchTo(page, pick);
          const back = await sendTurn(page, "In one line, say hello again.", LONG_TURN_TIMEOUT_MS);
          const backReceipt = outcomeReceipt(back);
          const backTruthful =
            backLabel.includes(pick.friendlyName) && backReceipt?.modelId === pick.modelId;
          push(
            rowFor(
              8,
              2,
              `switched back to ${pick.tileName}`,
              back,
              backTruthful ? "PASS" : "FAIL",
              `switcher says "${clip(backLabel, 80)}"; the receipt says ${
                backReceipt?.modelId ?? "no generation"
              }`,
            ),
          );
        }
      });

      // ── 9. A factual question, lookups off then on ────────────────────────
      await task(9, "web lookups off, then on", async () => {
        const question = "Who wrote the novel Frankenstein?";

        const offPage = await open();
        lookups.reset();
        const off = await sendTurn(offPage, question);
        const firedOff = (await citations(offPage).count()) > 0;
        const offRequests = lookups.urls();
        push(
          rowFor(
            9,
            1,
            "lookups off: nothing should fire",
            off,
            firedOff || offRequests.length > 0 ? "FAIL" : "RECORDED",
            firedOff || offRequests.length > 0
              ? `lookups are off, yet ${offRequests.length} request(s) left the device and `
                + `${firedOff ? "a source card appeared" : "no card appeared"}`
              : `no source card, no request left the device; the answer reads: ${clip(
                  off.replyText,
                  220,
                )}`,
          ),
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
        const witness =
          `setting read back as ${lookupsOn ? "ON" : "OFF"}; `
          + `${onRequests.length} lookup request(s)`
          + (onRequests[0] ? ` (first: ${clip(onRequests[0], 70)})` : "");
        push(
          rowFor(
            9,
            2,
            "lookups on: a source card should appear",
            on,
            sourceCard > 0 ? "PASS" : lookupsOn ? "FAIL" : "RECORDED",
            sourceCard > 0
              ? `${sourceCard} source card(s); ${witness}; answer: ${clip(on.replyText, 160)}`
              : `NO source card. ${witness}; answer: ${clip(on.replyText, 160)}`,
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
        await beginTurn(
          victim,
          "Write a detailed paragraph about the history of the bicycle.",
          "generation never started, so nothing was killed mid-reply",
        );
        await victim.close();

        const revived = await open();
        const outcome = await sendTurn(revived, "Are you still there?", LONG_TURN_TIMEOUT_MS);
        push(
          rowFor(
            10,
            1,
            "chat works after a mid-reply tab kill",
            outcome,
            outcome.replyText.trim().length > 0 ? "PASS" : "FAIL",
            `reply after reopening: ${clip(outcome.replyText)}`,
          ),
        );
      });

      // ── 11. A live question, Web search off then on ───────────────────────
      // The relay is STUBBED for both arms. A live engine would make this
      // task's evidence depend on the weather in Chicago and on whether an
      // engine rate-limited us, and neither is the product behaviour being
      // asked about. The off arm goes through the stub too, so a request the
      // switch should have prevented is caught here rather than sent.
      await task(11, "a live question, Web search off then on", async () => {
        const question = "is it raining in Chicago right now";
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
          const offClean = offNotes > 0 && offCalls.length === 0 && offChips === 0;
          push(
            rowFor(
              11,
              1,
              "Web search off: the honest note, and nothing sent",
              off,
              offClean ? "PASS" : "FAIL",
              offClean
                ? "no-live-data note shown, 0 search requests, no chip; setting read back as "
                  + `${settledOff ? "ON (wrong)" : "OFF"}; answer: ${clip(off.replyText, 160)}`
                : `expected the no-live-data note and no request: ${offNotes} note(s), `
                  + `${offCalls.length} search request(s), ${offChips} chip(s); `
                  + `answer: ${clip(off.replyText, 160)}`,
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
          // body carries the question as typed and NOTHING else. A body that grew a
          // second key is what this row exists to catch.
          const calls = relay.calls();
          const [call] = calls;
          let bodyKeys: string[] = [];
          let parsed = false;
          try {
            const json: unknown = JSON.parse(call?.body ?? "");
            if (json !== null && typeof json === "object") {
              bodyKeys = Object.keys(json as Record<string, unknown>).sort();
              parsed = true;
            }
          } catch {
            parsed = false;
          }
          const onlyQuery =
            calls.length === 1
            && call?.method === "POST"
            && parsed
            && bodyKeys.length === 1
            && bodyKeys[0] === "q";
          push(
            rowFor(
              11,
              2,
              "Web search on: one request, carrying only the question as typed",
              on,
              onlyQuery ? "PASS" : settledOn ? "FAIL" : "RECORDED",
              `${calls.length} request(s) to the relay; method ${call?.method ?? "(none)"}; `
                + `body keys [${bodyKeys.join(", ")}]${parsed ? "" : " (unparsed)"}; `
                + `setting read back as ${settledOn ? "ON" : "OFF"}, `
                + `composer switch aria-checked=${composerSwitch}`,
            ),
          );

          // The chip is how a person tells a searched turn from an unsearched
          // one, so its absence is a product failure even when the search ran.
          const chips = webSearchCitations(page);
          const chipCount = await chips.count();
          const fetchedAt =
            chipCount > 0 ? await chips.last().getAttribute("data-fetched-at") : null;
          // A receipt carries no prompt TEXT — only `systemPromptHash` — so
          // "the snippet note reached the prompt" is witnessed by that hash
          // differing from the unsearched turn's, not by reading the note back.
          const offHash = outcomeReceipt(off)?.systemPromptHash ?? null;
          const onHash = outcomeReceipt(on)?.systemPromptHash ?? null;
          const promptMoved =
            offHash !== null && onHash !== null && offHash !== onHash
              ? "changed, so the searched turn carried a different system prompt"
              : "unchanged or unknown";
          const chipOk = chipCount > 0 && fetchedAt === WEB_SEARCH_STUB_FETCHED_AT;
          push(
            rowFor(
              11,
              3,
              "Web search on: the reply is marked with a fetched-at chip",
              on,
              chipOk ? "PASS" : settledOn ? "FAIL" : "RECORDED",
              `${chipCount} chip(s), data-fetched-at ${fetchedAt ?? "(absent)"}; `
                + `system prompt hash ${offHash ?? "?"} → ${onHash ?? "?"} (${promptMoved}); `
                + `answer: ${clip(on.replyText, 160)}`,
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
        const prompt =
          "Write a long, detailed essay on the history of the Roman Empire, at least 1500 words.";
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
            result: "FAIL",
            evidence: `${stop.reason}; nothing was stopped, so this task says nothing about Stop`,
          });
          return;
        }

        const stopped = await finishGeneration(page, prompt, before, STOPPED_RECEIPT_TIMEOUT_MS);
        const stoppedReceipt = outcomeReceipt(stopped);
        const bubble = assistantMessages(page).last();
        const notice = bubble.getByRole("status").filter({ hasText: /stopped/i });
        const noticeText = (await notice.count()) > 0 ? await notice.first().innerText() : "";
        const kept = (await bubble.innerText()).replace(noticeText, "").trim();
        const recordedAsStopped = stoppedReceipt?.status === "aborted";
        const stopOk =
          recordedAsStopped && noticeText !== "" && (await tryAgainOn(bubble).count()) > 0 && kept !== "";
        push(
          rowFor(
            12,
            1,
            "Stop pressed mid-reply",
            stopped,
            stopOk ? "PASS" : "FAIL",
            `composer back ${stop.settledMs} ms after Stop; recorded as '${
              stoppedReceipt?.status ?? "(no receipt)"
            }'${recordedAsStopped ? "" : " (a stopped reply should be 'aborted')"}; notice: ${
              noticeText ? JSON.stringify(clip(noticeText, 60)) : "MISSING"
            }; ${kept ? `${kept.length} chars kept on screen` : "the partial reply is GONE"}`,
          ),
        );

        const next = await sendTurn(page, "Give me some tips for better sleep.", LONG_TURN_TIMEOUT_MS);
        const check = await answered(page, next);
        push(
          rowFor(
            12,
            2,
            "the next message after a Stop answers",
            next,
            check.ok ? "PASS" : "FAIL",
            `${check.ok ? "answered" : `did NOT answer: ${check.why}`}; ${turnCounts(next)}; reply: ${clip(
              next.replyText,
            )}`,
          ),
        );
        if (!check.ok) await retireWalkPage();
      });

      // ── 13. A reply fails part-way; Try again answers ────────────────────
      // The failure is the harness's one-shot fault: the reply stops after its
      // first word with a generic on-device error, so the person sees the
      // usual card and its Try again. The retry then has to find the runtime
      // free, even though the failed reply stopped reading it part-way.
      await task(13, "a failed reply, then Try again answers", async () => {
        const page = await open();
        const prompt = "Give me three ideas for a quiet weekend at home.";
        await armGenerationFault(page);
        const failed = await sendTurn(page, prompt, LONG_TURN_TIMEOUT_MS);
        const failedReceipt = outcomeReceipt(failed);
        const ourFault =
          failedReceipt?.status === "error"
          && (failedReceipt.errorCode ?? "").startsWith(INJECTED_FAULT_MESSAGE.slice(0, 80));
        const stillArmed = await generationFaultArmed(page);
        const bubble = assistantMessages(page).last();
        const offered = (await tryAgainOn(bubble).count()) > 0;
        const card = offered ? clip(await bubble.innerText(), 120) : "";
        push(
          rowFor(
            13,
            1,
            "a reply fails part-way, and Try again is offered",
            failed,
            ourFault && offered && !stillArmed ? "PASS" : "FAIL",
            [
              ourFault
                ? "failed with the injected fault"
                : `expected the injected fault, got '${failedReceipt?.status ?? "no receipt"}'${
                    failedReceipt?.errorCode ? ` (${clip(failedReceipt.errorCode, 80)})` : ""
                  }`,
              stillArmed ? "the fault is STILL armed (it should fire once)" : "fault fired once",
              offered ? `the person sees: ${JSON.stringify(card)}` : "NO Try again is offered",
            ].join("; "),
          ),
        );
        if (!ourFault || !offered) {
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
        const retryOk = check.ok && askedOnce && replacedInPlace;
        push(
          rowFor(
            13,
            2,
            "Try again answers",
            retried,
            retryOk ? "PASS" : "FAIL",
            [
              check.ok ? "answered" : `did NOT answer: ${check.why}`,
              askedOnce ? "the question shows once" : "the question is DUPLICATED in the transcript",
              replacedInPlace ? "the answer replaced the failed reply" : "the failed reply was NOT replaced",
              turnCounts(retried),
              `reply: ${clip(retried.replyText)}`,
            ].join("; "),
          ),
        );
        if (!check.ok) {
          await retireWalkPage();
          return;
        }

        const after = await sendTurn(page, "Thanks. One more idea, please.", LONG_TURN_TIMEOUT_MS);
        const afterCheck = await answered(page, after);
        push(
          rowFor(
            13,
            3,
            "the conversation carries on after the retry",
            after,
            afterCheck.ok ? "PASS" : "FAIL",
            `${afterCheck.ok ? "answered" : `did NOT answer: ${afterCheck.why}`}; ${turnCounts(after)}; reply: ${clip(
              after.replyText,
            )}`,
          ),
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
        const original = "My name is Priya. Say hello to me by name, in one short sentence.";
        const edit = "My name is Tomas. Say hello to me by name, in one short sentence.";
        await sendTurn(page, original);
        await sendTurn(page, "Suggest one name for a pet goldfish.");

        const before = await newestGenerationId(page);
        await editUserMessage(page, 0, edit);
        const edited = await finishGeneration(page, edit, before, LONG_TURN_TIMEOUT_MS);
        const check = await answered(page, edited);
        const userTexts = await userMessages(page).allInnerTexts();
        const showsEdit = userTexts.length === 1 && (userTexts[0] ?? "").includes("Tomas");
        const laterTurnGone = !userTexts.some((text) => text.includes("goldfish"));
        const oneReply = (await assistantMessages(page).count()) === 1;
        const versionsShown =
          (await userMessages(page).first().getByRole("button", { name: "Previous version" }).count()) > 0;
        // Null means nothing could be read from storage; only a mismatch fails.
        const storedEdit = edited.storedUserText === null || edited.storedUserText.trim() === edit;
        // The reply's own words: the original name means the edited turn was
        // generated from the discarded text — the edit is broken whatever the
        // screen shows. Neither name leaves the content unchecked, not failed.
        const replyLeakedOriginal = edited.replyText.includes("Priya");
        const replyUsedEdit = edited.replyText.includes("Tomas");
        const editOk =
          check.ok
          && showsEdit
          && laterTurnGone
          && oneReply
          && versionsShown
          && storedEdit
          && !replyLeakedOriginal;
        push(
          rowFor(
            14,
            1,
            "the edited message is resent and answered",
            edited,
            editOk ? "PASS" : "FAIL",
            [
              check.ok ? "answered" : `did NOT answer: ${check.why}`,
              showsEdit ? "the transcript shows the edited message" : `the transcript shows ${JSON.stringify(userTexts.map((text) => clip(text, 40)))}`,
              laterTurnGone ? "the later exchange left the transcript" : "the later exchange is STILL showing",
              oneReply ? "one reply" : "more than one reply is showing",
              versionsShown ? "the earlier version is one tap away" : "NO way back to the earlier version",
              storedEdit ? "storage holds the edit" : `storage holds ${JSON.stringify(clip(edited.storedUserText ?? "", 60))}`,
              replyLeakedOriginal
                ? "the reply uses the name from BEFORE the edit, so it was generated from the discarded text"
                : replyUsedEdit
                  ? "the reply uses the edited name"
                  : "the reply did not use a name — the edit's content is unchecked on this run",
              `reply: ${clip(edited.replyText)}`,
            ].join("; "),
          ),
        );

        // Three outcomes, judged in this order. The original name in the reply
        // means the discarded text reached the model — the edit itself is
        // broken, so that FAILs. The edited name PASSes. Neither name (a
        // small model saying it doesn't know) is RECORDED: a reading on the
        // model's recall, not evidence about the edit.
        const recall = await sendTurn(page, "What is my name?");
        const leakedOriginal = recall.replyText.includes("Priya");
        const recalled = recall.replyText.includes("Tomas");
        push(
          rowFor(
            14,
            2,
            "the conversation continues from the edit",
            recall,
            leakedOriginal ? "FAIL" : recalled ? "PASS" : "RECORDED",
            `${
              leakedOriginal
                ? "the reply uses the name from BEFORE the edit, so the discarded text reached the model"
                : recalled
                  ? "the reply uses the edited name"
                  : "the model did not recall either name — a recall reading, not an edit failure"
            }; ${turnCounts(recall)}; reply: ${clip(recall.replyText)}`,
          ),
        );
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
            captured = await page.evaluate(async () => {
              const cache = await caches.open("eco-shell-v1");
              return (await cache.match(location.pathname)) !== undefined;
            });
            if (!captured) await page.waitForTimeout(1_000);
          }
          capturedAfterS = Math.round((Date.now() - pollStartedAt) / 1_000);

          await context.setOffline(true);
          await page.reload({ waitUntil: "commit", timeout: 120_000 });
          await expect(composer(page)).toBeVisible({ timeout: 120_000 });
          const outcome = await sendTurn(page, "Still working offline?", LONG_TURN_TIMEOUT_MS);
          usable = outcome.replyText.trim().length > 0;
          detail = `reply offline: ${clip(outcome.replyText)}`;
        } catch (error) {
          detail = clip(error instanceof Error ? error.message : String(error), 200);
        } finally {
          await context.setOffline(false);
        }
        const state = `worker controlling: ${controlling ? "yes" : "no"}; `
          + `shell captured: ${captured ? `yes (${capturedAfterS} s)` : "no (30 s timeout)"}`;
        push({
          task: 7,
          turn: 1,
          label: "offline reload serves chat",
          modelId: pick.modelId,
          firstTokenMs: null,
          kvReason: null,
          result: usable ? "PASS" : "FAIL",
          evidence: usable
            ? `${state}; ${detail}`
            : `offline reload did not reach a working chat (${state}): ${detail}`,
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
