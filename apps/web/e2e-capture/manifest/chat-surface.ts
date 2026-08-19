// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, type Page } from "@playwright/test";
import type { IdbSeedName } from "../seeds/idb";
import type { CaptureGap, StateAssertion, StateEntry } from "../types";
import { READY_CHAT_SEARCH, UPGRADE_DECLINED_LOCAL } from "./pilot";

/**
 * W3 — the chat surface.
 *
 * Everything a finished conversation can contain: the message bubbles and the
 * blocks inside them (markdown, code, reasoning, sources, files, artifacts),
 * the markers a turn can end with (truncated, interrupted, continued locally),
 * and the whole classified error family. Pilot owns the empty chat and the
 * hover/menu details; W3 is what fills the pane once somebody has actually
 * talked to Eco.
 *
 * ── Why nearly every entry here is `server: 'prod'` ───────────────────────
 *
 * A conversation that is ALREADY the active one when `/chat` mounts does not
 * render its messages on the dev server. Traced on 2026-08-18 with an
 * IndexedDB read log: the database is read, the branch comes back with both
 * rows, and the result is then thrown away.
 *
 * The cause is in `useConversationManager`'s load effect. It stamps a request
 * id — `const requestId = ++workspaceLoadRequestRef.current` — BEFORE the
 * early-return that skips a no-op invocation, and the promise handler discards
 * its result if the counter has moved on. React StrictMode (on by default in
 * `next dev`) invokes every effect twice per mount: the first invocation starts
 * the load, the second early-returns but still bumps the counter, so the load
 * that was already in flight is invalidated and the pane stays empty.
 *
 * Confirmed both ways: with `reactStrictMode: false` the dev server renders the
 * seeded conversation, and the production build renders it as shipped
 * (StrictMode's double invocation is dev-only). So these states genuinely do
 * not exist on a dev server, which is exactly what `server: 'prod'` is for —
 * they are skipped on a dev run rather than reported missing.
 *
 * This is a real (if dev-only) defect, not a lane quirk. Moving the `requestId`
 * stamp below the early return would fix it and let every entry here drop the
 * flag; that is an app change, so it is reported rather than made here.
 *
 * The three live-interaction states at the bottom drive the app themselves and
 * need no seeded conversation, so they run on either server.
 *
 * ── Four surfaces this wave deliberately does NOT capture ─────────────────
 *
 * 1. The three harness protection banners (`eco-force-protection=battery-
 *    disabled|thermal|memory-pressure`) and the validation selected-model
 *    banner. Their copy lives in `src/lib/validation-harness.ts` and renders
 *    only while the validation harness is on, so no user ever sees them. In an
 *    inventory meant for design review they would read as shipping copy and
 *    invite critique of text that does not ship. The battery-reduced notice IS
 *    captured: that one is real product behaviour (`computeRestriction` on a
 *    real battery level), and the harness only forces the level.
 *
 * 2. `ToolCallBlock`'s running and error states. Tool calls live in a transient
 *    store side-channel (`activeToolCalls`), never in IndexedDB, so they cannot
 *    be seeded — only driven. The complete state is driven below; "running" is
 *    over in a few milliseconds on a host-computed tool, and "error" needs a
 *    tool that throws, which nothing reachable does.
 *
 * 3. Mid-stream text with the streaming cursor. The generation fixture enqueues
 *    all five of its chunks synchronously and the stream's `flushSync()` then
 *    releases the token batcher's whole backlog at once, so there is no
 *    mid-stream moment to hold — and a paused clock cannot create one, because
 *    nothing in that path waits on a timer. What IS holdable is the phase
 *    BEFORE any token: a web lookup blocked at the network, captured below.
 *
 * 4. The "{slot} is ready" error variant. It needs `localReadiness` on the
 *    message plus a prepare run that has reached `ready` — the first is a
 *    runtime-only field (never persisted, so never seedable) and the second is
 *    a real model download. The rest of that card's family is covered.
 *
 * ── Two things in these shots that are the app, not the lane ──────────────
 *
 * Both were found by reading the captures. They are real behaviour, so they are
 * photographed as-is rather than papered over.
 *
 * - Every turn whose assistant message is EMPTY — the error cards, the
 *   interrupted-with-nothing bubble, a turn still looking something up — draws
 *   "Messages above are no longer in context" above the user's question, in a
 *   two-message conversation where nothing can possibly have been evicted.
 *   `selectMessagesForContext` filters empty assistant turns out of the
 *   selection (CS-3), and `findContextDividerIndex` reads any shortfall between
 *   selection and branch as an eviction. The `chat-surface.context-divider`
 *   entry deliberately uses the long transcript instead, so that shot is the
 *   real thing.
 *
 * - Inside the fenced Python block, `->` renders as `→`. Smart-typography
 *   substitution is reaching code, where it must not: the shot shows a function
 *   signature that would not parse if copied.
 */

/** The composer, which is on screen before and after every interaction here. */
const COMPOSER = '[aria-label="Message input"]';

/**
 * A state that is one seeded conversation, viewed.
 *
 * Every one of these shares the same setup — a harness-ready slot, a forced
 * device, the upgrade offer settled — so the entries below say only what makes
 * them different.
 */
function seededChat(
  name: string,
  title: string,
  idb: IdbSeedName,
  assert: StateAssertion[],
  overrides: Partial<StateEntry> = {},
): StateEntry {
  return {
    id: `chat-surface.${name}`,
    group: "chat-surface",
    title,
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL, idb: [idb] },
    tier: "component",
    realism: "seeded",
    // See the header: a conversation already active at mount stays empty on the
    // dev server.
    server: "prod",
    assert,
    ...overrides,
  };
}

/**
 * One classified error card.
 *
 * The seeded `errorMessage` is the exact string `ErrorMessage.tsx` matches on;
 * `headline` is the title it must produce. Asserting the headline rather than
 * the seeded string is the point of these entries — it proves the message
 * reached the classifier and came out as the right card, not as the generic
 * fallback.
 */
function errorCard(name: string, title: string, idb: IdbSeedName, headline: string): StateEntry {
  return seededChat(name, title, idb, [{ text: headline }]);
}

/** Type a prompt into the composer and send it. */
async function send(page: Page, prompt: string): Promise<void> {
  await page.locator(COMPOSER).first().fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).first().click();
}

/** The four surfaces this file's header explains at length, in a printable form. */
export const chatSurfaceGaps: CaptureGap[] = [
  {
    id: "chat-surface.harness-banners",
    group: "chat-surface",
    surface: "The three harness protection banners and the validation selected-model banner",
    reason:
      "Their copy lives in src/lib/validation-harness.ts and renders only while the validation harness is on, so no user "
      + "ever sees it. In an inventory meant for design review it would read as shipping copy and invite critique of text "
      + "that does not ship. EXCLUDED ON PURPOSE, not unreachable. The battery-reduced notice IS captured — that one is real "
      + "product behaviour and the harness only forces the level.",
  },
  {
    id: "chat-surface.tool-call-running-and-error",
    group: "chat-surface",
    surface: "ToolCallBlock's running and error states",
    reason:
      "Tool calls live in a transient store side-channel (activeToolCalls), never in IndexedDB, so they cannot be seeded — "
      + "only driven. 'Running' is over in a few milliseconds on a host-computed tool, and 'error' needs a tool that throws, "
      + "which nothing reachable does. The complete state IS captured.",
  },
  {
    id: "chat-surface.mid-stream-cursor",
    group: "chat-surface",
    surface: "Mid-stream text with the streaming cursor",
    reason:
      "The generation fixture enqueues all five chunks synchronously and the stream's flushSync() then releases the token "
      + "batcher's whole backlog at once, so there is no mid-stream moment to hold — and a paused clock cannot create one, "
      + "because nothing in that path waits on a timer. The holdable phase BEFORE any token (a web lookup blocked at the "
      + "network) is captured instead.",
  },
  {
    id: "chat-surface.error-slot-is-ready",
    group: "chat-surface",
    surface: "The “{slot} is ready” error-card variant",
    reason:
      "Needs localReadiness on the message plus a prepare run that reached 'ready'. The first is a runtime-only field "
      + "(never persisted, so never seedable) and the second is a real model download. The rest of that card's family is covered.",
  },
];

export const chatSurfaceStates: StateEntry[] = [
  // ── The shape of a conversation ─────────────────────────────────────────
  seededChat(
    "conversation",
    "A finished exchange",
    "conversation-basic",
    [{ selector: '[data-message-id="capture-basic-assistant"]' }],
    { tier: "page" },
  ),
  seededChat(
    "markdown",
    "Markdown: headings, lists, a table, a quote, links",
    "conversation-markdown",
    // Text from the table, not the reply's opening heading: the sidebar preview
    // quotes the first 80 characters of the reply, and on mobile that preview
    // sits in a hidden drawer — so a heading assertion resolves to the hidden
    // copy and fails. Anything past the preview window is unambiguous.
    [{ text: "Sign you left it too long" }],
    { tier: "page" },
  ),
  seededChat(
    "code-block",
    "A code block with its language and copy control",
    "conversation-code",
    [{ role: "button", name: "Copy code" }],
  ),
  seededChat(
    "code-block-copied",
    "A code block just after Copy",
    "conversation-code",
    // NOT the copy button. Copying renames it from "Copy code" to "Copied", so
    // an assertion on that name is only true in the settled phase — and because
    // assertions run again after `prepare`, it would sit and retry for ten
    // seconds until the confirmation timed out, guaranteeing a screenshot of the
    // state this entry exists to avoid. It cost two runs to see. Assert on the
    // block itself, which is true in both phases.
    [{ selector: '[data-message-id="capture-code-assistant"] pre' }],
    {
      tier: "micro",
      // Belt to that braces: the confirmation also reverts on a two-second
      // timer. A paused clock stops it. `advanceMs` runs after settle, which
      // lets the message-entrance animations finish before time stops again.
      clock: { mode: "paused", advanceMs: 2_000 },
      prepare: async (page) => {
        // Headless Chromium denies clipboard writes by default. THIS block's
        // label happens to flip anyway (it sets the flag before the write
        // settles), but granting the permission is what a real click gets, and
        // it keeps an unhandled NotAllowedError out of the page.
        await page.context().grantPermissions(["clipboard-write"]);
        await page.getByRole("button", { name: "Copy code" }).first().click();
        await expect(page.getByText("Copied!").first()).toBeVisible();
      },
      notes:
        "Copy is optimistic here — the label flips whether or not the write resolves — but the "
        + "permission is granted anyway, because a component that awaited the write would need it.",
    },
  ),
  seededChat(
    "long-transcript",
    "A long conversation, whole page",
    "conversation-long",
    // The conversation title lives in the sidebar, which is a hidden drawer on
    // the small viewports; assert on the transcript itself instead.
    [{ text: "Salad leaves are the genuine exception" }],
    {
      tier: "page",
      notes:
        "Viewport, not fullPage: the transcript scrolls inside its own pane rather than the "
        + "document, so fullPage returns the same pixels. The pane sits where the app leaves "
        + "it — pinned to the newest reply, which is what a reader actually opens onto.",
    },
  ),
  seededChat(
    "context-divider",
    "The context-window boundary",
    "conversation-long",
    [{ selector: '[aria-label="Context window boundary"]' }],
    {
      capture: { mode: "element", selector: '[aria-label="Context window boundary"]' },
      notes:
        "Reached honestly by length: the seeded transcript outgrows the 4,096-token starter "
        + "model's history budget, so the app draws the divider itself.",
    },
  ),

  // ── Blocks inside a reply ───────────────────────────────────────────────
  seededChat(
    "thinking-collapsed",
    "A reasoning block, collapsed",
    "conversation-thinking",
    [{ testId: "thinking-toggle" }],
  ),
  seededChat(
    "thinking-expanded",
    "A reasoning block, expanded",
    "conversation-thinking",
    [{ testId: "thinking-toggle" }],
    {
      tier: "micro",
      prepare: async (page) => {
        await page.locator('[data-testid="thinking-toggle"]').first().click();
        const content = page.locator('[data-testid="thinking-content"]').first();
        await expect(content).toHaveAttribute("data-collapsed", "false");
        // The flag flips before the height does — Motion animates 0 → auto, so
        // screenshotting on the flag alone caught an open chevron over an empty
        // box, and a simple "taller than N" threshold caught the reasoning cut
        // off mid-sentence. Wait for the height to stop changing instead.
        let previousHeight = -1;
        await expect
          .poll(async () => {
            const height = await content.evaluate((node) => node.getBoundingClientRect().height);
            const settled = height > 40 && height === previousHeight;
            previousHeight = height;
            return settled;
          })
          .toBe(true);
      },
    },
  ),
  seededChat(
    "citation-chip",
    "A sourced answer's citation chip",
    "conversation-citation",
    [{ testId: "grounding-citation" }],
    {
      notes:
        "Seeded at a fuzzy confidence tier on purpose, so this shot is the chip alone — "
        + "only a high-confidence grounding anchors the disclosure below.",
    },
  ),
  seededChat(
    "grounding-notice",
    "The once-per-chat grounding disclosure",
    "conversation-grounding-notice",
    [{ testId: "grounding-notice" }],
  ),
  seededChat(
    "uncertainty-unverified",
    "An answer Eco could not confirm",
    "conversation-uncertainty-unverified",
    [{ text: "couldn’t confirm this against a source" }],
  ),
  seededChat(
    "uncertainty-unreachable",
    "An answer whose sources could not be reached",
    "conversation-uncertainty-unreachable",
    [{ text: "couldn’t reach its sources" }],
  ),
  seededChat(
    "file-attachment",
    "A user message carrying two files",
    "conversation-files",
    [{ text: "quarterly-spend.csv" }],
  ),
  seededChat(
    "artifact-block",
    "A runnable HTML artifact",
    "conversation-artifact",
    [{ selector: '[aria-label="Preview tab"]' }],
    {
      notes:
        "The Code tab is the default, so nothing is executed and the Sandpack preview "
        + "never runs — the artifact renders as source, which is what ships.",
    },
  ),
  seededChat(
    "canonical-tool-answer",
    "An exact answer restored from history",
    "conversation-canonical-answer",
    [{ testId: "canonical-tool-answer" }],
    {
      notes:
        "The persisted half of the canonical-answer path: reloaded from IndexedDB with no "
        + "live tool call, which is what an earlier exact answer looks like on scroll-back.",
    },
  ),

  // ── How a turn can end ──────────────────────────────────────────────────
  seededChat(
    "branch-navigation",
    "Three regenerated replies, showing the branch control",
    "conversation-branches",
    [{ role: "button", name: "Previous version" }],
  ),
  seededChat(
    "possibly-truncated",
    "A reply that may have hit its length limit",
    "conversation-truncated",
    [{ text: "This local reply may have reached its length limit." }],
  ),
  seededChat(
    "interrupted-user-stop",
    "A reply the reader stopped",
    "conversation-interrupted-user-stop",
    [{ text: "You stopped this reply." }],
  ),
  seededChat(
    "interrupted-fault",
    "A reply that did not finish",
    "conversation-interrupted-fault",
    [{ text: "This reply didn’t finish." }],
  ),
  seededChat(
    "interrupted-empty",
    "An interrupted reply with nothing in it",
    "conversation-interrupted-empty",
    [{ text: "This reply didn’t finish." }],
    {
      notes:
        "The bubble a crash or reload leaves behind: the same marker, with no partial "
        + "answer above it. Worth its own shot because the empty bubble is the odd part.",
    },
  ),
  seededChat(
    "offline-divider",
    "A reply that finished on-device after a drop",
    "conversation-offline-divider",
    [{ text: "Hybrid/offline continuation" }],
  ),

  // ── The error family ────────────────────────────────────────────────────
  errorCard(
    "error-generic-one",
    "Generic failure — first variant",
    "error-generic-one",
    "Something went sideways",
  ),
  errorCard(
    "error-generic-two",
    "Generic failure — second variant",
    "error-generic-two",
    "The forest is resting",
  ),
  errorCard(
    "error-generic-three",
    "Generic failure — third variant",
    "error-generic-three",
    "A branch broke",
  ),
  errorCard(
    "error-capacity",
    "An interrupted response",
    "error-capacity",
    "Something interrupted that response",
  ),
  errorCard(
    "error-browser-unsupported",
    "A device that cannot run on-device AI",
    "error-browser-unsupported",
    "Eco can't run on this device yet",
  ),
  errorCard(
    "error-local-setup",
    "A local model that still needs setting up",
    "error-local-setup",
    "Eco needs one quick setup",
  ),
  errorCard(
    "error-template-missing",
    "A model whose chat template is broken",
    "error-template-missing",
    "Eco needs one quick setup",
  ),
  errorCard(
    "error-generation-failure",
    "An on-device generation that failed",
    "error-generation-failure",
    "That reply hit a snag",
  ),
  errorCard(
    "error-generation-repeated",
    "The same on-device failure, a second time",
    "error-generation-repeated",
    "That reply hit a snag",
  ),
  errorCard(
    "error-cooldown",
    "A device cooling down after a fault",
    "error-cooldown",
    "Let this device cool down",
  ),
  errorCard(
    "error-model-preparing",
    "A message sent while a model is still warming up",
    "error-model-preparing",
    "Your model is still getting ready",
  ),
  errorCard(
    "error-context-window",
    "A conversation too long for the model",
    "error-context-window",
    "This conversation is too long",
  ),
  errorCard(
    "error-device-protection",
    "On-device work paused for a low battery",
    "error-device-protection",
    "Paused to protect your device",
  ),

  // ── Ambient state on a conversation ─────────────────────────────────────
  seededChat(
    "battery-reduced-notice",
    "Low-battery notice above the composer",
    "conversation-basic",
    [{ text: "Low battery mode" }],
    {
      search: `${READY_CHAT_SEARCH}&eco-force-protection=battery-reduced`,
      notes:
        "Real product behaviour — the harness only forces the battery level the app reads. "
        + "The three harness-authored protection banners are deliberately not captured.",
    },
  ),

  // ── States the app produces on its own ──────────────────────────────────
  {
    id: "chat-surface.local-inference-crash",
    group: "chat-surface",
    title: "The on-device inference error boundary",
    route: "/chat",
    search: `${READY_CHAT_SEARCH}&eco-force-local-runtime=crash`,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "page",
    realism: "seeded",
    internal: true,
    assert: [{ text: "On-device AI ran into a problem" }],
    notes:
      "The boundary catches a worker crash or a lost WebGPU device. Forced through the "
      + "harness because there is no way to crash a runtime that never started.",
  },
  {
    id: "chat-surface.tool-call-complete",
    group: "chat-surface",
    title: "A finished calculator tool call",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "component",
    realism: "seeded",
    assert: [{ selector: COMPOSER }],
    prepare: async (page) => {
      await send(page, "What is 17 * 23?");
      await expect(page.locator('[data-testid="canonical-tool-answer"]').first()).toBeVisible();
      await expect(page.getByText("Calculator").first()).toBeVisible();
    },
    notes:
      "Driven, not seeded: tool calls live in a transient side-channel. No model runs — an "
      + "exact-answer tool computes the result on the host and generation is skipped entirely, "
      + "which is why this is deterministic without any weights.",
  },
  {
    id: "chat-surface.tool-call-expanded",
    group: "chat-surface",
    title: "A calculator tool call, opened",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "micro",
    realism: "seeded",
    assert: [{ selector: COMPOSER }],
    prepare: async (page) => {
      await send(page, "What is 17 * 23?");
      const block = page.getByRole("button", { name: /Calculator/ }).first();
      await expect(block).toBeVisible();
      await block.click();
      await expect(block).toHaveAttribute("aria-expanded", "true");
    },
    notes: "A settled tool call collapses itself; this is the input/result detail behind it.",
  },
  {
    id: "chat-surface.web-lookup-in-progress",
    group: "chat-surface",
    title: "A web lookup in progress, with Stop available",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "component",
    realism: "mocked",
    mock: async (page) => {
      // Held open, never fulfilled: the grounding tool's fetch stays pending, so
      // the turn parks in its "looking up" phase for as long as the shot needs.
      // This is the only streaming moment the lane can hold still (see header).
      await page.route("**wikipedia.org/**", () => undefined);
      await page.route("**wikidata.org/**", () => undefined);
    },
    assert: [{ selector: COMPOSER }],
    prepare: async (page) => {
      await send(page, "How tall is the Eiffel Tower?");
      await expect(page.getByText("Looking this up on the web").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop generating" }).first()).toBeVisible();
    },
    notes:
      "The composer's Stop control comes with it, so this shot is also the only honest look "
      + "at the composer mid-turn.",
  },
];
