// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, type Page } from "@playwright/test";
import type { CaptureGap, StateEntry } from "../types";
import { DESKTOP_DEVICE_SEARCH, READY_CHAT_SEARCH, READY_WASM_CHAT_SEARCH } from "./pilot";

/**
 * W4b — the global overlays.
 *
 * Everything that arrives on top of whatever page you were on: the command
 * palette and the shortcuts sheet, the cookie notice in both its layouts, the
 * offline banner in both its honest wordings, the one toast the product
 * actually fires, and the model selector in each of its states.
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
 * - **The model tile mid-swap** was declared a gap until 2026-08-24: "Preparing"
 *   only exists while `performUpgradeSwap` runs, and that re-checks the weights
 *   cache first and reverts to downloading when the bytes are missing, which no
 *   lane device can satisfy without a real multi-gigabyte transfer. It is now
 *   captured through a harness seam (`eco-force-swap=hold`) that enters the
 *   swapping phase ahead of that re-check and stays there, acquiring no lease
 *   and loading no weights — see `overlays.model-tile-swapping`.
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

/** The model tile's pull row. `data-pull-state` carries its phase. */
const TILE_PULL = '[data-testid="model-tile-pull"]';

/** Conversations, so the palette's recent list has something in it. */
const HISTORY = [
  "history-pinned",
  "history-week",
  "history-yesterday",
  "history-today",
] as const;

/**
 * The deeper half of the pair on the CPU-only desktop profile.
 *
 * A pull runs the pipeline's real storage preflight, which declines under
 * `plan × 1.1`; a Playwright origin reports roughly 0.9–1.1 GB free (measured
 * for `pilot.setup-error-storage`). The deeper tile on the forced DESKTOP
 * profile is a 2.6B, which would trip that preflight at random and defer
 * instead of downloading. On the CPU-only profile the pair is a 360M and this
 * 350M, whose plan clears the preflight by roughly 1.5×, so the tile states
 * below ride that profile. Both ids come from `deriveFirstRunChoices` for that
 * profile, not from a guess.
 */
const WASM_DEEPER_TARGET = "candidate/granite-4.0-350m-onnx";

/** A pull parked in one phase, exactly as the app persists it. */
function pullRecord(phase: string): Record<string, string> {
  return {
    "eco-local-ai-upgrade-v1": JSON.stringify({
      version: 1,
      phase,
      targetModelId: WASM_DEEPER_TARGET,
      targetSlot: "eco-smart",
      baseModelId: null,
      deferral: null,
      swapAttempts: 0,
      updatedAt: 0,
    }),
  };
}

/** Open the model selector the way a pointer user does. */
async function openSelector(page: Page): Promise<void> {
  await page.locator('[data-testid="model-selector"]').first().click();
  await expect(page.getByRole("listbox", { name: "Select model" })).toBeVisible();
}

/** Open it the way a phone does — a real tap, not a click. */
async function tapSelector(page: Page): Promise<void> {
  await page.locator('[data-testid="model-selector"]').first().tap();
  await expect(page.locator('[data-testid="sheet-title"]')).toBeVisible();
}

/** Wait for the tile to be reporting the phase this shot is about. */
async function tilePullSettled(page: Page, phase: string): Promise<void> {
  await expect(page.locator(TILE_PULL)).toHaveAttribute("data-pull-state", phase, {
    timeout: 20_000,
  });
}

/**
 * Move the record to `staged` from ANOTHER tab.
 *
 * It is the only route to the tile's ready state that does not re-check the
 * weights cache: the swap path does, finds nothing, and reverts to downloading.
 * This is the shipping path too — one tab finishes the download, every other
 * tab's storage listener reflects it.
 */
async function stageFromAnotherTab(page: Page): Promise<void> {
  const other = await page.context().newPage();
  try {
    await other.goto("/privacy");
    await other.evaluate((record: string) => {
      window.localStorage.setItem("eco-local-ai-upgrade-v1", record);
    }, JSON.stringify({
      version: 1,
      phase: "staged",
      targetModelId: WASM_DEEPER_TARGET,
      targetSlot: "eco-smart",
      baseModelId: null,
      deferral: null,
      swapAttempts: 0,
      // Distinct from the seeded record's 0, or the write is a no-op and no
      // storage event fires.
      updatedAt: 1,
    }));
  } finally {
    await other.close();
  }
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
    seed: { idb: [...HISTORY] },
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
      + "rather than the default three because there are two sentences to read. It used to land "
      + "on top of the chat's floating help button in the same bottom-right corner; the toast "
      + "container is now width-capped and offset clear of the button's lane.",
  },

  // ── Model selector ──────────────────────────────────────────────────────
  {
    id: "overlays.model-selector-dropdown",
    group: "overlays",
    title: "Model selector — the desktop dropdown",
    route: "/chat",
    search: READY_CHAT_SEARCH,
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
      + "window, so it is anchored above the trigger — the one direction the component has.",
  },

  // ── The model tile's own states ─────────────────────────────────────────
  {
    id: "overlays.model-tile-dropdown-mobile-sheet",
    group: "overlays",
    title: "Model selector — the touch bottom sheet",
    route: "/chat",
    search: READY_WASM_CHAT_SEARCH,
    tier: "micro",
    realism: "seeded",
    axes: { viewports: ["mobile"] },
    assert: [{ testId: "model-selector" }],
    prepare: tapSelector,
    notes:
      "The same tiles as the pointer dropdown, in the layout a phone gets. Here on the CPU-only "
      + "profile so it is the same pair the two states below move through.",
  },
  {
    id: "overlays.model-tile-downloading",
    group: "overlays",
    title: "Model tile — downloading in the background",
    route: "/chat",
    search: READY_WASM_CHAT_SEARCH,
    seed: { local: pullRecord("accepted") },
    tier: "component",
    realism: "seeded",
    // Desktop only: this documents the pointer dropdown. On a phone the same
    // open renders the bottom sheet, which is the -sheet twin's whole job —
    // without the restriction the two ids photograph identical pixels there.
    axes: { viewports: ["desktop"] },
    assert: [{ testId: "model-selector" }],
    prepare: async (page) => {
      await openSelector(page);
      await tilePullSettled(page, "downloading");
      await expect(page.getByRole("progressbar")).toBeVisible();
    },
    notes:
      "A pull the reader asked for in a previous session, resumed at boot and parked at its first "
      + "byte because the lane holds weight requests open — so the bar reads 0% honestly rather "
      + "than a different number every run. The tile it happens on is the one that was tapped; the "
      + "other tile is untouched, and the conversation behind the panel never paused.",
  },
  {
    id: "overlays.model-tile-downloading-sheet",
    group: "overlays",
    title: "Model tile — downloading, in the touch sheet",
    route: "/chat",
    search: READY_WASM_CHAT_SEARCH,
    seed: { local: pullRecord("accepted") },
    tier: "component",
    realism: "seeded",
    axes: { viewports: ["mobile"] },
    assert: [{ testId: "model-selector" }],
    prepare: async (page) => {
      await tapSelector(page);
      await tilePullSettled(page, "downloading");
    },
    notes:
      "The phone twin. Worth its own shot because the sheet gives the tile more width than the "
      + "320px dropdown does, which is where the progress row has to hold up.",
  },
  {
    id: "overlays.model-tile-ready",
    group: "overlays",
    title: "Model tile — ready, waiting to be switched to",
    route: "/chat",
    search: READY_WASM_CHAT_SEARCH,
    tier: "component",
    realism: "seeded",
    // Desktop only, for the same reason as model-tile-downloading above.
    axes: { viewports: ["desktop"] },
    assert: [{ testId: "model-selector" }],
    prepare: async (page) => {
      await openSelector(page);
      await stageFromAnotherTab(page);
      await tilePullSettled(page, "ready");
      await expect(page.getByRole("button", { name: /Switch now/ })).toBeVisible();
    },
    notes:
      "The whole reason nothing swaps on its own: the bytes are here, and the tile says so and "
      + "waits. One button, in the tile that asked for it, and no card anywhere on the surface. "
      + "The composer trigger carries a single dot for the same fact while the panel is closed.",
  },
  {
    id: "overlays.model-tile-swapping",
    group: "overlays",
    title: "Model tile — mid-swap, preparing the new model",
    route: "/chat",
    search: `${READY_WASM_CHAT_SEARCH}&eco-force-swap=hold`,
    tier: "component",
    realism: "seeded",
    // Desktop only, for the same reason as model-tile-downloading above.
    axes: { viewports: ["desktop"] },
    assert: [{ testId: "model-selector" }],
    prepare: async (page) => {
      await openSelector(page);
      await stageFromAnotherTab(page);
      await tilePullSettled(page, "ready");
      await page.getByRole("button", { name: /Switch now/ }).click();
      await tilePullSettled(page, "swapping");
      await expect(page.getByRole("progressbar", { name: "Switch progress" })).toBeVisible();
      await expect(page.getByText("Preparing 60%")).toBeVisible();
    },
    internal: true,
    notes:
      "The beat between tapping Switch now and the new model answering: the same tile, same "
      + "place, a second bar. Reached through eco-force-swap=hold, which enters the swapping "
      + "phase and holds it — the real path re-checks the weights cache first and would revert "
      + "to downloading on a device that never really fetched them. The 60% is the seam's one "
      + "fixed fraction, chosen so the bar reads the same every run; the phase, the copy and the "
      + "layout are the product's own.",
  },
  {
    id: "overlays.model-tile-ready-sheet",
    group: "overlays",
    title: "Model tile — ready, in the touch sheet",
    route: "/chat",
    search: READY_WASM_CHAT_SEARCH,
    tier: "component",
    realism: "seeded",
    axes: { viewports: ["mobile"] },
    assert: [{ testId: "model-selector" }],
    prepare: async (page) => {
      await tapSelector(page);
      await stageFromAnotherTab(page);
      await tilePullSettled(page, "ready");
    },
    notes:
      "The phone twin of the switch affordance — the one tap that changes which model answers.",
  },
  {
    id: "overlays.account-required-dialog",
    group: "overlays",
    title: "Account required — the sign-in dialog over locked settings",
    route: "/settings",
    search: "tab=account",
    tier: "component",
    realism: "real",
    // The locked-preview headline stays true behind the open modal, so it
    // holds in both assertion phases; the dialog itself is prepare's proof.
    assert: [{ text: "Your account" }],
    prepare: async (page) => {
      await page.getByRole("button", { name: "Sign in" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByText("Sign in to use your account")).toBeVisible();
      await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
    },
    notes:
      "A guest pressing into the account tab meets this native <dialog> (showModal). It had never "
      + "been photographed — the grid captured the locked pages but not the dialog they open.",
  },
];
