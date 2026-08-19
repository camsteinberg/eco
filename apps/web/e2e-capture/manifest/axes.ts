// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, type Page } from "@playwright/test";
import type { IdbSeedName } from "../seeds/idb";
import type { AxisOverrides, StateEntry } from "../types";
import { READY_CHAT_SEARCH, UPGRADE_DECLINED_LOCAL, WASM_DEVICE_SEARCH } from "./pilot";

/**
 * W6 — the axis sweeps.
 *
 * Every other wave shoots its states at the default point on three axes:
 * motion `no-preference`, font size `default`, and an explicitly stored theme.
 * This wave is the only one that moves them, and it is deliberately small: the
 * six opt-in projects exist to answer three narrow questions, not to re-shoot
 * the product.
 *
 *   1. Which components actually render DIFFERENTLY under
 *      `prefers-reduced-motion: reduce`?
 *   2. Does the app-wide font-size control really resize the app?
 *   3. With no `eco-theme` stored, does the app follow the operating system in
 *      both directions?
 *
 * ── The reduced-motion family: eleven candidates, two survivors ──────────
 *
 * The wave was planned around roughly fifteen components whose markup was
 * expected to branch on `prefers-reduced-motion`. Eleven were built as entries
 * and shot against their own no-preference twins. Nine were then deleted,
 * because the pixels said they do not branch. That result is the finding, and
 * it is worth stating plainly: Eco's reduced-motion support is almost entirely
 * a TIMING change, which is the idiomatic Motion approach and is invisible in a
 * still photograph of a settled page.
 *
 * Three shapes account for every deletion:
 *
 * - `getTransition(preset, shouldReduce)` (packages/ui/src/animations/presets.ts)
 *   swaps the SPRING, never the target. ThinkingBlock, the message bubbles,
 *   Modal, Toast and Toggle all go through it, so both twins come to rest in
 *   exactly the same place.
 * - `initial={shouldReduce ? false : {...}}` skips an ENTRANCE. The `animate`
 *   target is identical either way and the lane photographs settled pages, so
 *   the entrance is over before the shutter. ChatSurface, SuggestedPrompts,
 *   GroundingNotice, CitationBlock, ModelSelector, ModelUpgradeCard,
 *   GerminatingComposer, UncertaintyNote, WelcomeCard, BelowFloorScreen and
 *   DetailsDisclosure are all this shape.
 * - `motion-reduce:transition-none` on a `transition-colors` / `transition-
 *   transform` class removes a transition, not a resting style — and
 *   `animations: 'disabled'` flattens the difference anyway. MessageActions,
 *   Sidebar, SettingsSwitch, SettingsTabs, AppearanceTab, BottomSheet and
 *   FlagFailureDialog are all this shape.
 *
 * Measured on 2026-08-19, prod build, four projects, differing pixels per twin
 * pair (light / dark, threshold 8/255):
 *
 *   reduce-setup-botanical        3682 / 3677   KEPT
 *   reduce-sidebar-empty            31 /   31   KEPT — element shot, 0.012%
 *   reduce-loading-cursor           34 /   34   deleted, see below
 *   reduce-chat-empty               32 /   31   deleted — diff was the sidebar
 *   reduce-model-selector-open      32 /   32   deleted — diff was the sidebar
 *   reduce-conversation              7 /    0   deleted
 *   reduce-grounding-notice          7 /    3   deleted
 *   reduce-error-card                1 /    0   deleted
 *   reduce-branch-navigation         0 /    0   deleted
 *   reduce-citation-chip             0 /    0   deleted
 *   reduce-thinking-expanded         0 /    0   deleted
 *
 * Two of those deletions are worth their own note, because a naive sha
 * comparison would have kept them:
 *
 * - `reduce-chat-empty` and `reduce-model-selector-open` DID differ — but every
 *   differing pixel sat in the same 208x61 box over the sidebar, which is the
 *   sprout `reduce-sidebar-empty` already photographs properly. The open model
 *   listbox and the empty chat state themselves are pixel-identical. Two more
 *   copies of one finding is not coverage.
 * - `reduce-loading-cursor` was built for the StreamingCursor halo. Its first
 *   pair differed by 7445 pixels, which looked decisive and was not: the whole
 *   transcript was still sliding up on its entrance spring, so the twins
 *   differed by WHEN the shutter fell, not by what was rendered. Waiting for
 *   the transcript's transform AND its viewport rectangle to stop moving
 *   collapsed the difference to 34 pixels, all of them sub-glyph antialiasing
 *   on one 14px icon — invisible to a reviewer. Deleted.
 *
 * The lesson for W7: a differing sha is necessary but not sufficient. Confirm
 * WHERE the pixels differ before believing a pair.
 *
 * ── Real branches this wave cannot photograph ─────────────────────────────
 *
 * 1. `MarkdownRenderer` swaps its whole component map mid-stream
 *    (`MarkdownRenderer.tsx:548-556`). Only reachable while tokens are actually
 *    arriving, and W3 established there is no holdable mid-stream moment.
 * 2. `LocalAiStoragePanel`'s skeleton shimmer (`LocalAiStoragePanel.tsx:189-205`)
 *    is present under no-preference and absent under reduce — a clean branch,
 *    but it lives in a loading state fed by `navigator.storage.estimate()` and
 *    Cache Storage, both of which resolve locally in a few milliseconds with
 *    nothing to hold open.
 * 3. `GrowingStemProgress`, `WaterCounter`, `useCountUp` and `useParallax` have
 *    the strongest reduced-motion branches in the codebase and are all
 *    unreferenced — nothing renders them, so there is nothing to photograph.
 *    A finding for a dead-code sweep rather than for this lane.
 */

/**
 * Both twins of the motion axis, on one viewport and both themes.
 *
 * Desktop only: the question is whether a component's markup branches, and the
 * answer does not change with the viewport — a mobile pair would cost four more
 * shots to re-prove the same thing.
 */
const REDUCE_AXES: AxisOverrides = {
  viewports: ["desktop"],
  themes: ["light", "dark"],
  motion: ["no-preference", "reduce"],
};

/** All three font sizes, one theme, one viewport. */
const FONT_AXES: AxisOverrides = {
  viewports: ["desktop"],
  themes: ["light"],
  fontSize: ["default", "compact", "comfortable"],
};

/**
 * The system-theme pair plus its two explicit counterparts.
 *
 * Including light and dark makes the proof self-contained: the OS-driven shot
 * can be held against the stored-preference shot of the same surface from the
 * same run, rather than against another entry's.
 */
const SYSTEM_AXES: AxisOverrides = {
  viewports: ["desktop"],
  themes: ["light", "dark", "system"],
};

/** The seed every seeded-conversation state here shares. */
function seededSeed(idb: IdbSeedName) {
  return { local: UPGRADE_DECLINED_LOCAL, idb: [idb] };
}

/**
 * Wait for a Motion transform to stop moving.
 *
 * `animations: 'disabled'` fast-forwards CSS animations and does nothing to a
 * Motion spring, so a twin caught on the way in differs from its partner by
 * settle noise rather than by the branch this wave is measuring. Two identical
 * consecutive reads is the only signal that does not guess at a duration.
 */
async function transformSettled(page: Page, selector: string): Promise<void> {
  let previous = "";
  await expect
    .poll(async () => {
      const current = await page.evaluate((sel: string) => {
        const node = document.querySelector(sel);
        if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return "";
        const style = getComputedStyle(node);
        return `${style.transform}|${style.opacity}`;
      }, selector);
      const settled = current !== "" && current === previous;
      previous = current;
      return settled;
    })
    .toBe(true);
}

/** The growth layer of the setup illustration, in either branch. */
const BOTANICAL = '[role="img"][aria-label^="A botanical"]';

export const axesStates: StateEntry[] = [
  // ── Reduced motion: the two that really branch ──────────────────────────
  {
    id: "axes.reduce-setup-botanical",
    group: "axes",
    title: "Setup illustration — growth layer vs static stage",
    route: "/chat",
    // A CPU device, for the same reason `pilot.setup-error-storage` uses one:
    // the WebGPU profile's download plan sits ON the real storage preflight's
    // threshold, so it declines at random and lands on an error screen instead
    // of the setup surface.
    search: WASM_DEVICE_SEARCH,
    seed: {
      // The legacy slot keys no longer confer readiness, but they still steer
      // the gate past the first-run choice and into the download path — which
      // is the only route to `status: 'setting-up'`. See the lane README.
      local: {
        "eco-local-ai-slot-eco-fast": "local/qwen3-0.6b",
        "eco-local-ai-slot-status-eco-fast": "ready",
      },
    },
    tier: "component",
    realism: "mocked",
    server: "any",
    axes: REDUCE_AXES,
    mock: async (page) => {
      // Held open, never fulfilled. Every weight and manifest request is
      // proxied through this same-origin route, so parking it holds the setup
      // surface at `percent: 0` for as long as the shot needs — and downloads
      // no bytes. Without it this state would either race to `ready` or spend
      // the run fetching a real model.
      await page.route("**/api/local-models/**", () => undefined);
    },
    assert: [{ selector: "[data-eco-setup-surface]" }],
    prepare: async (page) => {
      await transformSettled(page, BOTANICAL);
    },
    notes:
      "The one unambiguous branch in the app. BotanicalAnimation returns a plain <div> under "
      + "reduce and a motion.div under no-preference whose growth transform is PERCENT-driven "
      + "rather than time-driven — at 0% it rests at scale(0.9) translateY(6px) and STAYS there, "
      + "so no amount of animation freezing flattens it. Measured 3682 differing pixels against "
      + "its twin and 0 across three separate runs.",
  },
  {
    id: "axes.reduce-sidebar-empty",
    group: "axes",
    title: "Sidebar — the empty-conversations sprout",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "component",
    realism: "seeded",
    axes: REDUCE_AXES,
    // The 16px sprout would be a rounding error in a 1440px frame; shot on the
    // sidebar itself so a reviewer can actually see the thing being compared.
    // `aside` is unambiguous on desktop — the mobile sidebar lives inside a
    // BottomSheet, which returns null while closed.
    capture: { mode: "element", selector: "aside" },
    assert: [{ text: "Your conversations will gather here." }],
    notes:
      "ConversationList renders a plain <svg> under reduce and a motion.svg otherwise "
      + "(ConversationList.tsx:80-106). What the pair actually shows is a defect rather than a "
      + "motion design: the sprout's paths are drawn for a 120-unit viewBox at stroke-width 2.5, "
      + "so at width=16 the strokes land under a third of a pixel. The motion.svg gets its own "
      + "compositing layer and its sub-pixel coverage accumulates into a faint green nub; the "
      + "plain svg rounds away to NOTHING. The empty sidebar therefore has no illustration at "
      + "all for a reader who has asked for less motion, and barely one for everyone else. "
      + "No prepare: the recent-chats disclosure is open by default (`useState(true)`), which "
      + "also means its button reads 'Hide recent chats', not 'Show'.",
  },

  // ── Font size: three surfaces that scale differently ────────────────────
  {
    id: "axes.font-chat-conversation",
    group: "axes",
    title: "A conversation at each font size",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: seededSeed("conversation-basic"),
    tier: "page",
    realism: "seeded",
    server: "prod",
    axes: FONT_AXES,
    assert: [{ selector: '[data-message-id="capture-basic-assistant"]' }],
    notes:
      "The surface the setting exists for. `globals.css` sets the root font-size per "
      + "`[data-font-size]` (14/16/18px), so the whole rem-based layout — bubble padding, "
      + "line length, composer height — moves with it, not just the text.",
  },
  {
    id: "axes.font-settings-appearance",
    group: "axes",
    title: "Settings → Appearance at each font size",
    route: "/settings",
    search: "tab=appearance",
    tier: "page",
    realism: "real",
    axes: FONT_AXES,
    assert: [{ text: "Font size" }],
    notes:
      "The control photographed beside its own effect: the segmented buttons that write "
      + "`eco-font-size` are themselves sized by it.",
  },
  {
    id: "axes.font-content-page",
    group: "axes",
    title: "A content page at each font size",
    route: "/transparency",
    tier: "page",
    realism: "real",
    capture: { mode: "fullPage" },
    axes: FONT_AXES,
    assert: [{ role: "heading", name: "Transparency" }],
    notes:
      "Long-form prose is where a font-size change is most likely to break a layout — fullPage "
      + "so the reflow is visible over the whole document rather than one screen. It is also the "
      + "cheapest proof the axis is wired: the captured document is 3481px tall at Compact, "
      + "3704px at Default and 3898px at Comfortable, so the setting really is driving layout "
      + "and not just glyph size.",
  },

  // ── System theme: no stored preference, both OS directions ──────────────
  {
    id: "axes.system-chat-empty",
    group: "axes",
    title: "Chat — theme resolved from the operating system",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "component",
    realism: "seeded",
    axes: SYSTEM_AXES,
    // Theme-agnostic on purpose: the state is "an empty ready chat", and the
    // theme is what the four shots are compared ON, never what proves them.
    assert: [{ testId: "empty-chat-state" }],
    notes:
      "On the two system projects `eco-theme` is REMOVED rather than set and the OS preference "
      + "is emulated instead, so this is the pre-paint script in app/layout.tsx falling through "
      + "to `matchMedia`. The light and dark shots of the same entry are the stored-preference "
      + "control, and the four came out exactly as they should: the two system shots differ from "
      + "each other by 99.85% of their pixels, and each is within a pixel of its stored-preference "
      + "counterpart. Following the OS produces the same screen as choosing that theme by hand.",
  },
  {
    id: "axes.system-settings-appearance",
    group: "axes",
    title: "Appearance — the theme control with nothing stored",
    route: "/settings",
    search: "tab=appearance",
    tier: "component",
    realism: "real",
    axes: SYSTEM_AXES,
    assert: [{ text: "Theme" }],
    notes:
      "The one surface that states the resolved preference out loud, and the reason this pair "
      + "is worth taking at all: the system shots differ from their stored-preference twins by "
      + "0.38% of their pixels, and every one of those pixels is the segmented control — System "
      + "highlighted instead of Light or Dark. The page around it is identical, which is the "
      + "claim being proved.",
  },
];
