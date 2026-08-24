// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, type Page } from "@playwright/test";
import { openMenu } from "../capture";
import type { CaptureGap, StateAssertion, StateEntry } from "../types";
import { READY_CHAT_SEARCH } from "./pilot";

/**
 * W3b — what happens when somebody touches the chat.
 *
 * W3 photographs a conversation at rest; pilot proves the hover and menu
 * mechanisms on one fixture reply. This wave is the states in between: a
 * message being copied or edited, a composer carrying a draft or an attachment,
 * the share dialog and its two failures, and the first-run welcome and tour.
 *
 * ── Which server each entry needs ─────────────────────────────────────────
 *
 * The same split W3 documents at length: a conversation that is ALREADY active
 * when `/chat` mounts renders nothing on the dev server, because
 * `useConversationManager`'s load effect stamps its request id above its own
 * early return and React StrictMode's second invocation invalidates the load the
 * first one started. Every entry here that needs a seeded conversation is
 * therefore `server: 'prod'`, exactly like W3's. Everything that happens on an
 * EMPTY chat — the whole composer and attachment family, the drag overlay, the
 * welcome overlay, the tour's first step — runs on either server.
 *
 * ── Three findings these captures produced ────────────────────────────────
 *
 * 1. The tour is two steps. These captures found a third one authored against
 *    `[aria-label="Privacy information"]`, an element no component in the app
 *    declares, so it was filtered out at launch and never rendered; it has since
 *    been deleted from `OnboardingTour`. What ships is the model selector and —
 *    on a conversation, where it exists — the impact footer, which is why
 *    `tour-step-impact` is the SECOND popover.
 *
 *    A step whose target is not mounted is still dropped, and the filter runs
 *    once, when the tour launches, so WHEN it launches can still decide how long
 *    the tour is. A `?tour=1` launch on a conversation beat the transcript's own
 *    mount on the mobile projects and produced a one-step tour there and a
 *    two-step tour on desktop, from the same URL. `tour-step-impact` starts from
 *    the guide button instead, after the pane is on screen.
 *
 * 2. "More depth" is hidden on the lane's default model, and that is correct.
 *    `canDeepen` compares the model's own quick and deep budgets, and
 *    `local/qwen3-0.6b` caps at 512 new tokens, so both intents clamp to 512 and
 *    a deeper regenerate could not deliver anything. Every existing chat capture
 *    therefore shows the actions row WITHOUT it. `reply-controls-deepen` binds
 *    the 1.2B (2048) to photograph the other half of that rule.
 *
 * 3. A missing conversation used to be reported as a clipboard failure. Both
 *    share errors below are reached by deleting the conversation record while
 *    the dialog is open — a real race (the chat is deleted elsewhere, then
 *    Export is pressed). The copy path caught the same read failure the export
 *    path did and rendered "Copy failed on this browser. Try again.", which was
 *    about a browser that was working fine. `exportConversationAsMarkdown` now
 *    throws a typed `ConversationNotFoundError`, so both paths name the real
 *    cause; these two entries photograph the corrected copy.
 *
 * ── Two surfaces deliberately NOT captured ────────────────────────────────
 *
 * - The "Flag for eval…" menu item. It is gated on `eco-dev-capture`, a dev-only
 *   eval seam rather than a shipping control, so it belongs with the harness
 *   banners W3 excluded for the same reason: an inventory for design review must
 *   not invite critique of copy that never ships.
 * - The impact footer's hidden state. `ImpactFooter` returns an empty div when
 *   the query count is zero, and the empty chat does not render the region that
 *   holds it at all — so "hidden" is pixel-for-pixel `pilot.chat-empty-ready`.
 *   The footer's real state (it appears the moment a conversation has one
 *   finished reply) gets its own element shot instead.
 */

/** The composer textarea — present on an empty chat and on a conversation. */
const COMPOSER = '[aria-label="Message input"]';

/** The composer card itself: chips, the input row, and the attachment alert. */
const COMPOSER_FORM = `form:has(${COMPOSER})`;

/** The hidden input the paperclip clicks. Playwright drives it directly. */
const FILE_INPUT = 'input[type="file"]';

/**
 * The composer's own attachment alert.
 *
 * Scoped to the form on purpose: Next.js's route announcer is also
 * `role="alert"`, so an unscoped role query is a strict-mode violation that
 * only shows up once an entry actually reaches this state.
 */
const ATTACHMENT_ALERT = `${COMPOSER_FORM} [role="alert"]`;

/**
 * A file chip's on-device badge — the proof one attachment finished reading.
 *
 * Selected by its title rather than its text: the privacy control elsewhere on
 * the page also says "On-device", and the two differ only in capitalisation.
 */
const ON_DEVICE_BADGE =
  `${COMPOSER_FORM} [title="This file stays on your device and is read locally for this reply"]`;

/** The seeded conversation these interactions run against, and its two rows. */
const USER_ROW = '[data-message-id="capture-basic-user"]';
const ASSISTANT_ROW = '[data-message-id="capture-basic-assistant"]';

/**
 * A state that interacts with one seeded conversation.
 *
 * Same shape as W3's `seededChat` — ready slot, forced device, upgrade offer
 * settled, prod-only — so the entries below say only what makes them different.
 */
function onSeededChat(
  name: string,
  title: string,
  assert: StateAssertion[],
  overrides: Partial<StateEntry> = {},
): StateEntry {
  return {
    id: `chat-interactions.${name}`,
    group: "chat-interactions",
    title,
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { idb: ["conversation-basic"] },
    tier: "component",
    realism: "seeded",
    // See the header: a conversation already active at mount stays empty on dev.
    server: "prod",
    assert,
    ...overrides,
  };
}

/** A state that starts from an empty, ready chat — no conversation to seed. */
function onEmptyChat(
  name: string,
  title: string,
  overrides: Partial<StateEntry> = {},
): StateEntry {
  return {
    id: `chat-interactions.${name}`,
    group: "chat-interactions",
    title,
    route: "/chat",
    search: READY_CHAT_SEARCH,
    tier: "component",
    realism: "seeded",
    assert: [{ testId: "empty-chat-state" }],
    ...overrides,
  };
}

/** Reveal a message's action row the way a reader does. */
async function revealActions(page: Page, row: string): Promise<void> {
  await page.locator(row).first().hover();
  await expect(page.locator(`${row} [aria-label="More actions"]`).first()).toBeVisible();
}

/** Attach files through the real input, and wait for the composer to react. */
async function attach(
  page: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
): Promise<void> {
  await page.locator(FILE_INPUT).first().setInputFiles(files);
}

/** A plain-text payload of a given length, as a File buffer. */
function textFile(name: string, content: string, mimeType = "text/plain") {
  return { name, mimeType, buffer: Buffer.from(content, "utf8") };
}

/** The share panel, and the export failure it can show inside itself. */
const SHARE_DIALOG = '[role="dialog"][aria-label="Share conversation"]';
const SHARE_ERROR = `${SHARE_DIALOG} [role="alert"]`;

/** Open the share dialog from the header control and wait for the panel. */
async function openShareDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Share conversation" }).first().click();
  await expect(page.getByRole("heading", { name: "Share conversation" })).toBeVisible();
}

/**
 * Delete the open conversation's record from IndexedDB.
 *
 * The honest way into both share failures: every export path re-reads the
 * conversation from the database when the button is pressed, so a chat deleted
 * in the meantime (another tab, a sync) makes the read throw "Conversation not
 * found". Nothing about the browser or the clipboard is faked — the React store
 * still holds the loaded messages, so the transcript behind the dialog is
 * unchanged and the entry's row assertion still holds.
 */
async function deleteActiveConversationRecord(page: Page): Promise<void> {
  await page.evaluate(
    async (conversationId: string) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("eco-chat", 3);
        open.onerror = () => {
          reject(new Error("could not open eco-chat"));
        };
        open.onsuccess = () => {
          const tx = open.result.transaction("conversations", "readwrite");
          tx.objectStore("conversations").delete(conversationId);
          tx.oncomplete = () => {
            resolve();
          };
          tx.onerror = () => {
            reject(new Error("could not delete the conversation record"));
          };
        };
      }),
    "capture-basic",
  );
}

/**
 * Wait for the tour's spotlight to arrive where the popover already is.
 *
 * driver.js cuts its highlight out of a full-screen SVG and moves that cutout
 * with requestAnimationFrame — not a CSS transition — so Playwright's
 * `animations: 'disabled'` cannot fast-forward it. Photographed on the popover
 * alone, the second step came out with its text on the impact footer and its
 * spotlight still around the model selector. Poll the path until it stops
 * moving instead.
 */
async function waitForTourStage(page: Page): Promise<void> {
  const stage = page.locator("svg.driver-overlay path").first();
  let previous = "";
  await expect
    .poll(async () => {
      const outline = (await stage.getAttribute("d")) ?? "";
      const settled = outline.length > 0 && outline === previous;
      previous = outline;
      return settled;
    })
    .toBe(true);
}

/** A draft long enough to grow the composer past its 192px ceiling. */
const LONG_DRAFT = [
  "I'm rewriting the watering guidance for my balcony notes and I want it to be",
  "honest rather than encouraging. Right now it says to water containers every",
  "morning, which is what I was told when I started, but it clearly depends on",
  "the pot, the compost and how much wind the balcony gets. Could you rework it",
  "into something that tells a beginner what to actually check before watering,",
  "explains why the check matters, and says plainly when a container genuinely",
  "does need water twice a day — without hedging every sentence into uselessness?",
  // Two extra sentences so the draft still overflows the 192px ceiling at the
  // widest composer (56rem at xl since the #222 reading column) — the shot
  // proves the CEILING, so the text must wrap past it at every width.
  "Keep the tone of the rest of my notes: short declarative sentences, no",
  "exclamation marks, and no gardening jargon a first-year balcony grower would",
  "have to look up. If a rule of thumb only holds for terracotta, say so",
  "explicitly rather than letting it stand as if it applied to every pot.",
].join(" ");

/** The two surfaces this wave deliberately did not capture, in a printable form. */
export const chatInteractionsGaps: CaptureGap[] = [
  {
    id: "chat-interactions.flag-for-eval",
    group: "chat-interactions",
    surface: "The “Flag for eval…” message-menu item",
    reason:
      "Gated on eco-dev-capture, a dev-only eval seam rather than a shipping control, so it belongs with the harness banners "
      + "W3 excluded for the same reason: an inventory for design review must not invite critique of copy that never ships. "
      + "EXCLUDED ON PURPOSE, not unreachable.",
  },
  {
    id: "chat-interactions.impact-footer-hidden",
    group: "chat-interactions",
    surface: "The impact footer's hidden state",
    reason:
      "ImpactFooter returns an empty div when the query count is zero, and the empty chat does not render the region that "
      + "holds it at all — so 'hidden' is pixel-for-pixel pilot.chat-empty-ready, which the coverage check would (rightly) "
      + "fail as a duplicate. The footer's real state gets its own element shot instead.",
  },
  {
    id: "chat-interactions.tour-step-privacy",
    group: "chat-interactions",
    surface: "A privacy step in the guided tour",
    reason:
      "There is no such step: the tour is two steps on purpose. These captures found a third one authored against "
      + "[aria-label=\"Privacy information\"], an element no component in the app declares, so it was filtered out at launch "
      + "and never rendered; it has since been deleted rather than given a target. Recorded here so a reader counting popovers "
      + "against this manifest knows two is the intended number.",
  },
];

export const chatInteractionsStates: StateEntry[] = [
  // ── What a message's action row can do ──────────────────────────────────
  onSeededChat(
    "message-copied",
    "A reply just after Copy",
    // NOT the copy button: clicking it renames the control from "Copy message"
    // to "Copied", so a name assertion would only be true in the settled phase
    // and would then retry for ten seconds — waiting for the confirmation to
    // time out and photographing the undone state. W3 paid for this lesson once
    // on the code block; assert the message row, which is true in both phases.
    [{ selector: ASSISTANT_ROW }],
    {
      tier: "micro",
      capture: { mode: "element", selector: ASSISTANT_ROW },
      // The confirmation reverts on a two-second timer, and the write itself
      // races a 1.5s timeout. A paused clock stops both. advanceMs runs after
      // settle so the message entrance animations finish before time stops.
      clock: { mode: "paused", advanceMs: 2_000 },
      prepare: async (page) => {
        // Headless Chromium denies clipboard writes by default, and this button
        // — unlike the code block's — only flips on an actual success.
        await page.context().grantPermissions(["clipboard-write"]);
        await revealActions(page, ASSISTANT_ROW);
        await page.locator(`${ASSISTANT_ROW} [aria-label="Copy message"]`).first().click();
        await expect(page.locator(`${ASSISTANT_ROW} [aria-label="Copied"]`).first()).toBeVisible();
      },
      notes:
        "The permission is load-bearing here: this control strips markdown, awaits the real "
        + "clipboard write and leaves itself idle if the write fails, so without the grant the "
        + "state simply never happens.",
    },
  ),
  onSeededChat(
    "user-actions-hover",
    "A question of your own — actions row revealed",
    [{ selector: USER_ROW }],
    {
      tier: "micro",
      capture: { mode: "element", selector: USER_ROW },
      prepare: async (page) => {
        await revealActions(page, USER_ROW);
        // Edit is the control that only a user message has; proving it is on
        // screen is what makes this shot different from the assistant row.
        await expect(page.locator(`${USER_ROW} [aria-label="Edit message"]`).first()).toBeVisible();
      },
      notes: "Real pointer hover — the CSS group-hover reveal does not fire on a synthetic event.",
    },
  ),
  onSeededChat(
    "user-actions-menu",
    "A question's more-actions menu",
    [{ selector: USER_ROW }],
    {
      tier: "micro",
      prepare: async (page) => {
        await revealActions(page, USER_ROW);
        const menu = await openMenu(page, `${USER_ROW} [aria-label="More actions"]`);
        await expect(menu.getByRole("menuitem")).toHaveCount(1);
      },
      notes:
        "One item, where the assistant's menu (pilot.message-actions-menu) has four: the reply "
        + "controls belong to a reply, so a question's menu is Copy as Markdown alone.",
    },
  ),
  onSeededChat(
    "edit-message",
    "Editing a question you already sent",
    [{ selector: USER_ROW }],
    {
      prepare: async (page) => {
        await revealActions(page, USER_ROW);
        await page.getByRole("button", { name: "Edit message" }).first().click();
        await expect(page.locator(`textarea[aria-label="Edit message"]`).first()).toBeVisible();
        // Save is disabled until the text actually changes — an unedited edit is
        // a no-op, and this is the state the mode opens in.
        await expect(page.getByRole("button", { name: "Save & Submit" })).toBeDisabled();
      },
      notes:
        "Component tier rather than micro: on the small viewports the action row is always "
        + "visible, so this is a mode a phone reaches too, and the mode changes the whole bubble.",
    },
  ),
  onSeededChat(
    "edit-message-changed",
    "An edited question, ready to resend",
    [{ selector: USER_ROW }],
    {
      prepare: async (page) => {
        await revealActions(page, USER_ROW);
        await page.getByRole("button", { name: "Edit message" }).first().click();
        const field = page.locator(`textarea[aria-label="Edit message"]`).first();
        await field.fill(
          "Why do I sleep better on days when I've been outside in the morning — and does it "
            + "still work on an overcast day?",
        );
        await expect(page.getByRole("button", { name: "Save & Submit" })).toBeEnabled();
      },
      notes: "The same mode with the Save control live, which is the only pixel difference.",
    },
  ),
  {
    id: "chat-interactions.reply-controls-deepen",
    group: "chat-interactions",
    title: "A reply on a model that can go deeper",
    route: "/chat",
    // The 1.2B, not the lane's usual 0.6B. See the header: "More depth" is
    // offered only where the model's deep budget actually exceeds its quick one,
    // and the 0.6B clamps both to 512 — so this is the ONLY way to photograph
    // the control, and the reason no other chat capture shows it.
    search: READY_CHAT_SEARCH.replace(
      "eco-validation-slot-eco-fast=local/qwen3-0.6b",
      "eco-validation-slot-eco-fast=candidate/lfm2.5-1.2b-instruct-onnx",
    ),
    seed: { idb: ["conversation-basic"] },
    tier: "micro",
    realism: "seeded",
    server: "prod",
    capture: { mode: "element", selector: ASSISTANT_ROW },
    assert: [{ selector: ASSISTANT_ROW }],
    prepare: async (page) => {
      await revealActions(page, ASSISTANT_ROW);
      await expect(page.getByRole("button", { name: "More depth" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Just the answer" })).toBeVisible();
    },
    notes:
      "Both recovery controls at once. 'Just the answer' shows on either model — a reply "
      + "restored from IndexedDB carries no completion-token count, and the rule is to offer "
      + "the control rather than withhold it on state we do not have.",
  },

  // ── The composer, before anything is sent ───────────────────────────────
  onEmptyChat("composer-draft", "A draft waiting to be sent", {
    seed: {
      local: {
        "eco-composer-draft":
          "What should I check before watering a balcony container in August?",
      },
    },
    capture: { mode: "element", selector: COMPOSER_FORM },
    notes:
      "The draft is restored from storage the way a reopened tab restores it, which is also "
      + "the only state where Send is live without an attachment.",
  }),
  onEmptyChat("composer-autogrown", "A draft at the composer's height ceiling", {
    seed: { local: { "eco-composer-draft": LONG_DRAFT } },
    capture: { mode: "element", selector: COMPOSER_FORM },
    prepare: async (page) => {
      // The textarea grows to its scroll height and stops at 192px. Proving the
      // ceiling — rather than just "it got taller" — is the point of the shot.
      await expect
        .poll(async () =>
          page.locator(COMPOSER).first().evaluate((node) => node.getBoundingClientRect().height),
        )
        .toBeGreaterThan(180);
    },
    notes: "192px is the cap; past it the field scrolls instead of pushing the transcript up.",
  }),
  onEmptyChat("composer-streaming", "The composer mid-turn, with Stop", {
    realism: "mocked",
    mock: async (page) => {
      // Held open, never fulfilled — the same trick W3 uses for the transcript
      // side of this moment. The grounding lookup's fetch stays pending, so the
      // turn parks before any token and the composer stays in its sending state
      // for as long as the shot needs.
      await page.route("**wikipedia.org/**", () => undefined);
      await page.route("**wikidata.org/**", () => undefined);
    },
    // Not the composer bar: that wrapper only exists once a conversation is on
    // screen, so it is absent in the settled phase. The textarea is in both.
    assert: [{ selector: COMPOSER }],
    capture: { mode: "element", selector: "[data-eco-composer-bar]" },
    prepare: async (page) => {
      await page.locator(COMPOSER).first().fill("How tall is the Eiffel Tower?");
      await page.getByRole("button", { name: "Send message", exact: true }).first().click();
      await expect(page.getByRole("button", { name: "Stop generating" }).first()).toBeVisible();
      await expect(page.locator(COMPOSER).first()).toBeDisabled();
    },
    notes:
      "The only honest mid-turn composer: the input disabled, Send replaced by Stop. W3's "
      + "web-lookup entry photographs the transcript half of the same held moment.",
  }),

  // ── Attachments ─────────────────────────────────────────────────────────
  onEmptyChat("attachment-done", "An attachment read and ready", {
    capture: { mode: "element", selector: COMPOSER_FORM },
    prepare: async (page) => {
      await attach(page, [
        textFile(
          "reading-notes.txt",
          "Chapter 3 — the argument about containers is really an argument about volume.\n",
        ),
      ]);
      await expect(page.locator(ON_DEVICE_BADGE)).toBeVisible();
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    },
    notes:
      "A real file driven through the real input. The On-Device badge is the product's own "
      + "claim about where the text was read, so it belongs in this shot rather than a caption.",
  }),
  onEmptyChat("attachment-truncated", "An attachment too long to send whole", {
    capture: { mode: "element", selector: COMPOSER_FORM },
    prepare: async (page) => {
      // Past MAX_EXTRACTED_CHARS (50,000), so the app truncates and says so.
      // Reached by length, not by a flag: the marker is the app's own verdict.
      await attach(page, [
        textFile("server-2026-08.log", "warn container check skipped\n".repeat(2_400)),
      ]);
      await expect(page.getByText("(truncated)")).toBeVisible();
    },
  }),
  onEmptyChat("attachment-unsupported", "A file type Eco will not take", {
    capture: { mode: "element", selector: COMPOSER_FORM },
    prepare: async (page) => {
      await attach(page, [
        { name: "balcony-plan.dmg", mimeType: "application/octet-stream", buffer: Buffer.from("0") },
      ]);
      await expect(page.locator(ATTACHMENT_ALERT)).toContainText("Unsupported file type");
    },
    notes:
      "A rejected file never becomes a chip — validation runs before the attachment is added, "
      + "so this state is the alert alone above an otherwise untouched composer.",
  }),
  onEmptyChat("attachment-unreadable", "An attachment Eco could not read", {
    capture: { mode: "element", selector: COMPOSER_FORM },
    prepare: async (page) => {
      // A PDF that is not a PDF: it passes validation on its extension and then
      // fails in the extractor, which is the only path that reaches FileChip's
      // error state — a text file's read does not throw.
      await attach(page, [
        { name: "quarterly.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") },
      ]);
      await expect(page.locator(ATTACHMENT_ALERT)).toContainText("Eco couldn't read quarterly.pdf");
    },
    notes:
      "Both halves of the failure at once: the chip goes red with its own message, and the "
      + "composer explains what to do about it.",
  }),
  onEmptyChat("attachment-processing", "An attachment still being read", {
    realism: "mocked",
    capture: { mode: "element", selector: COMPOSER_FORM },
    prepare: async (page) => {
      // The one honest way to hold this. Reading a text file resolves in a
      // frame, and a paused clock cannot help because nothing here waits on a
      // timer. A PDF is different: its extractor is a lazily imported chunk, and
      // by the time `prepare` runs it is the ONLY script the page can still ask
      // for — so refusing to answer that request parks the attachment in
      // `extracting`, which is exactly the state a slow connection produces.
      await page.route("**/_next/static/chunks/**.js", () => undefined);
      await attach(page, [
        { name: "quarterly.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n") },
      ]);
      await expect(page.getByText("Preparing attachment…")).toBeVisible();
    },
    notes:
      "Held at the network, so 'mocked'. Both halves of the wait are in frame: the chip's "
      + "spinner, and the composer explaining that Send unlocks when the text is ready.",
  }),
  onEmptyChat("attachment-too-many", "More attachments than a message can carry", {
    capture: { mode: "element", selector: COMPOSER_FORM },
    prepare: async (page) => {
      await attach(
        page,
        ["one", "two", "three", "four", "five", "six"].map((name, index) =>
          textFile(`note-${name}.md`, `# Note ${String(index + 1)}\n\nContainer volume matters.\n`),
        ),
      );
      await expect(page.locator(ATTACHMENT_ALERT)).toContainText("Eco can attach up to 5 files per message");
      await expect(page.locator(ON_DEVICE_BADGE)).toHaveCount(5);
    },
    notes: "Five chips accepted, the sixth refused by name — the limit is stated, not silent.",
  }),
  onEmptyChat("drag-over", "A file dragged over the chat", {
    prepare: async (page) => {
      await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["volume matters"], "notes.txt", { type: "text/plain" }));
        const target = document.querySelector('[data-testid="empty-chat-state"]') ?? document.body;
        target.dispatchEvent(
          new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      });
      await expect(page.getByText("Drop files here")).toBeVisible();
    },
    notes:
      "A real DragEvent carrying a real file, dispatched at the surface: Playwright cannot "
      + "drag from outside the browser, and the overlay is driven by the dragenter/dragleave "
      + "counter rather than by any state the lane could seed.",
  }),

  // ── Sharing a conversation ──────────────────────────────────────────────
  onSeededChat(
    "share-dialog",
    "Share conversation — the three exports",
    [{ selector: ASSISTANT_ROW }],
    {
      prepare: openShareDialog,
      notes:
        "Opened from the header control. Every export is built in the page — the closing line "
        + "of the panel is the product saying so, and it is true.",
    },
  ),
  onSeededChat(
    "share-copied",
    "Share conversation — copied as Markdown",
    [{ selector: ASSISTANT_ROW }],
    {
      // The confirmation resets itself after two seconds; a paused clock holds
      // it. Same reason as message-copied.
      clock: { mode: "paused", advanceMs: 2_000 },
      prepare: async (page) => {
        await page.context().grantPermissions(["clipboard-write"]);
        await openShareDialog(page);
        await page.getByRole("button", { name: "Copy as Markdown" }).click();
        await expect(page.getByText("Copied locally as markdown.")).toBeVisible();
      },
    },
  ),
  onSeededChat(
    "share-copy-error",
    "Share conversation — the conversation is gone",
    [{ selector: ASSISTANT_ROW }],
    {
      clock: { mode: "paused", advanceMs: 2_000 },
      prepare: async (page) => {
        await openShareDialog(page);
        await deleteActiveConversationRecord(page);
        await page.getByRole("button", { name: "Copy as Markdown" }).click();
        await expect(
          page.getByText("Eco can't find this conversation on this device."),
        ).toBeVisible();
      },
      notes:
        "Reached without faking the clipboard: the copy path reads the conversation back out of "
        + "IndexedDB first, and a chat deleted while the dialog is open makes that read throw. "
        + "The read now throws a typed ConversationNotFoundError, so the dialog names the real "
        + "cause and the button reads 'Nothing to copy' rather than offering a retry that would "
        + "fail the same way. A genuine clipboard denial still gets 'Copy failed on this browser'.",
    },
  ),
  onSeededChat(
    "share-download-error",
    "Share conversation — the export found nothing to export",
    [{ selector: ASSISTANT_ROW }],
    {
      prepare: async (page) => {
        await openShareDialog(page);
        await deleteActiveConversationRecord(page);
        await page.getByRole("button", { name: "Export as JSON" }).click();
        await expect(page.locator(SHARE_ERROR)).toContainText(
          "Eco can't find this conversation on this device",
        );
      },
      notes:
        "The same race as share-copy-error, down the export path. Both now say the same true "
        + "thing; the export alert previously said 'Try again or copy Markdown instead', which "
        + "pointed at a path that fails identically. Worth seeing the two side by side.",
    },
  ),

  // ── Ambient chrome on a conversation ────────────────────────────────────
  onSeededChat(
    "impact-footer",
    "The impact strip above the composer",
    [{ selector: '[data-tour-target="impact-footer"]' }],
    {
      capture: { mode: "element", selector: '[data-tour-target="impact-footer"]' },
      notes:
        "Its own crop because it is a region every conversation carries and no full-page shot "
        + "shows at a readable size. It appears on the first finished reply — the count is "
        + "derived from the transcript, so the seeded conversation earns it honestly.",
    },
  ),
  {
    id: "chat-interactions.guide-button-hover",
    group: "chat-interactions",
    title: "The guide button, under the pointer",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    tier: "micro",
    realism: "seeded",
    capture: { mode: "element", selector: '[aria-label="Open Eco guide"]' },
    assert: [{ selector: '[aria-label="Open Eco guide"]' }],
    prepare: async (page) => {
      await page.locator('[aria-label="Open Eco guide"]').first().hover();
    },
    notes:
      "The one floating control that sits over every chat shot; this is the only state where "
      + "it is anything other than quiet. A 44px button crops to about 2 KB, so the coverage "
      + "check's under-8-KB warning is expected here and is not a broken shot.",
  },

  // ── First run: the welcome, then the tour ───────────────────────────────
  {
    id: "chat-interactions.welcome-overlay",
    group: "chat-interactions",
    title: "First-run welcome overlay",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    // The gate is exactly one key. `eco-onboarding` STAYS — the tour refuses to
    // run until the setup wizard is complete, so removing it (which is what
    // pilot.welcome-first-run does, for the wizard's own intro) would replace
    // this surface with a different one rather than reveal it.
    seed: { removeLocal: ["eco-tour-completed"] },
    tier: "page",
    realism: "seeded",
    assert: [{ role: "button", name: "Show me around" }],
    notes:
      "What somebody sees the first time the chat opens after setup: the choice between being "
      + "shown around and getting on with it.",
  },
  onEmptyChat("tour-step-model-selector", "Guided tour — choosing how Eco answers", {
    search: `${READY_CHAT_SEARCH}&tour=1`,
    // `eco-tour-completed` is deliberately left in place: `?tour=1` starts the
    // tour on its own, and un-suppressing the welcome overlay would park it on
    // top of the popover this entry exists to photograph.
    assert: [{ selector: ".driver-popover" }],
    prepare: waitForTourStage,
    notes:
      "The tour launches itself from the query param and then cleans the param out of the URL "
      + "with replaceState, so the popover — not the address — is the proof it ran. On an empty "
      + "chat this is the ONLY step: the other one targets the impact footer, which the empty "
      + "layout does not render.",
  }),
  onSeededChat(
    "tour-step-impact",
    "Guided tour — the impact step",
    // Not the popover: the tour is started BY this entry's prepare, so at settle
    // there is nothing to assert on but the conversation underneath.
    [{ selector: ASSISTANT_ROW }],
    {
      prepare: async (page) => {
        // Started from the guide button rather than `?tour=1`, and that is not a
        // stylistic choice. `OnboardingTour` builds its step list by querying
        // the DOM at the moment the tour launches, so a `?tour=1` launch can run
        // before the conversation's own pane (and the impact footer inside it)
        // has mounted — the step is then dropped and the tour is one step long.
        // It raced exactly that way: green on desktop, a one-step tour on
        // mobile. Launching after the transcript is on screen makes the step
        // list deterministic, and the guide button is how a reader reaches the
        // tour again anyway.
        await page.locator('[aria-label="Open Eco guide"]').first().click();
        await expect(page.getByText("Choose how Eco answers")).toBeVisible();
        await waitForTourStage(page);
        await page.locator(".driver-popover-next-btn").first().click();
        await expect(page.getByText("Track impact quietly")).toBeVisible();
        await expect(page.locator('[data-tour-target="impact-footer"]')).toHaveClass(
          /driver-active-element/,
        );
        await waitForTourStage(page);
      },
      notes:
        "The SECOND popover and the last one: the tour is two steps. A third step authored "
        + "against an [aria-label=\"Privacy information\"] element that no component renders was "
        + "filtered out at launch and has since been deleted. See the header.",
    },
  ),
];
