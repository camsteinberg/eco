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

import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { GenerationReceipt } from "../../src/local-ai/lifecycle/generation-receipt";
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
export const contextDivider = (page: Page) =>
  chatLog(page).getByRole("note", { name: "Context window boundary" });
export const contextWindowNotice = (page: Page) =>
  page.locator('[data-testid="context-window-notice"]');
export const modelSelectorTrigger = (page: Page) =>
  page.getByTestId("model-selector");
export const stopButton = (page: Page) =>
  page.getByRole("button", { name: "Stop generating" });

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
  await page.goto(`${getWebBaseUrl()}/chat?${FORCED_DESKTOP_PROFILE}`, {
    waitUntil: "commit",
  });
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
  const generationIdBefore = await page.evaluate(
    () => window.__ecoPerf?.receipts(1)[0]?.generationId ?? null,
  );

  await composer(page).click();
  await page.keyboard.insertText(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(assistantMessages(page)).toHaveCount(bubblesBefore + 1, {
    timeout: timeoutMs,
  });
  await page.waitForTimeout(300);
  await expect(composer(page), {
    message: "turn never finalized — the composer stayed disabled",
  }).toBeEnabled({ timeout: timeoutMs });
  await expect(stopButton(page)).toHaveCount(0, { timeout: timeoutMs });
  await page.waitForFunction(
    () => (window.__ecoPerf?.pendingReceipts() ?? 1) === 0,
    undefined,
    { timeout: timeoutMs, polling: 50 },
  );

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

  // A model whose bytes are absent answers the tap with an in-tile confirm
  // rather than a switch; one whose bytes are present switches immediately.
  const download = option.getByRole("button", { name: "Download", exact: true });
  const needsDownload = await download.isVisible().catch(() => false);
  if (needsDownload) {
    await download.click();
    await expect(
      option.getByRole("button", { name: "Ready. Switch now" }),
      `${pick.tileName} never finished downloading`,
    ).toBeVisible({ timeout: DOWNLOAD_TIMEOUT_MS });
    await option.getByRole("button", { name: "Ready. Switch now" }).click();
  }

  await expectTriggerNames(page, pick);
  return needsDownload ? "downloaded" : "present";
}

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

  const download = option.getByRole("button", { name: "Download", exact: true });
  if (await download.isVisible().catch(() => false)) {
    await download.click();
    const ready = option.getByRole("button", { name: "Ready. Switch now" });
    await expect(ready, `${pick.tileName} never finished downloading`).toBeVisible({
      timeout: DOWNLOAD_TIMEOUT_MS,
    });
    await ready.click();
  }

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
  const want = String(enabled);
  const switchOn = (target: Page) =>
    target.getByRole("switch", { name: "Toggle web fact lookups" });

  await page.goto(`${getWebBaseUrl()}/settings?tab=models`, { waitUntil: "commit" });
  await expect(
    switchOn(page),
    "the web-lookups switch was not on the Eco tab of Settings",
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
  await page.goto(`${getWebBaseUrl()}/chat?${FORCED_DESKTOP_PROFILE}`, {
    waitUntil: "commit",
  });
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
