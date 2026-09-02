// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The ten-task acceptance walk, on both shipping models, in a real browser.
 *
 * Run at session open whenever a serving-path or tool change merged last
 * session, and at every phase end.
 *
 * What it is: the scripted walkthrough a person would do before saying the
 * product is usable — a cold first run, a ten-turn conversation that has to
 * remember a number, a pasted document, the exact-answer tools, an edit
 * request, a conversation long enough to move the context window, an offline
 * reload, a model switch, a factual question with and without web lookups, and
 * a tab killed mid-reply. It runs against a PRODUCTION build with real
 * inference on the machine's own GPU.
 *
 * The run's exit status follows the report: any FAIL row ends the run red.
 * Only an EXPECTED-FAIL is allowed to pass, because it names a gap that is
 * already known.
 *
 * What it is not: a scorer. Tasks whose quality only a person can judge are
 * recorded with the reply text and, where one exists, a mechanical check
 * (does the tenth reply still contain the rent figure; is the shortened draft
 * shorter). This file does not invent a quality rubric, and it does not fail
 * the run on a gap that is known and tracked — the offline reload is recorded
 * as an expected failure rather than turned into a red lane.
 *
 * Cost: two model downloads on a cold profile (~0.8 GB and ~1.7 GB), then
 * every turn is real generation. Budget the better part of an hour per model.
 * It is opt-in for that reason — `pnpm --filter @eco/web test:acceptance`,
 * never `pnpm qa` and never CI.
 */

import { expect, test, chromium, type BrowserContext, type Page } from "@playwright/test";
import { join } from "node:path";
import {
  READY_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  composer,
  setWebBaseUrl,
  stubAuth,
} from "../e2e-perf/lib/session";
import {
  REPORT_JSON_PATH,
  clip,
  writeReport,
  type AcceptanceReport,
  type AcceptanceRow,
  type PickReport,
  type RowResult,
} from "./lib/report";
import {
  citations,
  contextDivider,
  contextWindowNotice,
  kvReasonOf,
  openChatOnModel,
  outcomeReceipt,
  provisionPick,
  sendTurn,
  stopButton,
  switchTo,
  waitForUsableChat,
  wipeOrigin,
  type Pick,
  type TurnOutcome,
} from "./lib/walk";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3120";
const PROFILE_DIR =
  process.env.ECO_ACCEPTANCE_PROFILE_DIR ?? join(__dirname, ".browser-profile");

/** A long generation, so there is time to kill the tab mid-reply (task 10). */
const LONG_TURN_TIMEOUT_MS = 480_000;

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
const PICKS: readonly Pick[] = [ECO_FAST, ECO_DEEPER];

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

// ─── Report accumulation ───────────────────────────────────────────────────

const report: AcceptanceReport = {
  startedAt: new Date().toISOString(),
  finishedAt: "",
  picks: [],
};

test.describe.configure({ mode: "serial" });

test.describe("ten-task acceptance walk", () => {
  let context: BrowserContext;

  test.beforeAll(async () => {
    setWebBaseUrl(BASE_URL);
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
    });
    await stubAuth(context);
  });

  test.afterAll(async () => {
    report.finishedAt = new Date().toISOString();
    const paths = writeReport(report, REPORT_JSON_PATH);
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
  test("cold profile, both shipping models provisioned", async () => {
    test.setTimeout(3_600_000);
    const bootstrap = await context.newPage();
    await bootstrap.goto(`${BASE_URL}/`, { waitUntil: "commit" });
    await wipeOrigin(context, bootstrap);
    await bootstrap.close();

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

  for (const pick of PICKS) {
    const others = PICKS.filter((entry) => entry.modelId !== pick.modelId);

    test(`${pick.tileName} — ten-task walk`, async () => {
      test.setTimeout(5_400_000);
      const pickReport: PickReport = {
        modelId: pick.modelId,
        label: pick.tileName,
        slot: pick.slot,
        rows: [],
      };
      report.picks.push(pickReport);

      const push = (row: AcceptanceRow) => {
        pickReport.rows.push(row);
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
          for (const leaked of context.pages()) {
            if (leaked.url().startsWith(BASE_URL)) {
              await leaked.close().catch(() => undefined);
            }
          }
        }
      };

      const open = (): Promise<Page> => openChatOnModel(context, pick, PICKS);

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
        await page.close();
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
          let evidence = `reply: ${clip(outcome.replyText)}`;
          if (!inputIntact) {
            result = "FAIL";
            evidence = `stored input differs from what was typed: ${clip(stored ?? "")}`;
          } else if (turn === RUNNING_TOTAL_TURN) {
            const ok = contains(outcome.replyText, "2,065", "2065");
            result = ok ? "PASS" : "FAIL";
            evidence = `running total 2,065 ${ok ? "present" : "absent"}; reply: ${clip(
              outcome.replyText,
            )}`;
          } else if (turn === RENT_RECALL_TURN) {
            const ok = contains(outcome.replyText, "1,450", "1450");
            result = ok ? "PASS" : "FAIL";
            evidence = `rent figure from turn 2 ${ok ? "recalled" : "lost"}; reply: ${clip(
              outcome.replyText,
            )}`;
          }
          push(rowFor(2, turn, `turn ${turn}: ${clip(prompt, 48)}`, outcome, result, evidence));
        }
        await page.close();
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
        await page.close();
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
        await page.close();
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
        await page.close();
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
        await page.close();
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
        await page.close();
      });

      // ── 9. A factual question, lookups off then on ────────────────────────
      await task(9, "web lookups off, then on", async () => {
        const question = "Who wrote the novel Frankenstein?";

        const offPage = await open();
        const off = await sendTurn(offPage, question);
        const firedOff = (await citations(offPage).count()) > 0;
        push(
          rowFor(
            9,
            1,
            "lookups off: nothing should fire",
            off,
            firedOff ? "FAIL" : "RECORDED",
            firedOff
              ? "a source card appeared with lookups off"
              : `no source card; the answer reads: ${clip(off.replyText, 240)}`,
          ),
        );
        await offPage.close();

        const settings = await context.newPage();
        await settings.goto(`${BASE_URL}/settings`, { waitUntil: "commit" });
        const toggle = settings.getByRole("switch", { name: "Toggle web fact lookups" });
        await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT_MS });
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "true", {
          timeout: READY_TIMEOUT_MS,
        });
        await settings.close();

        const onPage = await open();
        const on = await sendTurn(onPage, question, LONG_TURN_TIMEOUT_MS);
        const sourceCard = await citations(onPage).count();
        push(
          rowFor(
            9,
            2,
            "lookups on: a source card should appear",
            on,
            sourceCard > 0 ? "PASS" : "RECORDED",
            sourceCard > 0
              ? `${sourceCard} source card(s); answer: ${clip(on.replyText, 200)}`
              : `no source card fired; answer: ${clip(on.replyText, 200)}`,
          ),
        );
        await onPage.close();

        // Leave the device as we found it — lookups are off by default.
        const reset = await context.newPage();
        await reset.goto(`${BASE_URL}/settings`, { waitUntil: "commit" });
        const resetToggle = reset.getByRole("switch", { name: "Toggle web fact lookups" });
        await expect(resetToggle).toBeVisible({ timeout: READY_TIMEOUT_MS });
        if ((await resetToggle.getAttribute("aria-checked")) === "true") {
          await resetToggle.click();
          await expect(resetToggle).toHaveAttribute("aria-checked", "false", {
            timeout: READY_TIMEOUT_MS,
          });
        }
        await reset.close();
      });

      // ── 10. Kill the tab mid-generation, reopen ───────────────────────────
      await task(10, "no wedge after a tab dies mid-reply", async () => {
        const victim = await open();
        await composer(victim).click();
        await victim.keyboard.insertText(
          "Write a detailed paragraph about the history of the bicycle.",
        );
        await victim.getByRole("button", { name: "Send message" }).click();
        await expect(
          stopButton(victim),
          "generation never started, so nothing was killed mid-reply",
        ).toBeVisible({ timeout: TURN_TIMEOUT_MS });
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
        await revived.close();
      });

      // ── 7. Offline reload — LAST, because it ends the page ────────────────
      // A known gap: today the reloaded tab cannot serve chat offline. Recorded
      // as an expected failure so the run still reports, and so the day it
      // starts passing is visible in the table rather than in someone's memory.
      await task(7, "reload the tab offline", async () => {
        const page = await open();
        await context.setOffline(true);
        let usable = false;
        let detail = "";
        try {
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
        push({
          task: 7,
          turn: 1,
          label: "offline reload serves chat",
          modelId: pick.modelId,
          firstTokenMs: null,
          kvReason: null,
          result: usable ? "PASS" : "EXPECTED-FAIL",
          evidence: usable ? detail : `offline reload did not reach a working chat: ${detail}`,
        });
        await page.close().catch(() => undefined);
      });

      // The exit status follows the report, or the report is a wish. A walk
      // whose table carries FAIL rows must end red — an EXPECTED-FAIL is the
      // one verdict that is allowed not to, because it names a gap that is
      // already known and being tracked.
      const failures = pickReport.rows.filter((row) => row.result === "FAIL");
      expect(
        failures.map(
          (row) => `task ${row.task}.${row.turn} — ${row.label}: ${clip(row.evidence, 120)}`,
        ),
        `${pick.tileName} recorded failures; the full table is in test-results/acceptance-report.md`,
      ).toEqual([]);
    });
  }
});
