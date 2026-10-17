// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The Safari walk's hands: the same steps as `../lib/walk`, over WebDriver.
 *
 * Every step keeps walk.ts's rule for "done" and its timeouts — a turn is over
 * when the composer is back, Stop is gone and no receipt is still being
 * recorded; a reply is read from the app's own storage before the DOM — so the
 * judges in `../lib/tasks` see the same observations from either driver. What
 * differs is only how a person's action reaches the page:
 *
 * - Typing sets the composer's value the way a paste does (the native value
 *   setter plus an `input` event), which is what Playwright's `insertText`
 *   amounts to. WebDriver's own send-keys would turn a newline into Enter and
 *   send a multi-line prompt early.
 * - Pressing a button is a real WebDriver click on the Mac. On an iPhone,
 *   WebDriver taps do not reach the page, so the button is clicked from
 *   script there (Send by submitting its form).
 * - A new conversation is the app's own new-chat shortcut, dispatched to the
 *   page. A synthesised key event reaches the app's handler but never Safari's
 *   own Cmd+N, which would open a window.
 */

import { READY_TIMEOUT_MS, SETUP_TIMEOUT_MS, TURN_TIMEOUT_MS } from "../../e2e-perf/lib/session";
import {
  activeModelIdInPage,
  newGenerationStartedInPage,
  newestGenerationIdInPage,
  readLatestExchangeInPage,
  receiptsOfNewGenerationInPage,
} from "../lib/in-page";
import type { Pick, TurnOutcome } from "../lib/tasks";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  RESIDENCY_SETTLE_MS,
  STOP_AFTER_FIRST_WORDS_MS,
  STOP_SETTLE_MS,
  type StopResult,
} from "../lib/walk";
import type { SafariTarget } from "./target";
import { isSessionDeath, type SafariSession } from "./webdriver";

/** One Safari tab walking one model. */
export type SafariChat = {
  session: SafariSession;
  target: SafariTarget;
  baseUrl: string;
  log: (line: string) => void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── In the page ────────────────────────────────────────────────────────────
// Self-contained: each travels to the page as source text (see ../lib/in-page).

/** Everything the walk polls, in one round trip. */
export function chatStateInPage() {
  const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="Message input"]')
    ?? document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Ask Eco anything"]');
  const log = document.querySelector('[role="log"][aria-label="Chat messages"]');
  const bubbles = log ? Array.from(log.querySelectorAll<HTMLElement>('[data-message-role="assistant"]')) : [];
  const last = bubbles.length > 0 ? bubbles[bubbles.length - 1] : undefined;
  const prelude = last?.querySelector('[data-testid="thinking-prelude"], [data-testid="loading-prelude"]');
  const errorSurface = document.querySelector("[data-eco-setup-error-surface]");
  const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
  const perf = window.__ecoPerf;
  return {
    path: location.pathname,
    composer: composer !== null,
    composerEnabled: composer !== null && !composer.disabled,
    sendEnabled: send !== null && !send.disabled,
    stop: document.querySelector('button[aria-label="Stop generating"]') !== null,
    welcome: document.querySelector('[role="dialog"][aria-label="Welcome to Eco — choose your model"]') !== null,
    setupError: errorSurface ? errorSurface.textContent.replace(/\s+/g, " ").slice(0, 300) : null,
    assistantCount: bubbles.length,
    lastReplyHasWords: last !== undefined && !prelude && last.innerText.trim().length > 0,
    perfVersion: perf?.version ?? null,
    pending: perf ? perf.pendingReceipts() : null,
    triggerLabel: document.querySelector('[data-testid="model-selector"]')?.getAttribute("aria-label") ?? null,
    slots: {
      "eco-fast": localStorage.getItem("eco-local-ai-slot-eco-fast"),
      "eco-smart": localStorage.getItem("eco-local-ai-slot-eco-smart"),
    },
    slotStatus: {
      "eco-fast": localStorage.getItem("eco-local-ai-slot-status-eco-fast"),
      "eco-smart": localStorage.getItem("eco-local-ai-slot-status-eco-smart"),
    },
  };
}

export type ChatState = ReturnType<typeof chatStateInPage>;

/** Set the composer's value the way a paste does, and say how long it now is. */
export function typeIntoComposerInPage(text: string): number {
  const box = document.querySelector<HTMLTextAreaElement>('[aria-label="Message input"]')
    ?? document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Ask Eco anything"]');
  if (!box) return -1;
  box.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  return box.value.length;
}

/**
 * Mark the first element matching `css` whose text (or accessible label)
 * contains `text`, so a real WebDriver click can find it by
 * `[data-eco-lane-mark]`. Returns whether one was found.
 *
 * `scope` narrows the search to one element of a list — the newest reply
 * (`index: -1`), say, or the person's first message (`index: 0`) — the way a
 * Playwright locator chained off `.last()` or `.nth(i)` does.
 */
export function markInPage(
  css: string,
  text: string,
  scope?: { css: string; index: number },
): boolean {
  for (const old of Array.from(document.querySelectorAll("[data-eco-lane-mark]"))) {
    old.removeAttribute("data-eco-lane-mark");
  }
  let root: ParentNode | undefined = document;
  if (scope) {
    const all = Array.from(document.querySelectorAll(scope.css));
    root = all[scope.index < 0 ? all.length + scope.index : scope.index];
  }
  if (!root) return false;
  const needle = text.toLowerCase();
  const found = Array.from(root.querySelectorAll<HTMLElement>(css)).find((element) =>
    `${element.getAttribute("aria-label") ?? ""} ${element.innerText}`.toLowerCase().includes(needle),
  );
  if (!found) return false;
  found.setAttribute("data-eco-lane-mark", "1");
  return true;
}

/** Click the marked element from script — the iPhone path, where taps do not reach the page. */
export function clickMarkedInPage(): boolean {
  const element = document.querySelector<HTMLElement>("[data-eco-lane-mark]");
  if (!element) return false;
  if (element instanceof HTMLButtonElement && element.type === "submit" && element.form) {
    element.form.requestSubmit(element);
  } else {
    element.click();
  }
  return true;
}

/**
 * How many elements match `css` — optionally inside one element of `within`:
 * the `index`-th, or counting back from the end when negative (-1 = newest).
 *
 * An argument left out arrives as `null`, not `undefined`: WebDriver carries
 * the arguments as JSON, which has no `undefined`. Treating that null as a
 * selector counted nothing, so every unscoped count read 0.
 */
export function countInPage(css: string, within?: string | null, index = -1): number {
  if (within === undefined || within === null) return document.querySelectorAll(css).length;
  const scopes = Array.from(document.querySelectorAll(within));
  const scope = scopes[index < 0 ? scopes.length + index : index];
  return scope ? scope.querySelectorAll(css).length : 0;
}

/** An attribute of the LAST element matching `css`, or null. */
export function lastAttributeInPage(css: string, name: string): string | null {
  const all = Array.from(document.querySelectorAll(css));
  return all[all.length - 1]?.getAttribute(name) ?? null;
}

/** The text of the FIRST element matching `css`, or null. */
export function firstTextInPage(css: string): string | null {
  return document.querySelector<HTMLElement>(css)?.innerText ?? null;
}

/** Every element's text matching `css`, in document order. */
export function allTextsInPage(css: string): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(css)).map((element) => element.innerText);
}

/** Set a text field's value as \`fill\` does (native setter plus \`input\`), and say how long it now is. */
export function fillInPage(css: string, text: string): number {
  const field = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(css);
  if (!field) return -1;
  field.focus();
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return field.value.length;
}

/** Write (or, with null, remove) one localStorage key. */
export function setStorageInPage(key: string, value: string | null): void {
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}

/** Whether a localStorage key is set. */
export function storageHasInPage(key: string): boolean {
  return window.localStorage.getItem(key) !== null;
}

/**
 * Start a fresh record of the page's resource timings: a buffer large enough
 * that a turn's requests are never dropped, emptied of what came before.
 */
export function resetResourceTimingsInPage(): void {
  performance.setResourceTimingBufferSize(10_000);
  performance.clearResourceTimings();
}

/**
 * The lookup requests the page made to Wikipedia/Wikidata since the last
 * reset, read from its OWN resource timings — not a network observer, so a
 * request the page never issued, or one made outside this page, is not here.
 */
export function lookupRequestsInPage(): string[] {
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /wikipedia|wikidata|wikimedia/i.test(name))
    .map((name) => name.slice(0, 140));
}

/** The app's new-chat shortcut (Cmd/Ctrl+N, `useKeyboardShortcuts`), dispatched to the page. */
export function newChatShortcutInPage(): void {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true, cancelable: true }),
  );
}

/** The newest exact-answer card's text, or null when the transcript has none. */
export function lastToolCardInPage(): string | null {
  const log = document.querySelector('[role="log"][aria-label="Chat messages"]');
  const cards = log ? Array.from(log.querySelectorAll<HTMLElement>('[data-testid="canonical-tool-answer"]')) : [];
  const card = cards[cards.length - 1];
  return card ? card.innerText : null;
}

/** The newest reply as the DOM shows it, its "stopped" notice, Try again, and any error card. */
export function lastReplyInPage(): {
  text: string;
  stoppedNotice: string;
  tryAgainOffered: boolean;
  errorCard: boolean;
} {
  const log = document.querySelector('[role="log"][aria-label="Chat messages"]');
  const bubbles = log ? Array.from(log.querySelectorAll<HTMLElement>('[data-message-role="assistant"]')) : [];
  const bubble = bubbles[bubbles.length - 1];
  if (!bubble) return { text: "", stoppedNotice: "", tryAgainOffered: false, errorCard: false };
  const notice = Array.from(bubble.querySelectorAll<HTMLElement>('[role="status"]')).find((element) =>
    /stopped/i.test(element.textContent),
  );
  const tryAgainOffered = Array.from(bubble.querySelectorAll<HTMLElement>("button")).some((button) =>
    (button.getAttribute("aria-label") ?? button.textContent).toLowerCase().includes("try again"),
  );
  return {
    text: bubble.innerText,
    stoppedNotice: notice ? notice.innerText : "",
    tryAgainOffered,
    errorCard: bubble.querySelector('[role="alert"]') !== null,
  };
}

// ── In the lane ────────────────────────────────────────────────────────────

/** The page's state, or null while it cannot answer (mid-navigation). A dead session throws. */
export async function chatState(chat: SafariChat): Promise<ChatState | null> {
  try {
    return await chat.session.run(chatStateInPage);
  } catch (error) {
    if (isSessionDeath(error)) throw error;
    return null;
  }
}

/**
 * Poll the page until `ready` says so, or fail with `message` and the last
 * state seen — the Safari form of Playwright's `expect(...).toPass`.
 */
export async function until(
  chat: SafariChat,
  ready: (state: ChatState) => boolean,
  timeoutMs: number,
  message: string,
  everyMs = 250,
): Promise<ChatState> {
  const deadline = Date.now() + timeoutMs;
  let last: ChatState | null = null;
  for (;;) {
    const state = await chatState(chat);
    if (state !== null) {
      last = state;
      if (ready(state)) return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`${message} (after ${Math.round(timeoutMs / 1000)} s; last seen ${JSON.stringify(last).slice(0, 400)})`);
    }
    await sleep(everyMs);
  }
}

/**
 * Press the element matching `css` whose text or label contains `text`, the
 * way this device lets a person press it. Returns false when there is none.
 */
export async function press(
  chat: SafariChat,
  css: string,
  text: string,
  options: { scope?: { css: string; index: number }; hoverFirst?: boolean } = {},
): Promise<boolean> {
  if (!(await chat.session.run(markInPage, css, text, options.scope))) return false;
  if (chat.target === "ios") return chat.session.run(clickMarkedInPage);
  await ensureInFront(chat, true);
  const element = await chat.session.find("[data-eco-lane-mark]");
  if (element === null) return false;
  if (options.hoverFirst) await chat.session.hover(element);
  await chat.session.click(element);
  return true;
}

/** Where the page is and how it begins, for an error message. */
export function pageSummaryInPage(): string {
  return `${location.pathname}${location.search} — ${document.body.innerText.replace(/\s+/g, " ").slice(0, 240)}`;
}

/** Whether the page is on screen, and whether it has focus (so a real click on it will land). */
export function frontStateInPage(): { visible: boolean; focused: boolean } {
  return { visible: document.visibilityState === "visible", focused: document.hasFocus() };
}

/** How long a walk waits for its Safari window to come back to the front. */
const FRONT_WAIT_MS = 15 * 60_000;

/**
 * Wait until the walk's page is in front: on screen and, for a click, focused.
 * Safari drops a click on a page whose window is not the active one, silently,
 * and runs a hidden page differently, so a reading taken behind another app
 * says nothing about the app. Someone using this Mac during a run takes the
 * front; the walk then waits (and says so) rather than record a wrong row,
 * and stops with a plain reason if the window never comes back.
 */
export async function ensureInFront(chat: SafariChat, needFocus: boolean): Promise<void> {
  const ok = (state: { visible: boolean; focused: boolean }) => state.visible && (!needFocus || state.focused);
  if (ok(await chat.session.run(frontStateInPage))) return;
  await chat.session.focus();
  const deadline = Date.now() + FRONT_WAIT_MS;
  let said = false;
  for (;;) {
    const state = await chat.session.run(frontStateInPage);
    if (ok(state)) return;
    if (!said) {
      console.log(`  waiting: the Safari window is not in front (${JSON.stringify(state)}); leave the Mac to the walk`);
      said = true;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the Safari window stayed out of the front for ${FRONT_WAIT_MS / 60_000} min, so the walk cannot click `
          + "or read the page (is someone using this Mac, or a window in the way?)",
      );
    }
    await sleep(5_000);
    await chat.session.focus();
  }
}

/**
 * Poll an in-page reading until `ready` accepts it, or fail with `message`
 * and the last value seen. A reading that cannot be taken (mid-navigation)
 * counts as not ready; a dead session throws.
 */
export async function pollInPage<A extends unknown[], R>(
  chat: SafariChat,
  ready: (value: R) => boolean,
  timeoutMs: number,
  message: string,
  fn: (...args: A) => R | Promise<R>,
  ...args: A
): Promise<R> {
  const deadline = Date.now() + timeoutMs;
  let last: R | undefined;
  for (;;) {
    try {
      last = await chat.session.run(fn, ...args);
      if (ready(last)) return last;
    } catch (error) {
      if (isSessionDeath(error)) throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(`${message} (after ${Math.round(timeoutMs / 1000)} s; last seen ${JSON.stringify(last ?? null).slice(0, 300)})`);
    }
    await sleep(250);
  }
}

/** The trigger names the model, and the runtime holds it. */
async function expectModelInUse(chat: SafariChat, pick: Pick, what: string): Promise<void> {
  await until(
    chat,
    (state) => (state.triggerLabel ?? "").includes(pick.friendlyName),
    READY_TIMEOUT_MS,
    `the switcher never claimed to be running ${pick.friendlyName}`,
  );
  const deadline = Date.now() + RESIDENCY_SETTLE_MS;
  let active: string | null = null;
  while (Date.now() < deadline) {
    active = await chat.session.run(activeModelIdInPage);
    if (active === pick.modelId) return;
    await sleep(500);
  }
  throw new Error(`${what} did not leave ${pick.modelId} resident in the runtime (it holds ${active ?? "nothing"})`);
}

/** The harness bridge is there, or this is the wrong build — say so at once. */
async function requireBridge(chat: SafariChat): Promise<void> {
  await until(
    chat,
    (state) => state.perfVersion === 2,
    READY_TIMEOUT_MS,
    "window.__ecoPerf missing — the server must be a production build started with "
      + "NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true, opened on a loopback host",
  );
}

/**
 * Wait until the workspace is usable, and fail if it is a dead end — the
 * Safari form of `waitForUsableChat`, including its answer to the first-run
 * choice: pick `preferredTileName` if it is offered, then "Start with …".
 */
async function waitForUsableChat(chat: SafariChat, preferredTileName: string): Promise<void> {
  const first = await until(
    chat,
    (state) => state.composer || state.setupError !== null || state.welcome,
    SETUP_TIMEOUT_MS,
    "chat never showed a composer, a welcome card or a setup error",
  );
  if (first.welcome) {
    const dialog = '[role="dialog"][aria-label="Welcome to Eco — choose your model"]';
    await press(chat, `${dialog} [role="radio"]`, preferredTileName);
    if (!(await press(chat, `${dialog} button`, "Start with "))) {
      throw new Error("the welcome card offered no 'Start with …' button");
    }
  }
  const usable = await until(
    chat,
    (state) => state.composer || state.setupError !== null,
    SETUP_TIMEOUT_MS,
    "chat never became usable after the first-run choice",
  );
  if (usable.setupError !== null) {
    throw new Error(`chat opened onto a setup error surface — a first-run dead end: ${usable.setupError}`);
  }
  await requireBridge(chat);
}

/**
 * The genuine first run: an empty Safari profile opens /chat, answers the
 * first-run choice, and waits until the app reports its model ready and
 * resident. Returns how long that took, download included.
 *
 * The model must be this device's own pick: a first run that set up anything
 * else would make every row after it describe the wrong model, so it stops
 * the walk here, by name.
 */
export async function firstRun(chat: SafariChat, pick: Pick): Promise<number> {
  const startedAt = Date.now();
  await chat.session.navigate(`${chat.baseUrl}/chat`);
  await waitForUsableChat(chat, pick.tileName);
  const ready = await until(
    chat,
    (state) => {
      const status = state.slotStatus[pick.slot];
      if (status === "error") throw new Error(`setting up ${pick.modelId} ended in 'error'`);
      if (state.setupError !== null) throw new Error(`setup error surface during the first run: ${state.setupError}`);
      return status === "ready";
    },
    DOWNLOAD_TIMEOUT_MS,
    `${pick.friendlyName} was not ready after the first run's download`,
    2_000,
  );
  if (ready.slots[pick.slot] !== pick.modelId) {
    throw new Error(
      `the first run set up ${ready.slots[pick.slot] ?? "nothing"} in ${pick.slot}; this device's pick is ${pick.modelId}`,
    );
  }
  await expectModelInUse(chat, pick, "the first run");
  return Date.now() - startedAt;
}

/** The chat transcript, the log every message selector is scoped to (`chatLog` in e2e-perf). */
export const CHAT_LOG = '[role="log"][aria-label="Chat messages"]';
export const ASSISTANT_MESSAGES = `${CHAT_LOG} [data-message-role="assistant"]`;
export const USER_MESSAGES = `${CHAT_LOG} [data-message-role="user"]`;

/** Land on /chat again in this tab (after the tab was replaced) and wait for the model. */
export async function reopenChat(chat: SafariChat, pick: Pick): Promise<void> {
  await chat.session.navigate(`${chat.baseUrl}/chat`);
  await waitForUsableChat(chat, pick.tileName);
  await expectModelInUse(chat, pick, "reopening chat");
}

/**
 * Replace the walk's tab with a fresh one — the Safari form of closing a page
 * after a failure that may have jammed the runtime. The old tab is closed, so
 * its model is released, and the new one is current but blank.
 */
export async function replaceTab(chat: SafariChat): Promise<void> {
  const fresh = await chat.session.newTab();
  await chat.session.closeCurrentTab();
  await chat.session.switchTo(fresh);
}

/** Start a fresh conversation without reloading — the app's own new-chat shortcut. */
export async function startNewConversation(chat: SafariChat): Promise<void> {
  await until(chat, (state) => state.composerEnabled, TURN_TIMEOUT_MS, "the composer never re-enabled");
  await chat.session.run(newChatShortcutInPage);
  await until(chat, (state) => state.assistantCount === 0, 30_000, "the new-chat shortcut did not clear the transcript");
  await until(chat, (state) => state.composerEnabled, 30_000, "the composer did not come back after a new chat");
}

export async function newestGenerationId(chat: SafariChat): Promise<string | null> {
  return chat.session.run(newestGenerationIdInPage);
}

/** Type a prompt into the composer and press Send. */
async function submitPrompt(chat: SafariChat, prompt: string): Promise<void> {
  const length = await chat.session.run(typeIntoComposerInPage, prompt);
  if (length !== prompt.length) {
    throw new Error(`the composer holds ${length} characters after typing ${prompt.length}`);
  }
  await until(chat, (state) => state.sendEnabled, 10_000, "Send never enabled after typing");
  if (!(await press(chat, 'button[aria-label="Send message"]', "Send message"))) {
    throw new Error("there was no Send button to press");
  }
}

/** The turn is over: the composer is back, Stop is gone, and no receipt is still being recorded. */
async function settleTurn(chat: SafariChat, timeoutMs: number): Promise<void> {
  await until(
    chat,
    (state) => state.composerEnabled && !state.stop && state.pending === 0,
    timeoutMs,
    "turn never finalized — the composer stayed disabled, Stop stayed up, or a receipt never landed",
  );
}

/** Read back everything about the generation that started after `generationIdBefore`. */
async function collectOutcome(
  chat: SafariChat,
  prompt: string,
  generationIdBefore: string | null,
): Promise<TurnOutcome> {
  await ensureInFront(chat, false);
  const receipts = await chat.session.run(receiptsOfNewGenerationInPage, generationIdBefore);
  const toolCardText = await chat.session.run(lastToolCardInPage);
  const stored = await chat.session.run(readLatestExchangeInPage);
  const domReply = (await chat.session.run(lastReplyInPage)).text;
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

/** Type one turn, wait for it to finish, and read back everything about it (walk.ts `sendTurn`). */
export async function sendTurn(
  chat: SafariChat,
  prompt: string,
  timeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
): Promise<TurnOutcome> {
  const before = await until(
    chat,
    (state) => state.composerEnabled,
    timeoutMs,
    "composer never re-enabled — the previous turn never finalized",
  );
  const generationIdBefore = await newestGenerationId(chat);
  await submitPrompt(chat, prompt);
  await until(
    chat,
    (state) => state.assistantCount === before.assistantCount + 1,
    timeoutMs,
    "no reply bubble appeared for the turn",
  );
  await sleep(300);
  await settleTurn(chat, timeoutMs);
  return collectOutcome(chat, prompt, generationIdBefore);
}

/** Send a prompt and return once the reply has started (Stop is showing). */
export async function beginTurn(
  chat: SafariChat,
  prompt: string,
  notStartedMessage = "the reply never started",
): Promise<void> {
  await until(
    chat,
    (state) => state.composerEnabled,
    DEFAULT_TURN_TIMEOUT_MS,
    "composer never re-enabled — the previous turn never finalized",
  );
  await submitPrompt(chat, prompt);
  await until(chat, (state) => state.stop, TURN_TIMEOUT_MS, notStartedMessage);
}

/** Press Stop the way a person does: once words are on screen, not before (walk.ts `stopMidReply`). */
export async function stopMidReply(
  chat: SafariChat,
  timeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
): Promise<StopResult> {
  await until(
    chat,
    (state) => state.lastReplyHasWords,
    timeoutMs,
    "the reply never showed a word, so there was nothing to stop mid-reply",
  );
  await sleep(STOP_AFTER_FIRST_WORDS_MS);

  const pressed = await press(chat, 'button[aria-label="Stop generating"]', "Stop generating").catch(
    (error: unknown) => {
      if (isSessionDeath(error)) throw error;
      return false;
    },
  );
  if (!pressed) {
    return { stopped: false, reason: "the reply finished before Stop could be pressed" };
  }
  const pressedAt = Date.now();
  await until(chat, (state) => !state.stop, STOP_SETTLE_MS, "Stop was pressed but the reply kept going");
  await until(chat, (state) => state.composerEnabled, STOP_SETTLE_MS, "the composer did not come back after Stop");
  return { stopped: true, settledMs: Date.now() - pressedAt };
}

/**
 * Wait for a generation started by something other than Send to finish, and
 * read it back — keyed on a NEW receipt, as walk.ts `finishGeneration` is.
 */
export async function finishGeneration(
  chat: SafariChat,
  prompt: string,
  generationIdBefore: string | null,
  timeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
): Promise<TurnOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (!(await chat.session.run(newGenerationStartedInPage, generationIdBefore))) {
    if (Date.now() > deadline) {
      throw new Error(`no new generation recorded within ${Math.round(timeoutMs / 1000)} s`);
    }
    await sleep(250);
  }
  await settleTurn(chat, timeoutMs);
  return collectOutcome(chat, prompt, generationIdBefore);
}

/** The newest reply's DOM: its text, "stopped" notice, Try again and error card. */
export async function lastReply(chat: SafariChat): Promise<ReturnType<typeof lastReplyInPage>> {
  return chat.session.run(lastReplyInPage);
}

/** The Eco tab of Settings, where both web switches live (`components/settings/settingsNavigation`). */
const SETTINGS_MODELS_PATH = "/settings?tab=models";

/**
 * Turn a Settings switch on or off in THIS tab, read it back after a reload,
 * and return to chat — walk.ts `setSettingSwitchInTab`, step for step: the
 * preference is hydrated per tab at mount and written encrypted and
 * asynchronously, so "the switch moved" and "the setting is on" are two
 * claims, and only the reload's read-back makes the next turn mean anything.
 * A read-back that never settles is reported, not thrown.
 */
async function setSettingSwitchInTab(
  chat: SafariChat,
  enabled: boolean,
  pick: Pick,
  control: { switchName: string; describe: string },
): Promise<boolean> {
  const want = String(enabled);
  const css = `[role="switch"][aria-label="${control.switchName}"]`;
  const checked = () =>
    pollInPage(chat, () => true, READY_TIMEOUT_MS, `${control.describe} could not be read`, lastAttributeInPage, css, "aria-checked");

  await chat.session.navigate(`${chat.baseUrl}${SETTINGS_MODELS_PATH}`);
  await pollInPage(
    chat,
    (count) => count > 0,
    READY_TIMEOUT_MS,
    `${control.describe} was not on the Eco tab of Settings`,
    countInPage,
    css,
  ).catch(async (error: unknown) => {
    if (isSessionDeath(error)) throw error;
    // Say what the page showed instead, so a miss here can be read from the row.
    const seen = await chat.session.run(pageSummaryInPage).catch(() => "(unreadable)");
    throw new Error(`${error instanceof Error ? error.message : String(error)}; the page showed: ${seen}`);
  });
  if ((await checked()) !== want) {
    await press(chat, css, "");
  }
  await pollInPage(
    chat,
    (value) => value === want,
    READY_TIMEOUT_MS,
    `${control.describe} never read ${want}`,
    lastAttributeInPage,
    css,
    "aria-checked",
  );

  await chat.session.refresh();
  await pollInPage(chat, (count) => count > 0, READY_TIMEOUT_MS, `${control.describe} did not come back after a reload`, countInPage, css);
  await pollInPage(chat, (value) => value === want, 30_000, "", lastAttributeInPage, css, "aria-checked").catch(
    (error: unknown) => {
      // Not an error here: the caller's row reports what the setting actually is.
      if (isSessionDeath(error)) throw error;
    },
  );
  const settled = (await checked()) === "true";

  await reopenChat(chat, pick);
  return settled;
}

/** Web fact lookups (Wikipedia, straight from the browser), set in this tab. */
export function setWebLookupsInTab(chat: SafariChat, enabled: boolean, pick: Pick): Promise<boolean> {
  return setSettingSwitchInTab(chat, enabled, pick, {
    switchName: "Toggle web fact lookups",
    describe: "the web-lookups switch",
  });
}

/** Web search (the question as typed, to Eco's relay), set in this tab. */
export function setWebSearchInTab(chat: SafariChat, enabled: boolean, pick: Pick): Promise<boolean> {
  return setSettingSwitchInTab(chat, enabled, pick, {
    switchName: "Toggle web search",
    describe: "the Web search switch",
  });
}

/**
 * Edit one of the person's own messages the way they would: hover it to
 * reveal its actions, press Edit, replace the text, press Save & Submit —
 * walk.ts `editUserMessage`.
 */
export async function editUserMessage(chat: SafariChat, index: number, text: string): Promise<void> {
  const scope = { css: USER_MESSAGES, index };
  if (!(await press(chat, 'button[aria-label="Edit message"]', "Edit message", { scope, hoverFirst: true }))) {
    throw new Error(`user message ${index} offered no Edit button`);
  }
  const box = `${USER_MESSAGES} textarea[aria-label="Edit message"]`;
  await pollInPage(chat, (count) => count > 0, 10_000, "pressing Edit did not open the message for editing", countInPage, box);
  const length = await chat.session.run(fillInPage, box, text);
  if (length !== text.length) {
    throw new Error(`the edit box holds ${length} characters after filling ${text.length}`);
  }
  if (!(await press(chat, 'button[aria-label="Save & Submit"]', "Save & Submit", { scope }))) {
    throw new Error("the edit offered no Save & Submit button");
  }
}

/** Press Try again on the newest reply. */
export async function pressTryAgain(chat: SafariChat): Promise<boolean> {
  return press(chat, "button", "Try again", { scope: { css: ASSISTANT_MESSAGES, index: -1 } });
}

/** The localStorage key of the harness's one-shot reply fault (walk.ts `armGenerationFault`). */
const GENERATION_FAULT_KEY = "eco-force-generation-fault";

/** Make the next reply fail after its first word. It fires once, then clears itself. */
export async function armGenerationFault(chat: SafariChat): Promise<void> {
  await chat.session.run(setStorageInPage, GENERATION_FAULT_KEY, "mid-reply");
}

/** Whether the fault is still waiting to fire — it should not be, once a reply has run. */
export async function generationFaultArmed(chat: SafariChat): Promise<boolean> {
  return chat.session.run(storageHasInPage, GENERATION_FAULT_KEY);
}

/** Count matching elements, optionally inside the newest reply. */
export async function count(chat: SafariChat, css: string, inLastReply = false): Promise<number> {
  return chat.session.run(countInPage, css, inLastReply ? ASSISTANT_MESSAGES : undefined);
}
