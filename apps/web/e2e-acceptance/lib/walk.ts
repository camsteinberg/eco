// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The acceptance lane's hands: how it opens a chat on a chosen model, types a
 * turn, decides the turn is over, and reads back what the app actually stored.
 *
 * The measurement plumbing (persistent real Chrome, stubbed auth, empty
 * workspace per page, receipt-based turn completion) is shared with the perf
 * lane and imported from `../../e2e-perf/lib/session`. Everything here is what
 * the acceptance walk needs on top of it: turns that may legitimately produce
 * NO generation (a tool answers them), replies read from storage rather than
 * from the DOM, and the model-switcher flow a person actually uses.
 */

import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { GenerationReceipt } from "../../src/local-ai/lifecycle/generation-receipt";
import { VALIDATION_GENERATION_FAULT_MESSAGE } from "../../src/lib/validation-harness";
import {
  FORCED_DESKTOP_PROFILE,
  READY_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  assistantMessages,
  chatLog,
  composer,
  getWebBaseUrl,
  requireBridge,
} from "../../e2e-perf/lib/session";

/** A model download over a domestic connection can take a while. */
export const DOWNLOAD_TIMEOUT_MS = 1_800_000;

/**
 * How long a freshly opened page gets to load its model. Measured need with the
 * bytes cached: ~4 s for the 2.6B on this Mac, so this is ~45x headroom.
 */
export const RESIDENCY_SETTLE_MS = 180_000;

/**
 * Default ceiling for one turn. Measured turns on this Mac run 5-9 s wall on
 * either model; the ceiling exists to end a wedged turn, not to accommodate a
 * slow one, and `TURN_TIMEOUT_MS` from the perf lane was too tight to tell the
 * two apart.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 300_000;

export type SlotName = "eco-fast" | "eco-smart";

export type Pick = {
  /** Catalog id. */
  modelId: string;
  /** The slot this model is the shipping choice for. */
  slot: SlotName;
  /** The name on its tile in the model switcher. */
  tileName: string;
  /** The name the switcher trigger's accessible label uses. */
  friendlyName: string;
};

export const setupErrorSurface = (page: Page) =>
  page.locator("[data-eco-setup-error-surface]");
export const welcomeCard = (page: Page) =>
  page.getByRole("dialog", { name: "Welcome to Eco — choose your model" });
export const canonicalToolAnswers = (page: Page) =>
  chatLog(page).locator('[data-testid="canonical-tool-answer"]');
export const citations = (page: Page) =>
  chatLog(page).locator('[data-testid="grounding-citation"]');
export const webSearchCitations = (page: Page) =>
  chatLog(page).locator('[data-testid="web-search-citation"]');
/** The honest "couldn't confirm this" notes, optionally narrowed to one status. */
export const uncertaintyNotes = (page: Page, status?: string) =>
  chatLog(page).locator(
    status === undefined
      ? '[data-testid="uncertainty-note"]'
      : `[data-testid="uncertainty-note"][data-status="${status}"]`,
  );
export const webSearchToggle = (page: Page) => page.getByTestId("web-search-toggle");
export const contextDivider = (page: Page) =>
  chatLog(page).getByRole("note", { name: "Context window boundary" });
export const contextWindowNotice = (page: Page) =>
  page.locator('[data-testid="context-window-notice"]');
export const modelSelectorTrigger = (page: Page) =>
  page.getByTestId("model-selector");
export const stopButton = (page: Page) =>
  page.getByRole("button", { name: "Stop generating" });
export const userMessages = (page: Page) =>
  chatLog(page).locator('[data-message-role="user"]');
/** The retry a person is offered on a reply that failed or was stopped. */
export const tryAgainOn = (bubble: Locator) =>
  bubble.getByRole("button", { name: "Try again" });

/**
 * The device query every chat page opens with. The ONNX walk forces a WebGPU
 * desktop Chrome profile so model selection is deterministic. The WebLLM run
 * clears it: forcing the browser class would override the desktop-Safari user
 * agent that routes the app to its WebLLM models.
 */
let deviceQuery: string = FORCED_DESKTOP_PROFILE;

export function setDeviceQuery(query: string): void {
  deviceQuery = query;
}

function chatUrl(): string {
  return `${getWebBaseUrl()}/chat${deviceQuery ? `?${deviceQuery}` : ""}`;
}

/**
 * Open /chat with a specific model already bound to its slot.
 *
 * The binding is written by an init script rather than by a write-then-reload,
 * so the app never boots once with a different selection: there is no window in
 * which recommendation could bind a slot first and no reload to race. The four
 * keys are the app's own persisted selection state (`local-ai/lifecycle/slots`
 * and the chat store), and `eco-selected-model-explicit` is what stops the
 * recommender from overriding a deliberate choice.
 *
 * The bytes must already be present: a slot marked ready whose model is not
 * downloaded would send the runtime looking for them mid-turn. `provisionPick`
 * is what puts them there, through the UI a person uses.
 */
export async function openChatOnModel(
  context: BrowserContext,
  pick: Pick,
  bindings: readonly Pick[] = [pick],
): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(
    ({ slot, bound }) => {
      window.sessionStorage.setItem("eco-skip-conversation-persistence-once", "true");
      for (const entry of bound) {
        window.localStorage.setItem(`eco-local-ai-slot-${entry.slot}`, entry.modelId);
        window.localStorage.setItem(`eco-local-ai-slot-status-${entry.slot}`, "ready");
      }
      window.localStorage.setItem("eco-selected-model", slot);
      window.localStorage.setItem("eco-selected-model-explicit", "true");
    },
    {
      slot: pick.slot,
      bound: bindings.map((entry) => ({ slot: entry.slot, modelId: entry.modelId })),
    },
  );
  await page.goto(chatUrl(), { waitUntil: "commit" });
  await waitForUsableChat(page);

  // Two things must agree before the walk types anything: the app's own claim
  // about what is running (the switcher label), and the runtime actually
  // holding it. Measured on this lane's profile with the bytes cached, the
  // 2.6B is resident about four seconds after the composer appears, so the
  // budget below is generous by a wide margin — it is here to fail fast and
  // legibly, not to wait out a slow machine.
  await expectTriggerNames(page, pick);
  await expect
    .poll(() => page.evaluate(() => window.__ecoPerf?.activeModelId() ?? null), {
      timeout: RESIDENCY_SETTLE_MS,
      message: `chat did not leave ${pick.modelId} resident in the runtime`,
    })
    .toBe(pick.modelId);
  return page;
}

/**
 * Wait until the workspace is usable, and fail if it is a dead end.
 *
 * "Usable" is the composer accepting input — not the empty-state greeting,
 * which stops rendering the moment a conversation is open. A visible setup
 * error surface is the dead end task 1 exists to rule out.
 */
export async function waitForUsableChat(
  page: Page,
  preferredTileName?: string,
): Promise<void> {
  const welcome = welcomeCard(page);
  await expect(
    composer(page).or(setupErrorSurface(page)).or(welcome).first(),
  ).toBeVisible({ timeout: SETUP_TIMEOUT_MS });

  // A genuinely cold device is asked to choose before anything downloads. That
  // choice is part of the first run, not an obstacle to it — answer it the way
  // a person would and carry on. A profile with a slot already bound never
  // reaches here.
  if ((await welcome.count()) > 0) {
    if (preferredTileName !== undefined) {
      const tile = welcome.getByRole("radio").filter({ hasText: preferredTileName }).first();
      if ((await tile.count()) > 0) await tile.click();
    }
    await welcome.getByRole("button", { name: /^Start with / }).click();
  }

  await expect(composer(page).or(setupErrorSurface(page)).first()).toBeVisible({
    timeout: SETUP_TIMEOUT_MS,
  });
  await expect(
    setupErrorSurface(page),
    "chat opened onto a setup error surface — a first-run dead end",
  ).toHaveCount(0);
  await requireBridge(page);
}

export type TurnOutcome = {
  prompt: string;
  /** What the app STORED as the user's message. Judge a reply only against this. */
  storedUserText: string | null;
  replyText: string;
  replySource: "indexeddb" | "dom";
  /** Every receipt this turn produced, in execution order. Empty on a tool answer. */
  receipts: GenerationReceipt[];
  /** True when the turn was answered by a deterministic tool, not by generation. */
  toolAnswered: boolean;
  /** The exact-answer card's text when the turn produced one. */
  toolCardText: string | null;
};

/** The receipt whose output the person saw, or null on a tool-answered turn. */
export function outcomeReceipt(outcome: TurnOutcome): GenerationReceipt | null {
  return outcome.receipts[outcome.receipts.length - 1] ?? null;
}

export function kvReasonOf(receipt: GenerationReceipt | null): string | null {
  const kv = receipt?.kvReuse;
  if (!kv) return null;
  return kv.reason ? `${kv.decision}/${kv.reason}` : kv.decision;
}

/**
 * Type one turn, wait for it to finish, and read back everything about it.
 *
 * Typing: `insertText` rather than `pressSequentially`, because the latter
 * treats a newline as Enter and would submit a pasted block line by line.
 * `fill` is avoided for the same class of reason — it replaces the draft, so it
 * is only safe when nothing else is writing to the composer.
 *
 * Finishing: a NEW assistant bubble, then the composer re-enabled with no
 * "Stop generating" button and no receipt still mid-hash. The short settle
 * before those checks matters — the composer disables a tick after the click,
 * so testing it immediately can read the idle state and call an unstarted turn
 * finished. Counting receipts is not a valid wait either: a tool-answered turn
 * records none at all.
 */
export async function sendTurn(
  page: Page,
  prompt: string,
  timeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
): Promise<TurnOutcome> {
  await expect(composer(page), {
    message: "composer never re-enabled — the previous turn never finalized",
  }).toBeEnabled({ timeout: timeoutMs });

  const bubblesBefore = await assistantMessages(page).count();
  const generationIdBefore = await newestGenerationId(page);

  await submitPrompt(page, prompt);

  await expect(assistantMessages(page)).toHaveCount(bubblesBefore + 1, {
    timeout: timeoutMs,
  });
  await page.waitForTimeout(300);
  await settleTurn(page, timeoutMs);
  return collectOutcome(page, prompt, generationIdBefore);
}

/** Type a prompt into the composer and press Send. */
async function submitPrompt(page: Page, prompt: string): Promise<void> {
  await composer(page).click();
  await page.keyboard.insertText(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
}

/**
 * The newest generation's id. Read it before an action that starts a
 * generation, so the generation that action starts can be told from the last.
 */
export async function newestGenerationId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__ecoPerf?.receipts(1)[0]?.generationId ?? null);
}

/** The turn is over: the composer is back, Stop is gone, and no receipt is still being recorded. */
async function settleTurn(page: Page, timeoutMs: number): Promise<void> {
  await expect(composer(page), {
    message: "turn never finalized — the composer stayed disabled",
  }).toBeEnabled({ timeout: timeoutMs });
  await expect(stopButton(page)).toHaveCount(0, { timeout: timeoutMs });
  await page.waitForFunction(
    () => (window.__ecoPerf?.pendingReceipts() ?? 1) === 0,
    undefined,
    { timeout: timeoutMs, polling: 50 },
  );
}

/** Read back everything about the generation that started after `generationIdBefore`. */
async function collectOutcome(
  page: Page,
  prompt: string,
  generationIdBefore: string | null,
): Promise<TurnOutcome> {
  const receipts = await page.evaluate((previousId) => {
    const all = window.__ecoPerf?.receipts() ?? [];
    const newest = all[0];
    if (!newest || newest.generationId === previousId) return [];
    return all.filter((r) => r.generationId === newest.generationId).reverse();
  }, generationIdBefore);

  const card = canonicalToolAnswers(page).last();
  const toolCardText =
    (await canonicalToolAnswers(page).count()) > 0 ? await card.innerText() : null;

  const stored = await readLatestExchange(page);
  const domReply = await assistantMessages(page).last().innerText();

  return {
    prompt,
    storedUserText: stored?.user ?? null,
    replyText: stored?.assistant ?? domReply,
    replySource: stored?.assistant === undefined ? "dom" : "indexeddb",
    receipts,
    toolAnswered: receipts.length === 0,
    toolCardText,
  };
}

/**
 * Send a prompt and return as soon as the reply has started — the moment a
 * person can act on it, by pressing Stop or closing the tab. Started means the
 * Stop button is showing.
 */
export async function beginTurn(
  page: Page,
  prompt: string,
  notStartedMessage = "the reply never started",
): Promise<void> {
  await expect(composer(page), {
    message: "composer never re-enabled — the previous turn never finalized",
  }).toBeEnabled({ timeout: DEFAULT_TURN_TIMEOUT_MS });
  await submitPrompt(page, prompt);
  await expect(stopButton(page), notStartedMessage).toBeVisible({ timeout: TURN_TIMEOUT_MS });
}

/** How long the reply runs after its first words before Stop is pressed. */
const STOP_AFTER_FIRST_WORDS_MS = 1_000;

/**
 * How long the app gets to hand the composer back after Stop. Stop is meant to
 * take effect at once; ten seconds is there to fail legibly, not to be waited.
 */
export const STOP_SETTLE_MS = 10_000;

export type StopResult =
  | { stopped: true; settledMs: number }
  | { stopped: false; reason: string };

/**
 * Press Stop the way a person does: once words are on screen, not before.
 *
 * Waits for the reply's first visible words — the bubble's thinking/loading
 * prelude gone and text showing — lets it run a second more, then presses
 * Stop and waits for the composer to come back. Returns how long that took,
 * or why Stop could not be pressed: a reply that finished first leaves nothing
 * to stop, and the task has to say so rather than pass.
 */
export async function stopMidReply(
  page: Page,
  timeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
): Promise<StopResult> {
  const reply = assistantMessages(page).last();
  const prelude = reply.locator(
    '[data-testid="thinking-prelude"], [data-testid="loading-prelude"]',
  );
  await expect
    .poll(
      async () => (await prelude.count()) === 0 && (await reply.innerText()).trim().length > 0,
      {
        timeout: timeoutMs,
        message: "the reply never showed a word, so there was nothing to stop mid-reply",
      },
    )
    .toBe(true);
  await page.waitForTimeout(STOP_AFTER_FIRST_WORDS_MS);

  const pressed = await stopButton(page)
    .click({ timeout: 2_000 })
    .then(
      () => true,
      () => false,
    );
  if (!pressed) {
    return { stopped: false, reason: "the reply finished before Stop could be pressed" };
  }
  const pressedAt = Date.now();
  await expect(stopButton(page), "Stop was pressed but the reply kept going").toHaveCount(0, {
    timeout: STOP_SETTLE_MS,
  });
  await expect(composer(page), "the composer did not come back after Stop").toBeEnabled({
    timeout: STOP_SETTLE_MS,
  });
  return { stopped: true, settledMs: Date.now() - pressedAt };
}

/**
 * Wait for a generation started by something other than Send — Stop, Try
 * again, or an edit's Save & Submit — to finish, and read it back.
 *
 * Keyed on a NEW receipt rather than a new bubble: a retry or an edit replaces
 * the bubble it answers instead of adding one, and Try again starts its
 * generation only after the card's half-second animation, so the composer can
 * still look idle when this is called.
 */
export async function finishGeneration(
  page: Page,
  prompt: string,
  generationIdBefore: string | null,
  timeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
): Promise<TurnOutcome> {
  await page.waitForFunction(
    (previousId) => {
      const newest = window.__ecoPerf?.receipts(1)[0];
      return newest !== undefined && newest.generationId !== previousId;
    },
    generationIdBefore,
    { timeout: timeoutMs, polling: 100 },
  );
  await settleTurn(page, timeoutMs);
  return collectOutcome(page, prompt, generationIdBefore);
}

/** The localStorage key of the harness's one-shot reply fault (`consumeValidationGenerationFault`). */
const GENERATION_FAULT_KEY = "eco-force-generation-fault";

/** The text a reply failed by the harness carries, so its receipt can be told from a genuine failure. */
export const INJECTED_FAULT_MESSAGE = VALIDATION_GENERATION_FAULT_MESSAGE;

/** Make the next reply fail after its first word. It fires once, then clears itself. */
export async function armGenerationFault(page: Page): Promise<void> {
  await page.evaluate((key) => window.localStorage.setItem(key, "mid-reply"), GENERATION_FAULT_KEY);
}

/** Whether the fault is still waiting to fire — it should not be, once a reply has run. */
export async function generationFaultArmed(page: Page): Promise<boolean> {
  return page.evaluate((key) => window.localStorage.getItem(key) !== null, GENERATION_FAULT_KEY);
}

/**
 * Edit one of the person's own messages the way they would: hover it to
 * reveal its actions (they are hidden until then on a desktop), press Edit,
 * replace the text, and press Save & Submit.
 */
export async function editUserMessage(page: Page, index: number, text: string): Promise<void> {
  const bubble = userMessages(page).nth(index);
  await bubble.hover();
  await bubble.getByRole("button", { name: "Edit message" }).click();
  const box = bubble.getByRole("textbox", { name: "Edit message" });
  await expect(box, "pressing Edit did not open the message for editing").toBeVisible({
    timeout: 10_000,
  });
  await box.fill(text);
  await bubble.getByRole("button", { name: "Save & Submit" }).click();
}

/**
 * Check, from outside the browser, that each URL the app will fetch for a model
 * answers. Throws with every failing URL and its status, plus `remedy`, so a
 * model whose files were never put on the host fails in seconds and says why —
 * not after a download timeout, and never by quietly walking something else.
 */
export async function assertModelFilesServed(
  pick: Pick,
  urls: readonly string[],
  remedy: string,
): Promise<string> {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url, { method: "HEAD" });
        return { url, status: String(response.status), ok: response.ok };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { url, status: `unreachable (${reason})`, ok: false };
      }
    }),
  );
  const missing = results.filter((result) => !result.ok);
  if (missing.length > 0) {
    throw new Error(
      `${pick.friendlyName} (${pick.modelId}) cannot be walked: its model files are not served — `
        + `${missing.map((result) => `${result.status} ${result.url}`).join("; ")}. ${remedy}`,
    );
  }
  return results.map((result) => `${result.status} ${result.url}`).join("; ");
}

/**
 * Put a model on the device by asking for it, the way a slot that is still
 * preparing does: bind the slot to the model in a `preparing` state, open
 * chat, and let the app download and check it until the slot reads `ready`.
 *
 * This is how the WebLLM run provisions. Its models are not on the welcome
 * card, and the switcher's tiles for them have not been walked, while a
 * preparing slot is the app's own path to a model it was told to get.
 *
 * Fails at once, naming the URL and status, when the app's own request for one
 * of the model's files is refused — a refused file is not retried, so waiting
 * on would only end in a vaguer timeout.
 */
export async function provisionBySeeding(
  context: BrowserContext,
  pick: Pick,
  remedy: string,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS,
): Promise<void> {
  const page = await context.newPage();
  const refused: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/resolve/") && response.status() >= 400) {
      refused.push(`${response.status()} ${response.url()}`);
    }
  });
  try {
    await page.addInitScript(
      ({ slot, modelId }) => {
        window.sessionStorage.setItem("eco-skip-conversation-persistence-once", "true");
        window.localStorage.setItem(`eco-local-ai-slot-${slot}`, modelId);
        window.localStorage.setItem(`eco-local-ai-slot-status-${slot}`, "preparing");
        window.localStorage.setItem("eco-selected-model", slot);
        window.localStorage.setItem("eco-selected-model-explicit", "true");
      },
      { slot: pick.slot, modelId: pick.modelId },
    );
    await page.goto(chatUrl(), { waitUntil: "commit" });

    const deadline = Date.now() + timeoutMs;
    let status: string | null = null;
    while (Date.now() < deadline) {
      if (refused.length > 0) {
        throw new Error(
          `${pick.friendlyName} (${pick.modelId}) could not be set up: the app's requests for its files were `
            + `refused — ${refused.slice(0, 3).join("; ")}. ${remedy}`,
        );
      }
      status = await page.evaluate(
        (slot) => window.localStorage.getItem(`eco-local-ai-slot-status-${slot}`),
        pick.slot,
      );
      if (status === "ready") return;
      if (status === "error") {
        throw new Error(
          `${pick.friendlyName} (${pick.modelId}) could not be set up on this device: its slot ended in 'error'.`,
        );
      }
      await page.waitForTimeout(2_000);
    }
    throw new Error(
      `${pick.friendlyName} (${pick.modelId}) was not ready after ${Math.round(timeoutMs / 60_000)} min `
        + `(slot status '${status ?? "unset"}').`,
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Read the last user/assistant pair from the app's own storage.
 *
 * Storage, not `innerText`: the sidebar renders conversation previews that
 * match reply text, and a DOM read that is not tightly scoped picks those up
 * first. Returns null when nothing is stored (which is itself worth recording),
 * and the caller falls back to a scoped DOM read.
 */
export async function readLatestExchange(
  page: Page,
): Promise<{ user?: string; assistant?: string } | null> {
  return page.evaluate(async () => {
    type Row = {
      role: string;
      content: string;
      createdAt: number;
      conversationId: string;
    };
    const open = (): Promise<IDBDatabase | null> =>
      new Promise((resolve) => {
        const request = indexedDB.open("eco-chat");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onupgradeneeded = () => {
          // The database does not exist yet; abandon rather than create one.
          request.transaction?.abort();
          resolve(null);
        };
      });
    const db = await open();
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains("messages")) return null;
      const rows = await new Promise<Row[]>((resolve) => {
        const tx = db.transaction("messages", "readonly");
        const req = tx.objectStore("messages").getAll();
        req.onsuccess = () => resolve(req.result as Row[]);
        req.onerror = () => resolve([]);
      });
      if (rows.length === 0) return null;
      const newest = rows.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
      const inConversation = rows
        .filter((r) => r.conversationId === newest.conversationId)
        .sort((a, b) => a.createdAt - b.createdAt);
      const assistant = [...inConversation].reverse().find((r) => r.role === "assistant");
      const user = [...inConversation].reverse().find((r) => r.role === "user");
      const result: { user?: string; assistant?: string } = {};
      if (user) result.user = user.content;
      if (assistant) result.assistant = assistant.content;
      return result;
    } finally {
      db.close();
    }
  });
}

/**
 * Erase everything this origin stored — including cached model bytes.
 *
 * Done through CDP rather than in-page script because a page that can run the
 * script is also a page holding open database connections, and `deleteDatabase`
 * blocks on those. Used once, before the first walk, so the run starts from a
 * device that has never seen Eco.
 */
export async function wipeOrigin(context: BrowserContext, page: Page): Promise<void> {
  const session = await context.newCDPSession(page);
  await session.send("Storage.clearDataForOrigin", {
    origin: new URL(getWebBaseUrl()).origin,
    storageTypes: "all",
  });
  await session.detach();
}

/**
 * Put the walk's model bytes on the device the way a person does: open the
 * switcher, tap the tile, confirm the download, and switch when it is ready.
 *
 * Returns the tile's state before the walk touched it, so a report can say
 * whether this run downloaded the model or found it already present.
 */
export async function provisionPick(page: Page, pick: Pick): Promise<"downloaded" | "present"> {
  await modelSelectorTrigger(page).click();
  const option = page.getByRole("option").filter({ hasText: pick.tileName }).first();
  await expect(option, `no switcher tile named "${pick.tileName}"`).toBeVisible({
    timeout: READY_TIMEOUT_MS,
  });
  await option.locator("button").first().click();

  const needsDownload = await confirmInTile(option, pick);

  await expectTriggerNames(page, pick);
  return needsDownload ? "downloaded" : "present";
}

/**
 * Walk the in-tile confirm flow after a tile tap, whatever state the tile is in.
 *
 * A model whose bytes are absent answers the tap with "Download", then shows
 * "Ready. Switch now" once the bytes land; one whose bytes are present switches
 * immediately and shows neither. A third state exists and bit this lane on a
 * cold run (2026-09-04): bytes that finished downloading AFTER an earlier
 * provisioning attempt gave up leave the tile already on "Ready. Switch now"
 * with no "Download" step first. Clicking only after a "Download" click missed
 * it and the walk waited on a switch nobody confirmed. So: click "Download" if
 * it is there, then click "Ready. Switch now" if it is there, and treat neither
 * as an immediate switch.
 *
 * Returns whether this call started a download.
 */
async function confirmInTile(option: Locator, pick: Pick): Promise<boolean> {
  const download = option.getByRole("button", { name: "Download", exact: true });
  const ready = option.getByRole("button", { name: "Ready. Switch now" });

  // The tile re-renders on the tap; give either confirm a moment to appear.
  await download
    .or(ready)
    .first()
    .waitFor({ state: "visible", timeout: TILE_CONFIRM_SETTLE_MS })
    .catch(() => undefined);

  const needsDownload = await download.isVisible().catch(() => false);
  if (needsDownload) {
    await download.click();
    await expect(ready, `${pick.tileName} never finished downloading`).toBeVisible({
      timeout: DOWNLOAD_TIMEOUT_MS,
    });
  }
  if (await ready.isVisible().catch(() => false)) {
    await ready.click();
  }
  return needsDownload;
}

/** How long a tapped tile gets to show its confirm button before it counts as an immediate switch. */
const TILE_CONFIRM_SETTLE_MS = 5_000;

/**
 * Wait for the switcher trigger to claim this model is what's running.
 *
 * This is the app's own claim, and it is the only thing a switch settles
 * promptly — see `switchTo` for why residency is the wrong signal to wait on.
 */
async function expectTriggerNames(page: Page, pick: Pick): Promise<void> {
  await expect(modelSelectorTrigger(page), {
    message: `the switcher never claimed to be running ${pick.friendlyName}`,
  }).toHaveAttribute("aria-label", new RegExp(escapeForRegExp(pick.friendlyName)), {
    timeout: READY_TIMEOUT_MS,
  });
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Switch models through the switcher, and return the trigger's label.
 *
 * What a switch settles immediately is the SELECTION, not what is loaded. The
 * trigger renames itself within a second or two; the runtime keeps the previous
 * model resident until the next turn needs the new one. Measured by hand on
 * this lane's own profile: after clicking the Eco Deeper tile the label read
 * "running Eco Deeper (Liquid)" in under three seconds while `activeModelId()`
 * still answered with the 1.2B two minutes later. Waiting on residency here
 * waits for something that only happens on the next generation.
 *
 * So this waits for the label — the app's own claim about what is running — and
 * the caller checks that claim against the NEXT receipt's `modelId`. Copy that
 * says one thing while the runtime runs another is exactly what task 8 is
 * looking for, which makes it the task's assertion, not this helper's
 * precondition.
 *
 * A model whose bytes are absent answers the tap with an in-tile confirm rather
 * than a switch, so the two-step flow is handled here too.
 */
export async function switchTo(page: Page, pick: Pick): Promise<string> {
  await modelSelectorTrigger(page).click();
  const option = page.getByRole("option").filter({ hasText: pick.tileName }).first();
  await expect(option).toBeVisible({ timeout: READY_TIMEOUT_MS });
  await option.locator("button").first().click();

  await confirmInTile(option, pick);

  await expectTriggerNames(page, pick);
  return (await modelSelectorTrigger(page).getAttribute("aria-label")) ?? "";
}

/**
 * Turn web fact lookups on or off the way a person does, in THIS tab, and
 * report whether the setting survived a reload.
 *
 * Two things make the tab matter. The switch is not on the chat page — it is
 * on the Eco tab of Settings, `?tab=models` (see
 * `components/settings/settingsNavigation`) — and the preference is hydrated
 * into a per-tab store at mount. Flipping it in a SECOND tab therefore leaves
 * the chat tab still believing what it believed when it loaded: the setting is
 * persisted correctly, but an already-open tab does not learn about it. A
 * person flips it and navigates back in the same tab, which is what this does.
 *
 * The read-back is the point of the reload: the value is written encrypted and
 * asynchronously, so "the switch moved" and "the setting is on" are different
 * claims, and only the second one makes the next turn mean anything. A
 * read-back that never settles is reported, not thrown — the row should be
 * able to say the setting did not take.
 */
export async function setWebLookupsInTab(
  page: Page,
  enabled: boolean,
  pick: Pick,
): Promise<boolean> {
  return setSettingSwitchInTab(page, enabled, pick, {
    switchName: "Toggle web fact lookups",
    describe: "the web-lookups switch",
  });
}

/**
 * Turn Web search on or off the same way, on the same tab, with the same
 * read-back.
 *
 * Same mechanics as the lookups switch and for the same reasons — the control
 * lives on the Eco tab of Settings, the preference is hydrated per tab at
 * mount, and the write is encrypted and asynchronous, so "the switch moved" and
 * "the setting is on" are two different claims. It is a DIFFERENT setting from
 * web lookups, though: that one fetches Wikipedia straight from the browser,
 * this one sends the question as typed to Eco's relay. A task that confuses them would
 * pass while measuring the wrong path.
 */
export async function setWebSearchInTab(
  page: Page,
  enabled: boolean,
  pick: Pick,
): Promise<boolean> {
  return setSettingSwitchInTab(page, enabled, pick, {
    switchName: "Toggle web search",
    describe: "the Web search switch",
  });
}

async function setSettingSwitchInTab(
  page: Page,
  enabled: boolean,
  pick: Pick,
  control: { switchName: string; describe: string },
): Promise<boolean> {
  const want = String(enabled);
  const switchOn = (target: Page) =>
    target.getByRole("switch", { name: control.switchName });

  await page.goto(`${getWebBaseUrl()}/settings?tab=models`, { waitUntil: "commit" });
  await expect(
    switchOn(page),
    `${control.describe} was not on the Eco tab of Settings`,
  ).toBeVisible({ timeout: READY_TIMEOUT_MS });
  if ((await switchOn(page).getAttribute("aria-checked")) !== want) {
    await switchOn(page).click();
  }
  await expect(switchOn(page)).toHaveAttribute("aria-checked", want, {
    timeout: READY_TIMEOUT_MS,
  });

  await page.reload({ waitUntil: "commit" });
  await expect(switchOn(page)).toBeVisible({ timeout: READY_TIMEOUT_MS });
  try {
    await expect(switchOn(page)).toHaveAttribute("aria-checked", want, {
      timeout: 30_000,
    });
  } catch {
    // Not an error here: the caller's row reports what the setting actually is.
  }
  const settled = (await switchOn(page).getAttribute("aria-checked")) === "true";

  await returnToChat(page, pick);
  return settled;
}

/** Navigate this tab back to a ready chat on the walk's model. */
export async function returnToChat(page: Page, pick: Pick): Promise<void> {
  await page.goto(chatUrl(), { waitUntil: "commit" });
  await waitForUsableChat(page);
  await expectTriggerNames(page, pick);
  await expect
    .poll(() => page.evaluate(() => window.__ecoPerf?.activeModelId() ?? null), {
      timeout: RESIDENCY_SETTLE_MS,
      message: `returning to chat did not leave ${pick.modelId} resident`,
    })
    .toBe(pick.modelId);
}

/**
 * Start a fresh conversation without reloading the app.
 *
 * The walk used to open a new page per task. That is not what a person does,
 * and it cost far more than tidiness: every page loads the model into its own
 * worker, so a ten-task walk asked the machine for ten copies of a 1-2 GB model
 * and the browser eventually gave out mid-run — a first token measured at
 * 186 seconds on a model that answers in under one, and then a closed context.
 *
 * Cmd/Ctrl+N is the product's own new-chat shortcut (`useKeyboardShortcuts`),
 * and it fires even while the composer has focus. Measured on this lane's
 * profile: the transcript empties without a navigation and the next turn on a
 * 2.6B model returns its first token in ~0.7 s.
 */
export async function startNewConversation(page: Page): Promise<void> {
  await expect(composer(page)).toBeEnabled({ timeout: TURN_TIMEOUT_MS });
  await page.keyboard.press("Meta+n");
  await expect(assistantMessages(page), "Cmd+N did not clear the transcript").toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
}

/**
 * Count the lookup requests a turn sent straight to the sources.
 *
 * Grounding is the one path that leaves the device, so "did a source card
 * appear" deserves a second, independent witness: whether any request actually
 * went to Wikipedia. A card with no request, or a request with no card, are
 * different findings and the row should be able to tell them apart.
 */
/** The fetched-at the stubbed relay reports, so the chip's value is checkable. */
export const WEB_SEARCH_STUB_FETCHED_AT = "2026-09-11T14:32:00.000Z";

/** Three results in the relay's own shape (`apps/api/src/routes/search.ts`). */
export const WEB_SEARCH_STUB_RESULTS = [
  {
    title: "Chicago weather — current conditions",
    url: "https://example.invalid/chicago-weather",
    snippet: "Light rain is falling across the Chicago area this afternoon.",
    domain: "example.invalid",
  },
  {
    title: "Chicago radar",
    url: "https://example.invalid/chicago-radar",
    snippet: "Radar shows a band of showers moving east over the city.",
    domain: "example.invalid",
  },
  {
    title: "Illinois forecast",
    url: "https://example.invalid/illinois-forecast",
    snippet: "Showers taper off this evening with clearing overnight.",
    domain: "example.invalid",
  },
] as const;

/** One call the app made to the relay, as the route handler saw it. */
export type SearchRelayCall = {
  method: string;
  /** The raw request body, so a task can assert what was in it, not just that it went. */
  body: string | null;
};

/**
 * Stand in for the search relay, and record every call to it.
 *
 * The lane must never reach a real relay. Not for politeness: a live engine
 * makes the task's evidence depend on the weather in Chicago and on whether an
 * engine rate-limited us, and neither of those is the product behaviour the
 * task is asking about. A fixed payload makes "the chip showed the fetched-at
 * time" and "the note was joined onto the prompt" mechanical checks.
 *
 * Recording the body matters as much as fulfilling it. The whole privacy claim
 * for this feature is that a search carries the question as typed and nothing else,
 * so the task asserts the parsed body's key set — and an interception is the
 * only place that can see it.
 */
export async function stubSearchRelay(context: BrowserContext): Promise<{
  reset: () => void;
  calls: () => SearchRelayCall[];
  dispose: () => Promise<void>;
}> {
  let calls: SearchRelayCall[] = [];
  const pattern = "**/v1/search";
  await context.route(pattern, async (route) => {
    calls.push({ method: route.request().method(), body: route.request().postData() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        fetchedAt: WEB_SEARCH_STUB_FETCHED_AT,
        results: WEB_SEARCH_STUB_RESULTS,
      }),
    });
  });
  return {
    reset: () => {
      calls = [];
    },
    calls: () => [...calls],
    dispose: () => context.unroute(pattern),
  };
}

export function watchLookupRequests(context: BrowserContext): {
  reset: () => void;
  urls: () => string[];
} {
  let seen: string[] = [];
  context.on("request", (request) => {
    if (/wikipedia|wikidata|wikimedia/i.test(request.url())) {
      seen.push(request.url().slice(0, 140));
    }
  });
  return {
    reset: () => {
      seen = [];
    },
    urls: () => [...seen],
  };
}
