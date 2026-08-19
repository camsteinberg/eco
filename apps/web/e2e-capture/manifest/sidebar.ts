// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, type Locator, type Page } from "@playwright/test";
import type { IdbSeedName } from "../seeds/idb";
import type { StateEntry } from "../types";
import { READY_CHAT_SEARCH, UPGRADE_DECLINED_LOCAL } from "./pilot";

/**
 * W4a — the sidebar.
 *
 * Everything the left column can be: a populated history with all five of its
 * date groups, the collapsed icon rail, the mobile drawer, and every state a
 * single conversation row can be put into — hovered, menu open, renaming,
 * confirming a delete, selected in bulk. Plus the two footers (guest and
 * signed-in) and the overlay a sign-out puts over the whole app.
 *
 * ── Where the sidebar actually exists ─────────────────────────────────────
 *
 * `AppShell` renders it twice and shows neither in the middle: the standing
 * column is `hidden lg:block` (≥1024px) and the drawer is a `BottomSheet`,
 * which is `md:hidden` (<768px). The lane's tablet projects sit at 768px —
 * inside the gap — so between 768 and 1023px the header's hamburger is visible,
 * `lg:hidden`, and toggles a sheet that is `display: none`. Measured at 768px on
 * 2026-08-19, against the same running app these captures use: the hamburger
 * reports visible, the click lands, the sheet's host computes to `display: none`,
 * and the standing column is not visible either. There is no way to reach
 * navigation or history at that width. At 375px the same click shows the sheet.
 *
 * That is a product bug, not a lane limitation, so nothing here is shot at the
 * tablet viewport — the entries carry explicit `axes.viewports` rather than
 * pretending the tier system chose it.
 *
 * ── Two states with no honest trigger ─────────────────────────────────────
 *
 * - **A row mid-delete.** `ConversationList` sets `deletingId`, the row takes
 *   `.slide-out-left`, and a 200ms timer removes it. The animation's only
 *   keyframe is `to { transform: translateX(-100%); opacity: 0 }`, and the
 *   screenshot's `animations: 'disabled'` fast-forwards CSS animations to their
 *   END frame — so the shot is of a row that has already left, whether or not a
 *   paused clock holds the timer. There is nothing to photograph.
 * - **`SidebarErrorBoundary`'s fallback.** It catches a render throw from
 *   `Sidebar`/`ConversationList`, and nothing reachable throws there. Faking one
 *   means patching a component from an init script, which is a screenshot of
 *   sabotage rather than of the product.
 *
 * ── One dead affordance, found by reading the code for these states ───────
 *
 * `BulkActionsBar` renders only when `selectedIds.size > 0`, and its first
 * button reads "Select All" only when `selectedCount === 0`. Those conditions
 * cannot both hold, so the Select All label ships but can never appear. The
 * `sidebar.bulk-selected` shot below is the only state that bar has.
 */

/** The standing sidebar column. `Sidebar` is the app's only `<aside>`. */
const SIDEBAR = "aside";

/** The grouped conversation rows, without the search box above them. */
const LIST = 'nav[aria-label="Conversation list"]';

/** The search box, which is on screen in every populated-sidebar state. */
const SEARCH = '[data-testid="conversation-search"]';

/**
 * A history with one conversation in every group the list can draw.
 *
 * Order is load-bearing in one way only: the runner points
 * `eco-active-conversation` at the LAST lane seed named, so "Sharpening kitchen
 * knives" is the active row in every state below. See `seeds/idb.ts`.
 */
const HISTORY: IdbSeedName[] = [
  "history-pinned",
  "history-older",
  "history-week",
  "history-yesterday",
  "history-today",
];

/** The active row — the newest unpinned conversation. */
const ACTIVE_TITLE = "Sharpening kitchen knives";
/** A pinned row, which is the only place the menu offers Unpin. */
const PINNED_TITLE = "Repotting a fiddle-leaf fig";
/** A second unpinned row, for the states that need two rows selected. */
const OTHER_TITLE = "Bread without a stand mixer";

/**
 * A populated sidebar on a desktop-width chat.
 *
 * Shared by nearly every entry here: a harness-ready slot so no download runs,
 * a settled upgrade cycle so the offer card never lands over the shot, and the
 * five history seeds. `server: 'prod'` because a conversation that is already
 * active when `/chat` mounts renders nothing on the dev server — the
 * `useConversationManager` StrictMode defect documented in `chat-surface.ts`.
 */
function sidebarState(
  name: string,
  title: string,
  overrides: Partial<StateEntry> = {},
): StateEntry {
  return {
    id: `sidebar.${name}`,
    group: "sidebar",
    title,
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL, idb: HISTORY },
    tier: "component",
    realism: "seeded",
    server: "prod",
    capture: { mode: "element", selector: SIDEBAR },
    assert: [{ selector: SEARCH }],
    ...overrides,
  };
}

/** A standing state: no interaction, and only where the column exists. */
function populatedSidebar(
  name: string,
  title: string,
  overrides: Partial<StateEntry> = {},
): StateEntry {
  return sidebarState(name, title, { axes: { viewports: ["desktop"] }, ...overrides });
}

/** The same thing, driven by an interaction — desktop-only by tier. */
function sidebarDetail(
  name: string,
  title: string,
  prepare: (page: Page) => Promise<void>,
  overrides: Partial<StateEntry> = {},
): StateEntry {
  return sidebarState(name, title, { tier: "micro", prepare, ...overrides });
}

/** One conversation row, by the title it shows. */
function row(page: Page, title: string): Locator {
  return page.locator(`${LIST} div[role="button"]`).filter({ hasText: title }).first();
}

/**
 * Open one row's overflow menu.
 *
 * Scoped to the row, and deliberately NOT the shared `openMenu` helper: two
 * different menus answer to `role=menu` on this screen — the message actions
 * menu inside the transcript and this one — so a global lookup can resolve to
 * the wrong one, or to the right one for the wrong reason.
 */
async function openRowMenu(page: Page, title: string): Promise<Locator> {
  const item = row(page, title);
  await item.hover();
  await item.getByRole("button", { name: "Conversation menu" }).click();
  const menu = item.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Type into the sidebar's search box. */
async function search(page: Page, query: string): Promise<void> {
  await page.locator(SEARCH).first().fill(query);
}

/** Enter multi-select mode and prove the checkboxes arrived. */
async function enterMultiSelect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Select conversations" }).click();
  await expect(page.getByRole("button", { name: "Cancel selection" })).toBeVisible();
  await expect(row(page, ACTIVE_TITLE).getByRole("checkbox")).toBeVisible();
}

export const sidebarStates: StateEntry[] = [
  // ── The list ────────────────────────────────────────────────────────────
  populatedSidebar("history-groups", "History — all five date groups", {
    assert: [
      { selector: SEARCH },
      { text: "Pinned" },
      { text: "Yesterday" },
      { text: "Previous 7 Days" },
      { text: "Older" },
    ],
    notes:
      "Five seeded conversations spread across the frozen clock — 12 minutes, 40 minutes and "
      + "pinned, one day, three days, twelve days — so every header the list can draw is drawn "
      + "from real data. The 'Today' assertion is left out on purpose: the word also appears in "
      + "seeded prose, and the four less common headers already prove the grouping.",
  }),
  populatedSidebar("empty-list", "History — nothing here yet", {
    // No conversations, so nothing needs the production build.
    seed: { local: UPGRADE_DECLINED_LOCAL },
    server: "any",
    assert: [{ text: "Your conversations will gather here." }],
    notes:
      "The nested empty state: a sprout and one line, sized for the disclosure it sits in rather "
      + "than the standalone fern the list shows at full width.",
  }),
  populatedSidebar("collapsed-rail", "Collapsed to the icon rail", {
    seed: {
      local: { ...UPGRADE_DECLINED_LOCAL, "eco-sidebar-collapsed": "true" },
      idb: HISTORY,
    },
    assert: [{ role: "button", name: "Expand sidebar" }],
    notes:
      "60px of icons: the logo, the labels, the recent-chats disclosure and the whole history go "
      + "away together, and the footer collapses to a single control. The collapse is a device "
      + "preference (`eco-sidebar-collapsed`), which is why it survives a sign-out.",
  }),
  sidebarDetail(
    "recent-chats-closed",
    "Recent chats folded away",
    async (page) => {
      await page.getByRole("button", { name: "Hide recent chats" }).click();
      await expect(page.getByRole("button", { name: "Show recent chats" })).toBeVisible();
      await expect(page.locator(LIST)).toBeHidden();
    },
    {
      // The list is gone in this state, so the contract is the disclosure row.
      assert: [{ role: "link", name: "Chat" }],
      notes:
        "History lives inside a disclosure under Chat, open by default. Closed, the sidebar is "
        + "navigation only — and the search box goes with it, which is the part worth seeing.",
    },
  ),

  // ── One row ─────────────────────────────────────────────────────────────
  populatedSidebar("row-active", "The row you are reading", {
    capture: { mode: "element", selector: LIST },
    notes:
      "The rows alone, so the active treatment is legible: a left border in the primary colour "
      + "and a soft fill, on the conversation the pane is showing. Every other row carries a "
      + "transparent border of the same width, so nothing shifts when the selection moves.",
  }),
  sidebarDetail(
    "row-hover",
    "A row under the pointer",
    async (page) => {
      const item = row(page, OTHER_TITLE);
      await item.hover();
      // The menu button is `md:opacity-0 md:group-hover:opacity-100`, so the
      // proof the hover landed is its computed opacity, not its existence.
      const trigger = item.getByRole("button", { name: "Conversation menu" });
      await expect(trigger).toBeVisible();
      await expect
        .poll(async () => trigger.evaluate((node) => Number(getComputedStyle(node).opacity)))
        .toBeGreaterThan(0.9);
    },
    {
      capture: { mode: "element", selector: LIST },
      notes: "Hovering does two things at once — the row fills, and its overflow trigger fades in.",
    },
  ),
  sidebarDetail(
    "row-menu",
    "A row's menu open",
    async (page) => {
      const menu = await openRowMenu(page, ACTIVE_TITLE);
      await expect(menu.getByRole("menuitem", { name: "Pin" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    },
    {
      notes:
        "Six items in three groups: rename and pin, the two exports and share, then delete in the "
        + "coral. Both export paths write a file straight from IndexedDB — nothing leaves the device.",
    },
  ),
  sidebarDetail(
    "row-menu-pinned",
    "A pinned row's menu open",
    async (page) => {
      const menu = await openRowMenu(page, PINNED_TITLE);
      await expect(menu.getByRole("menuitem", { name: "Unpin" })).toBeVisible();
    },
    {
      notes:
        "One item differs from sidebar.row-menu — Pin becomes Unpin — and it is the only thing "
        + "that tells a reader the pinned group can be left.",
    },
  ),
  sidebarDetail(
    "row-renaming",
    "A row being renamed",
    async (page) => {
      const menu = await openRowMenu(page, ACTIVE_TITLE);
      await menu.getByRole("menuitem", { name: "Rename" }).click();
      const input = page.getByRole("textbox", { name: "Rename conversation" });
      await expect(input).toBeFocused();
      // The effect focuses AND selects, so the shot should show the title
      // highlighted rather than a caret at one end.
      await expect
        .poll(async () =>
          input.evaluate((node) =>
            node instanceof HTMLInputElement
              ? (node.selectionEnd ?? 0) - (node.selectionStart ?? 0)
              : 0,
          ),
        )
        .toBeGreaterThan(0);
    },
    {
      capture: { mode: "element", selector: LIST },
      notes:
        "The title becomes an input in place, focused with its text selected, so typing replaces "
        + "the whole name. Escape restores it; blur commits — there is no Save.",
    },
  ),
  sidebarDetail(
    "row-delete-confirm",
    "Deleting a conversation — the confirmation",
    async (page) => {
      const menu = await openRowMenu(page, ACTIVE_TITLE);
      await menu.getByRole("menuitem", { name: "Delete" }).click();
      // Scoped to the open dialog: every row mounts its own closed
      // ConfirmDialog, so an unscoped lookup finds one per conversation.
      const dialog = page.locator("dialog[open]");
      await expect(dialog.getByText("Delete conversation?")).toBeVisible();
      await expect(dialog.getByText("This cannot be undone.", { exact: true })).toBeVisible();
    },
    {
      // A native <dialog> renders in the top layer, outside the sidebar's box,
      // so this is the one row state that has to be shot as a whole viewport.
      capture: { mode: "viewport" },
      notes:
        "Three words of warning and a coral confirm. It is a native <dialog> in the top layer, "
        + "which is why it is not clipped by the sidebar — and why it lands in the TOP-LEFT corner "
        + "rather than centred: `showModal()` centres a dialog with `margin: auto`, and Tailwind's "
        + "preflight resets every element's margin to 0. Confirmed the same in W5's "
        + "settings.account-delete-confirm, so it is every ConfirmDialog in the product, not this one.",
    },
  ),

  // ── Search ──────────────────────────────────────────────────────────────
  sidebarDetail(
    "search-results",
    "Searching the history",
    async (page) => {
      await search(page, "winter");
      const results = page.getByRole("listbox", { name: "Search results" });
      await expect(results).toBeVisible();
      await expect(results.locator("mark").first()).toBeVisible();
    },
    {
      notes:
        "Full-text search across every message in IndexedDB, one result per conversation, with "
        + "the match marked inside an 80-character window of its own sentence. The query is planted "
        + "in four of the five seeded replies so the shot has a list rather than a single row.",
    },
  ),
  sidebarDetail(
    "search-no-results",
    "Searching with nothing to find",
    async (page) => {
      await search(page, "kombucha");
      await expect(page.getByText("No conversations found")).toBeVisible();
    },
    {
      notes:
        "A leaf, one line, and a suggestion — the only sidebar empty state that offers a next step "
        + "rather than a description.",
    },
  ),
  sidebarDetail(
    "search-debouncing",
    "Searching — the moment before results",
    async (page) => {
      await search(page, "winter");
      await expect(page.getByText("Searching...")).toBeVisible();
    },
    {
      // Search is debounced by 300ms. A paused clock freezes that timer, which
      // holds open the real interval between the last keystroke and the query
      // — not an invented loading state, just the honest one, stopped.
      clock: { mode: "paused" },
      notes:
        "Held by a paused clock, because 300ms of debounce is not something a screenshot can race. "
        + "Worth its own shot: it is plain unstyled text where every other transient state in the "
        + "product has an illustration.",
    },
  ),

  // ── Selecting several ───────────────────────────────────────────────────
  sidebarDetail(
    "bulk-mode",
    "Multi-select armed, nothing chosen yet",
    async (page) => {
      await enterMultiSelect(page);
    },
    {
      notes:
        "Edit becomes Done, every row grows a checkbox, and the overflow menus disappear — so the "
        + "only thing a row can do in this mode is be chosen. No action bar until something is. "
        + "Worth a designer's eye: the title row is `justify-between`, so with the menu button gone "
        + "the titles jump to the right edge and the column loses its left alignment.",
    },
  ),
  sidebarDetail(
    "bulk-selected",
    "Two conversations chosen",
    async (page) => {
      await enterMultiSelect(page);
      await row(page, ACTIVE_TITLE).getByRole("checkbox").click();
      await row(page, OTHER_TITLE).getByRole("checkbox").click();
      await expect(page.getByText("2 selected")).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete selected" })).toBeEnabled();
    },
    {
      notes:
        "The action bar sticks to the bottom of the list with the count, Deselect, Delete and "
        + "Cancel. Its fourth label, Select All, is unreachable — see this file's header.",
    },
  ),
  sidebarDetail(
    "bulk-delete-confirm",
    "Deleting two conversations — the confirmation",
    async (page) => {
      await enterMultiSelect(page);
      await row(page, ACTIVE_TITLE).getByRole("checkbox").click();
      await row(page, OTHER_TITLE).getByRole("checkbox").click();
      await page.getByRole("button", { name: "Delete selected" }).click();
      await expect(page.locator("dialog[open]").getByText("Delete 2 conversations?")).toBeVisible();
    },
    {
      capture: { mode: "viewport" },
      notes:
        "The count is in the title and the consequence is spelled out — 'All selected conversations "
        + "and their messages will be permanently deleted' — which the single-row confirmation does "
        + "not bother to say. Corner-anchored for the same reason as sidebar.row-delete-confirm. "
        + "Note the action bar behind it: at 280px its four controls do not fit, and Cancel is cut "
        + "off mid-word.",
    },
  ),

  // ── The footer ──────────────────────────────────────────────────────────
  populatedSidebar("footer-signed-in", "The footer with an account", {
    auth: "signed-in",
    realism: "mocked",
    assert: [{ role: "button", name: "Sign out" }],
    notes:
      "The signed-in half of the footer: sign out, and the theme toggle. Every other shot in this "
      + "group is a guest, where the same space offers Create account with a Sync badge and Sign in.",
  }),
  sidebarDetail(
    "signing-out",
    "Signing out",
    async (page) => {
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByText("Signing you out…")).toBeVisible();
    },
    {
      auth: "signed-in",
      realism: "mocked",
      capture: { mode: "viewport" },
      mock: async (page) => {
        // Registered after the fixture's blanket auth mock, so it wins:
        // Playwright matches routes in reverse registration order. Held open,
        // never answered — which parks the app exactly where a slow server
        // would. The app's own 10s timeout is the escape hatch and a capture
        // finishes long before it.
        await page.route("**/api/auth/sign-out", () => undefined);
      },
      assert: [{ selector: SIDEBAR }],
      notes:
        "A full-screen hold with a spinner, not a disabled button — sign-out revokes the session "
        + "and then clears local state, and the copy promises the guest chat survives it.",
    },
  ),
  sidebarDetail(
    "sign-out-error",
    "A sign-out that failed",
    async (page) => {
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByText("Eco could not sign you out.")).toBeVisible();
    },
    {
      auth: "signed-in",
      realism: "mocked",
      mock: async (page) => {
        await page.route("**/api/auth/sign-out", (route) =>
          route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
      },
      assert: [{ selector: SIDEBAR }],
      notes:
        "The server refused, so nothing was revoked and the button comes back rather than "
        + "pretending. The notice is the only coral thing in the sidebar.",
    },
  ),

  // ── The other layout ────────────────────────────────────────────────────
  populatedSidebar("mobile-drawer", "The mobile drawer, open", {
    axes: { viewports: ["mobile"] },
    capture: { mode: "viewport" },
    assert: [{ role: "button", name: "Toggle sidebar" }],
    prepare: async (page) => {
      // A real touch tap, not a click: the mobile projects set hasTouch, and
      // this is the gesture a phone actually sends.
      await page.locator('[aria-label="Toggle sidebar"]').first().tap();
      await expect(page.locator('[data-testid="sheet-title"]')).toHaveText("Navigation");
      // Two sidebars are mounted at this width — the standing column, which CSS
      // hides below `lg`, and this one — so the list has to be found inside the
      // sheet rather than on the page.
      await expect(
        page.locator('[data-testid="bottom-sheet-body"]').locator(LIST),
      ).toBeVisible();
    },
    notes:
      "The same Sidebar, embedded in a BottomSheet that supplies the title bar and close control, "
      + "so its own header is suppressed. It covers the chat rather than sitting beside it, and "
      + "the history scrolls inside the sheet.",
  }),
];
