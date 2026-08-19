// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, type Page } from "@playwright/test";
import type { CaptureGap, StateEntry } from "../types";
import { DESKTOP_DEVICE_SEARCH, READY_CHAT_SEARCH, UPGRADE_DECLINED_LOCAL } from "./pilot";

/**
 * W4b — the global overlays.
 *
 * Everything that arrives on top of whatever page you were on: the command
 * palette and the shortcuts sheet, the cookie notice in both its layouts, the
 * offline banner in both its honest wordings, the one toast the product
 * actually fires, the model dropdown, and the consent-driven upgrade card.
 *
 * The welcome overlay and the guided tour are NOT here — they belong to the
 * chat-interactions wave, which runs alongside this one.
 *
 * ── What could not be reached honestly, and why ───────────────────────────
 *
 * - **Success and error toasts.** `ToastProvider` supports three types; a grep
 *   of the whole app for callers of `toast(...)` returns exactly one, the
 *   retired-model notice below, and it is `info`. The success and error styles
 *   ship with no product path that fires them. Calling the context from the
 *   console would photograph a component, not a state, so they are left out —
 *   the honest finding is that two thirds of that component is unreachable.
 * - **The upgrade card's `ready` and `boosted` states, at boot.** Both need
 *   weights verified on disk: `performUpgradeSwap` re-checks the cache before
 *   it swaps and returns `reverted-to-download` when the bytes are missing, and
 *   `boosted` only follows a completed swap. The lane holds every weight
 *   request open by design, so a staged-with-bytes device cannot exist here
 *   without downloading gigabytes per shot. `ready` is captured anyway, through
 *   the one path that does not touch the cache — see `overlays.upgrade-ready`.
 *   `boosted` (the bottom-centre "Eco just got a boost" pill, 6s) has no such
 *   door and is genuinely uncaptured.
 * - **The model dropdown opening DOWNWARD.** `ModelSelector` is mounted once,
 *   by `ChatInput`, at the bottom of the viewport, so the portal always flips
 *   above its trigger. The below-trigger branch of `updateDropdownPosition` is
 *   live code with no mount point that reaches it.
 *
 * ── One thing these shots inherit from the machine ────────────────────────
 *
 * The palette and the shortcuts sheet print their modifier as "Cmd" or "Ctrl"
 * depending on `navigator.platform`, which the lane does not control. A run on
 * macOS and a run on Linux therefore differ in those keycaps for a reason that
 * is not the UI changing. Noted rather than faked, because faking it would mean
 * lying about what a reader's own machine will show them.
 */

/** The composer — on screen before and after every interaction in this file. */
const COMPOSER = '[aria-label="Message input"]';

/** The upgrade card's own hook. `data-upgrade-state` carries its phase. */
const UPGRADE_CARD = '[data-testid="model-upgrade-card"]';

/** Conversations, so the palette's recent list has something in it. */
const HISTORY = [
  "history-pinned",
  "history-week",
  "history-yesterday",
  "history-today",
] as const;

/**
 * A 350M target for the upgrade states.
 *
 * The upgrade download runs the pipeline's real storage preflight, which
 * declines under `plan × 1.1`; a Playwright origin reports roughly 0.9–1.1 GB
 * free (measured for `pilot.setup-error-storage`). The device's actual
 * eco-smart recommendation on the forced desktop profile is a 2.6B, which would
 * trip that preflight at random and defer instead of downloading — so these
 * entries name a small target directly. A seeded record's target is used as
 * given: only `planUpgradeOffer` derives one from the device.
 */
const SMALL_TARGET = "candidate/granite-4.0-350m-onnx";

/** An upgrade cycle parked in one phase, exactly as the app persists it. */
function upgradeRecord(phase: string): Record<string, string> {
  return {
    "eco-local-ai-upgrade-v1": JSON.stringify({
      version: 1,
      phase,
      targetModelId: SMALL_TARGET,
      baseModelId: "local/qwen3-0.6b",
      deferral: null,
      swapAttempts: 0,
      updatedAt: 0,
    }),
  };
}

/**
 * Wait for the upgrade card to stop moving.
 *
 * It enters on a Motion spring (`CARD_SPRING`), which `animations: 'disabled'`
 * does not touch — the same finding the settings wave hit with the Switch
 * dialog. Polling the element's own transform and opacity is the only settle
 * signal that does not guess at a duration.
 */
async function upgradeCardSettled(page: Page, phase: string): Promise<void> {
  const card = page.locator(UPGRADE_CARD);
  await expect(card).toHaveAttribute("data-upgrade-state", phase, { timeout: 20_000 });
  await expect
    .poll(async () =>
      card.evaluate((node) => {
        const style = getComputedStyle(node);
        const { a, d } = new DOMMatrixReadOnly(style.transform);
        return Math.max(Math.abs(a - 1), Math.abs(d - 1), 1 - Number(style.opacity));
      }),
    )
    .toBeLessThan(0.002);
}

/** Open the command palette the only way the product offers. */
async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
}

/** A command-palette state: seeded history, opened, then filtered. */
function paletteState(
  name: string,
  title: string,
  prepare: (page: Page) => Promise<void>,
  notes: string,
): StateEntry {
  return {
    id: `overlays.${name}`,
    group: "overlays",
    title,
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL, idb: [...HISTORY] },
    tier: "micro",
    realism: "seeded",
    // Seeded conversations do not render on the dev server (see chat-surface.ts),
    // and the palette's Conversations section is half of what these show.
    server: "prod",
    assert: [{ selector: COMPOSER }],
    prepare,
    notes,
  };
}

/** What could not be reached honestly here, in a printable form. */
export const overlaysGaps: CaptureGap[] = [
  {
    id: "overlays.toast-success-and-error",
    group: "overlays",
    surface: "The success and error toast styles",
    reason:
      "ToastProvider supports three types; a grep of the whole app for callers of toast(...) returns exactly one — the "
      + "retired-model notice, which is 'info'. The success and error styles ship with NO product path that fires them. "
      + "Calling the context from the console would photograph a component, not a state. The honest finding is that two "
      + "thirds of that component is unreachable.",
  },
  {
    id: "overlays.upgrade-boosted",
    group: "overlays",
    surface: "The upgrade card's `boosted` phase (the bottom-centre “Eco just got a boost” pill, 6s)",
    reason:
      "It only follows a completed swap, and performUpgradeSwap re-checks the cache before it swaps — returning "
      + "reverted-to-download when the bytes are missing. The lane holds every weight request open by design, so a "
      + "staged-with-bytes device cannot exist here without downloading gigabytes per shot. Genuinely uncaptured. "
      + "(`ready` IS captured, through the one path that does not touch the cache — see overlays.upgrade-ready.)",
  },
  {
    id: "overlays.model-dropdown-downward",
    group: "overlays",
    surface: "The model dropdown opening DOWNWARD",
    reason:
      "ModelSelector is mounted once, by ChatInput, at the bottom of the viewport, so the portal always flips above its "
      + "trigger. The below-trigger branch of updateDropdownPosition is live code with no mount point that reaches it.",
  },
];

export const overlaysStates: StateEntry[] = [
  // ── Command palette ─────────────────────────────────────────────────────
  paletteState(
    "command-palette",
    "Command palette — just opened",
    async (page) => {
      await openPalette(page);
      await expect(page.getByRole("option", { name: /New chat/ })).toBeVisible();
      await expect(page.getByText("Conversations", { exact: true })).toBeVisible();
    },
    "Every action with its keycaps, and a footer that teaches the three keys that drive it. The "
      + "first row is selected on open, so Enter always does something. The Conversations section "
      + "is there but below the fold: the list is capped at 20rem and eight actions fill it, so a "
      + "reader has to scroll or arrow down to learn that recents exist — see "
      + "overlays.command-palette-selection-moved, which is what that looks like.",
  ),
  paletteState(
    "command-palette-filtered",
    "Command palette — filtered to one section",
    async (page) => {
      await openPalette(page);
      await page.getByRole("combobox", { name: "Search commands" }).fill("export");
      await expect(page.getByRole("option", { name: /Export as Markdown/ })).toBeVisible();
      await expect(page.getByText("Conversations", { exact: true })).toBeHidden();
    },
    "A query that matches only actions drops the Conversations heading entirely rather than "
      + "showing it empty — the sections are results, not furniture.",
  ),
  paletteState(
    "command-palette-conversations",
    "Command palette — filtered to a conversation",
    async (page) => {
      await openPalette(page);
      await page.getByRole("combobox", { name: "Search commands" }).fill("bread");
      await expect(page.getByRole("option", { name: /Bread without a stand mixer/ })).toBeVisible();
      await expect(page.getByText("Actions", { exact: true })).toBeHidden();
    },
    "The mirror of the filtered shot: the query matches a conversation title and no action, so "
      + "the palette becomes a jump list. Matching is a plain case-insensitive substring on the "
      + "title only — the message bodies are the sidebar search's job.",
  ),
  paletteState(
    "command-palette-no-results",
    "Command palette — nothing matched",
    async (page) => {
      await openPalette(page);
      await page.getByRole("combobox", { name: "Search commands" }).fill("kombucha");
      await expect(page.getByText("No results found")).toBeVisible();
    },
    "Four words, centred, with the footer still promising Enter selects — the one place in the "
      + "product where an empty result gets no illustration and no suggestion.",
  ),
  paletteState(
    "command-palette-selection-moved",
    "Command palette — the selection moved into Conversations",
    async (page) => {
      await openPalette(page);
      const selected = page.locator('[role="option"][aria-selected="true"]');
      // Walk down until the highlight lands in the Conversations section. The
      // action count varies with what the page can offer (Search current
      // conversation only exists when one is open), so counting presses would
      // silently photograph the wrong row.
      for (let press = 0; press < 14; press += 1) {
        const id = await selected.getAttribute("id");
        if (id?.startsWith("cmd-option-conv-") === true) break;
        await page.keyboard.press("ArrowDown");
      }
      await expect(selected).toHaveAttribute("id", /^cmd-option-conv-/);
    },
    "Arrow keys move one highlight across both sections without a section ever being 'entered'. "
      + "Worth its own shot because the selected row is the only styling difference in the list, "
      + "and it has to read as selected against a hover that looks similar.",
  ),

  // ── Shortcuts ───────────────────────────────────────────────────────────
  {
    id: "overlays.shortcuts",
    group: "overlays",
    title: "Keyboard shortcuts",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "micro",
    realism: "seeded",
    assert: [{ selector: COMPOSER }],
    prepare: async (page) => {
      await page.keyboard.press("ControlOrMeta+/");
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
    },
    notes:
      "Eleven shortcuts in four groups. Opened by its own shortcut, which is the honest way in — "
      + "the command palette also offers it, and both land here.",
  },

  // ── Cookie notice ───────────────────────────────────────────────────────
  {
    id: "overlays.cookie-notice-chat",
    group: "overlays",
    title: "Cookie notice — the chat layout",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: {
      local: UPGRADE_DECLINED_LOCAL,
      // Removals run last, so this un-suppresses what the base first-run bundle
      // hides in every other capture.
      removeLocal: ["eco-cookie-consent-dismissed"],
    },
    tier: "component",
    realism: "seeded",
    assert: [{ text: "Only essential cookies and local browser preferences." }],
    notes:
      "On a chat surface the notice lifts itself clear of the composer and the app adds a "
      + "reservation class to <html> so the Send button is never covered. One sentence, one link, "
      + "one dismiss — and the dismissal is itself the only thing it stores.",
  },
  {
    id: "overlays.cookie-notice-marketing",
    group: "overlays",
    title: "Cookie notice — the content layout",
    route: "/privacy",
    seed: { removeLocal: ["eco-cookie-consent-dismissed"] },
    tier: "component",
    realism: "seeded",
    assert: [{ text: "Only essential cookies and local browser preferences." }],
    notes:
      "The same notice on a page with no composer to avoid: it sits at the bottom edge on mobile "
      + "and in the bottom-right corner from `sm` up. Paired with the chat layout on purpose — the "
      + "two are one component with two position sets, and they are easy to change apart by accident.",
  },

  // ── Offline ─────────────────────────────────────────────────────────────
  {
    id: "overlays.offline-with-model",
    group: "overlays",
    title: "Offline, with a model on this device",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "component",
    realism: "seeded",
    // Structural, and true in both phases: the banner itself only exists after
    // `prepare` cuts the network, and proving it is `prepare`'s job.
    assert: [{ selector: COMPOSER }],
    prepare: async (page) => {
      // Cut the network AFTER the document is loaded. Doing it in `mock` would
      // sever the navigation itself — the offline-fallback route state is the
      // only one that can, because a service worker answers it.
      await page.context().setOffline(true);
      await expect(page.getByText("You're offline — and that's okay.")).toBeVisible();
    },
    notes:
      "The local-first promise landing rather than a failure: the leaf, not the warning triangle, "
      + "and the only caveat is that web lookups are paused. Reads the same slot registry the chat "
      + "does, so it cannot claim readiness the app does not have.",
  },
  {
    id: "overlays.offline-without-model",
    group: "overlays",
    title: "Offline, before any model is set up",
    // Not /chat. With no ready slot the setup gate takes the whole surface, and
    // the shot came out as the welcome card — W2's subject — with the banner a
    // sliver behind its scrim. The banner belongs to the app shell, so any
    // shell route shows it; a settings tab shows it against something calm.
    route: "/settings",
    search: `tab=appearance&${DESKTOP_DEVICE_SEARCH}`,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "component",
    realism: "seeded",
    assert: [{ selector: "header" }],
    prepare: async (page) => {
      await page.context().setOffline(true);
      await expect(page.getByText("You're offline.", { exact: false })).toBeVisible();
      await expect(page.getByText("Eco needs to connect just once")).toBeVisible();
    },
    notes:
      "No ready slot, so the same banner tells the other truth — the one connection Eco genuinely "
      + "needs — with a warning triangle instead of the leaf. The setup gate behind it is W2's "
      + "subject; the banner is this one's.",
  },

  // ── The one toast the product fires ─────────────────────────────────────
  {
    id: "overlays.retired-model-toast",
    group: "overlays",
    title: "Toast — the model you were using was retired",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: {
      local: {
        ...UPGRADE_DECLINED_LOCAL,
        // Exactly what lifecycle/self-heal.ts leaves behind when the boot
        // migration retires the model the reader was actually running.
        "eco-local-ai-retired-notice-v1": JSON.stringify({ label: "Eco Compact" }),
      },
    },
    tier: "component",
    realism: "seeded",
    // The notice dismisses itself after eight seconds, which a settle plus a
    // screenshot can lose. The clock is frozen through settling and then
    // advanced just far enough for the page's own entrance springs to finish,
    // so the toast is two seconds old in every run instead of however long the
    // machine took.
    clock: { mode: "paused", advanceMs: 2_000 },
    assert: [{ text: "is no longer offered" }],
    notes:
      "The only toast with a live caller anywhere in the app. Info styling, and eight seconds "
      + "rather than the default three because there are two sentences to read. It also sits on "
      + "top of the chat's floating help button, which is bottom-right too — visible here by "
      + "comparing this shot with any other chat capture.",
  },

  // ── Model selector ──────────────────────────────────────────────────────
  {
    id: "overlays.model-selector-dropdown",
    group: "overlays",
    title: "Model selector — the desktop dropdown",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "micro",
    realism: "seeded",
    assert: [{ testId: "model-selector" }],
    prepare: async (page) => {
      await page.locator('[data-testid="model-selector"]').first().click();
      await expect(page.getByRole("listbox", { name: "Select model" })).toBeVisible();
    },
    notes:
      "The pointer twin of the mobile bottom sheet (pilot.model-selector-sheet): a portalled panel "
      + "measured against the trigger. Its only mount is in the composer, at the bottom of the "
      + "window, so it always opens upward.",
  },

  // ── The upgrade card ────────────────────────────────────────────────────
  {
    id: "overlays.upgrade-offer",
    group: "overlays",
    title: "Upgrade — a stronger AI is offered",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    // Deliberately no upgrade record: the offer's target is whatever
    // `recommend('eco-smart', …)` returns for the forced desktop profile, and
    // seeding one would be asserting that answer instead of reading it.
    tier: "component",
    realism: "seeded",
    assert: [{ testId: "model-upgrade-card" }],
    prepare: async (page) => {
      await upgradeCardSettled(page, "offer");
      await expect(page.getByRole("button", { name: "Download in background" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
    },
    notes:
      "The one card every other chat capture suppresses, on purpose, so it can be looked at once. "
      + "Top-right rather than bottom-right — a bottom-anchored consent card can intercept the Send "
      + "button on some window sizes, which the launch journeys caught. Nothing downloads until "
      + "the reader says yes, and 'Not now' is remembered rather than re-asked.",
  },
  {
    id: "overlays.upgrade-downloading",
    group: "overlays",
    title: "Upgrade — downloading in the background",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: upgradeRecord("accepted") },
    tier: "component",
    realism: "seeded",
    assert: [{ testId: "model-upgrade-card" }],
    prepare: async (page) => {
      await upgradeCardSettled(page, "downloading");
      await expect(page.getByRole("progressbar", { name: "Download progress" })).toBeVisible();
    },
    notes:
      "An accepted cycle resumed at boot, parked at its first byte because the lane holds weight "
      + "requests open — so the bar reads 0% honestly rather than a different number every run. "
      + "The copy's whole job is the second line: nothing pauses while this happens.",
  },
  {
    id: "overlays.upgrade-ready",
    group: "overlays",
    title: "Upgrade — ready, asking before it switches",
    route: "/chat",
    // A settled cycle, so this tab's boot flow does nothing and leaves the
    // machine's passive cross-tab listener as the only thing driving the UI.
    search: READY_CHAT_SEARCH,
    seed: { local: upgradeRecord("declined") },
    tier: "component",
    realism: "seeded",
    assert: [{ selector: COMPOSER }],
    prepare: async (page) => {
      // The shipping path: another tab finished the download and moved the
      // record to `staged`; this tab's `storage` listener reflects that as the
      // ready prompt. It is used here because it is the ONLY route to this
      // state that does not re-check the weights cache — the boot swap does,
      // finds nothing, and reverts to downloading (see this file's header).
      const other = await page.context().newPage();
      try {
        await other.goto("/privacy");
        await other.evaluate((record: string) => {
          window.localStorage.setItem("eco-local-ai-upgrade-v1", record);
        }, JSON.stringify({
          version: 1,
          phase: "staged",
          targetModelId: SMALL_TARGET,
          baseModelId: "local/qwen3-0.6b",
          deferral: null,
          swapAttempts: 0,
          // Distinct from the seeded record's 0, or the write is a no-op and
          // no storage event fires.
          updatedAt: 1,
        }));
      } finally {
        await other.close();
      }
      await upgradeCardSettled(page, "ready");
      // Scoped to the card: the composer's disabled research toggle is
      // labelled "Deeper research mode, coming later", which an unscoped
      // "Later" lookup also matches.
      const card = page.locator(UPGRADE_CARD);
      await expect(card.getByRole("button", { name: "Switch now" })).toBeVisible();
      await expect(card.getByRole("button", { name: "Later" })).toBeVisible();
    },
    notes:
      "Consent asked a second time, at the moment it costs something: the swap takes a few seconds "
      + "and the card promises the conversation survives it. 'Later works too' is the line that "
      + "makes Later a real option rather than a delay.",
  },
  {
    id: "overlays.upgrade-deferred",
    group: "overlays",
    title: "Upgrade — deferred, and honest about why",
    route: "/chat",
    search: `eco-force-download=quota&${READY_CHAT_SEARCH}`,
    seed: { local: upgradeRecord("accepted") },
    tier: "component",
    realism: "seeded",
    assert: [{ testId: "model-upgrade-card" }],
    prepare: async (page) => {
      await upgradeCardSettled(page, "deferred");
      await expect(page.getByText("Sticking with your current AI")).toBeVisible();
      await expect(page.getByRole("button", { name: "Okay" })).toBeVisible();
    },
    notes:
      "The download ran out of room, so the cycle settles instead of retrying: a grey sprout, the "
      + "pipeline's own byte-count sentence, and one dismissal. No terminal screen and no 'try "
      + "again' — the device already has a model that works.",
  },
];
