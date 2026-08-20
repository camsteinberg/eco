// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, type Page } from "@playwright/test";
import { focusVisibleState } from "../capture";
import type { CaptureGap, StateEntry } from "../types";
import { READY_CHAT_SEARCH, UPGRADE_DECLINED_LOCAL } from "./pilot";

/**
 * Keyboard-focus states — what a keyboard user sees on each focus recipe.
 *
 * Every other group photographs surfaces at rest or under a pointer; none of
 * them shows what the product looks like to someone driving it with Tab. Eco
 * ships four distinct focus treatments, and this group photographs one honest
 * example of each rather than every field in the app — the recipes are shared
 * utility classes, so a second field with the same recipe is the same pixels:
 *
 *   1. A field's own `:focus` ring — border turns primary plus a soft 2px ring
 *      (`focus:ring-2 focus:ring-[--eco-primary]/20`). The sidebar search box
 *      and the auth inputs both carry it; one of each is shot because the two
 *      containers render it at very different sizes.
 *   2. The composer's `focus-within` treatment — the ring and shadow land on
 *      the wrapping form, not the textarea, which suppresses its own outline.
 *   3. The shared Button's keyboard-only ring (`focus-visible:ring-2` with a
 *      ring offset) — invisible to mouse clicks by design.
 *   4. The global fallback: `globals.css` gives anything without its own
 *      treatment a 2px `var(--color-primary)` outline, keyboard-only. The send
 *      button is the most important control relying on it.
 *
 * Focus arrives by real Tab presses (`focusVisibleState`), never by
 * `element.focus()` — a programmatic focus sets `:focus` but not
 * `:focus-visible`, so it would photograph a ring users never see missing, or
 * miss one they do. The same honesty makes these states an accessibility
 * check: a target that 40 Tabs cannot reach fails the run.
 *
 * Each `prepare` also proves the treatment actually painted, by comparing the
 * target's computed focus styling before and after the walk. The send-button
 * state asserts the global outline's computed shape outright, which is a live
 * check that `--color-primary` (a Tailwind `@theme inline` alias) resolves at
 * runtime — if that alias ever breaks, the whole app loses its keyboard focus
 * indicator and this state fails instead of photographing the loss quietly.
 */

const COMPOSER = '[aria-label="Message input"]';
const COMPOSER_FORM = `form:has(${COMPOSER})`;
const SEND_BUTTON = '[aria-label="Send message"]';
const SIDEBAR_SEARCH = '[data-testid="conversation-search"]';

/** The computed properties every focus recipe here paints with. */
async function focusStyle(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel: string) => {
    const node = document.querySelector(sel);
    if (!(node instanceof HTMLElement)) return "";
    const style = getComputedStyle(node);
    return `${style.boxShadow}|${style.borderColor}|${style.outlineStyle}`;
  }, selector);
}

/**
 * Tab to `focusSelector` and prove the focus styling on `styledSelector`
 * visibly changed — the styled element is not always the focused one (the
 * composer's ring lands on the wrapping form).
 */
function tabWalk(focusSelector: string, styledSelector = focusSelector) {
  return async (page: Page): Promise<void> => {
    const before = await focusStyle(page, styledSelector);
    await focusVisibleState(page, focusSelector);
    await expect
      .poll(() => focusStyle(page, styledSelector))
      .not.toBe(before);
  };
}

/**
 * None. The one candidate this group ever declared — the Badge component,
 * exported from both barrels but rendered nowhere — was deleted outright, so
 * there is no longer a surface to be missing.
 */
export const controlsGaps: CaptureGap[] = [];

export const controlsStates: StateEntry[] = [
  {
    id: "controls.focus-composer",
    group: "controls",
    title: "Composer — keyboard focus (ring and shadow on the wrapper)",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "micro",
    realism: "seeded",
    // Viewport, not an element crop: the ring sits ON the form wrapper, and an
    // element screenshot clips at the element's own box — it would cut off the
    // very pixels this state exists to show.
    assert: [{ testId: "empty-chat-state" }, { selector: COMPOSER }],
    prepare: tabWalk(COMPOSER, COMPOSER_FORM),
    notes:
      "The textarea suppresses its own outline; the treatment is focus-within on the form. "
      + "Real Tab presses, so this is also the proof the composer is keyboard-reachable.",
  },
  {
    id: "controls.focus-sidebar-search",
    group: "controls",
    title: "Sidebar search — keyboard focus (field's own ring, compact variant)",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL, idb: ["conversation-basic"] },
    tier: "micro",
    realism: "seeded",
    server: "prod",
    capture: { mode: "element", selector: "aside" },
    assert: [{ selector: SIDEBAR_SEARCH }],
    prepare: tabWalk(SIDEBAR_SEARCH),
    notes:
      "A seeded conversation so the list renders around the field; prod-only for the same "
      + "StrictMode reason as every seeded-conversation state. The ring is on the input, "
      + "inside the aside's padding, so the element crop keeps it.",
  },
  {
    id: "controls.focus-auth-email",
    group: "controls",
    title: "Sign in — email field focused via keyboard",
    route: "/sign-in",
    tier: "micro",
    realism: "real",
    assert: [{ role: "heading", name: "Welcome back" }],
    prepare: tabWalk("#email"),
    notes: "The auth card's field treatment at its largest rendering — border to primary plus the soft ring.",
  },
  {
    id: "controls.focus-auth-submit",
    group: "controls",
    title: "Sign in — primary button focused via keyboard (focus-visible ring)",
    route: "/sign-in",
    tier: "micro",
    realism: "real",
    assert: [{ role: "heading", name: "Welcome back" }],
    prepare: tabWalk('button[type="submit"]'),
    notes:
      "The shared Button's ring is focus-visible-only — a mouse click never shows it, "
      + "so real Tab presses are the only honest way to photograph it.",
  },
  {
    id: "controls.focus-send-button",
    group: "controls",
    title: "Send button — the global keyboard outline",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { local: UPGRADE_DECLINED_LOCAL },
    tier: "micro",
    realism: "seeded",
    capture: { mode: "element", selector: COMPOSER_FORM },
    assert: [{ selector: COMPOSER }, { selector: SEND_BUTTON }],
    prepare: async (page) => {
      // Disabled controls are not tabbable, and the send button is disabled
      // while the composer is empty — give it a draft first.
      await page.locator(COMPOSER).first().fill("What helps tomatoes ripen late in the season?");
      await focusVisibleState(page, SEND_BUTTON);
      // The button declares no focus utilities of its own; the ring it gets is
      // globals.css's `:focus-visible { outline: 2px solid var(--color-primary) }`.
      // An unresolvable token would invalidate that declaration and the outline
      // would compute to none — fail here rather than photograph the loss.
      await expect
        .poll(() =>
          page.evaluate((sel: string) => {
            const node = document.querySelector(sel);
            if (!(node instanceof HTMLElement)) return "";
            const style = getComputedStyle(node);
            return `${style.outlineStyle} ${style.outlineWidth}`;
          }, SEND_BUTTON),
        )
        .toBe("solid 2px");
    },
    notes:
      "The one control here with NO treatment of its own — this shot is the global fallback "
      + "outline, and its prepare doubles as the runtime proof that --color-primary resolves.",
  },
];
