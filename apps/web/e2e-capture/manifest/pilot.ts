// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect } from "@playwright/test";
import { openMenu } from "../capture";
import type { StateEntry } from "../types";

/**
 * Pilot states — one per mechanism the lane has to get right.
 *
 * These are not a coverage wave. Each entry exists to prove that a specific
 * capability of `capture.ts` actually works against the real app: harness
 * seeding, forced failure, the paused clock, storage removal, real hover, a
 * real menu, mocked auth, and a touch-only mobile overlay. Later waves lean on
 * every one of them, so this file is the lane's own regression net.
 */

/**
 * Slot readiness rides on the URL, not on localStorage.
 *
 * Verified empirically on 2026-08-18 against the dev:validation server: seeding
 * the legacy `eco-local-ai-slot-*` keys (the recipe in `e2e/visual/fixtures.ts`)
 * does NOT reach a ready chat — it lands on "Finishing your model download…".
 * The harness URL params below do. See the README for the full finding.
 */
const READY_SLOT_SEARCH = [
  "eco-validation-slot-eco-fast=local/qwen3-0.6b",
  "eco-validation-slot-status-eco-fast=ready",
  "eco-validation-selected-model=eco-fast",
  "eco-force-cache-verified=1",
].join("&");

/** Force a predictable device so recommendation never varies by host hardware. */
const DESKTOP_DEVICE_SEARCH = [
  "eco-force-capability=webgpu",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=16",
  "eco-force-opfs=true",
].join("&");

const READY_CHAT_SEARCH = `${READY_SLOT_SEARCH}&${DESKTOP_DEVICE_SEARCH}`;

/** The assistant reply the app's own IndexedDB fixture installs. */
const FIXTURE_ASSISTANT_ROW = '[data-message-id="eco-validation-assistant-message"]';

export const pilotStates: StateEntry[] = [
  {
    id: "pilot.privacy-page",
    group: "pilot",
    title: "Privacy policy (full page)",
    route: "/privacy",
    tier: "page",
    realism: "real",
    capture: { mode: "fullPage" },
    assert: [{ role: "heading", name: "Privacy Policy" }],
    notes: "Content route with no app shell — proves the plain page path and fullPage capture.",
  },
  {
    id: "pilot.chat-empty-ready",
    group: "pilot",
    title: "Chat — empty state with a ready model",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    tier: "page",
    realism: "seeded",
    clock: { mode: "fixed" },
    assert: [{ testId: "empty-chat-state" }],
    notes: "The lane's workhorse state: harness-seeded ready slot, so no download ever runs.",
  },
  {
    id: "pilot.setup-error-storage",
    group: "pilot",
    title: "Setup error — not enough free space",
    route: "/chat",
    search: `eco-force-download=quota&${DESKTOP_DEVICE_SEARCH}`,
    seed: {
      // Getting to a DOWNLOAD failure means getting past the first-run choice.
      // The legacy slot keys no longer confer readiness (see READY_SLOT_SEARCH)
      // but they do still steer the gate into the resume/download path, which
      // is exactly where eco-force-download can fail it.
      local: {
        "eco-local-ai-slot-eco-fast": "local/qwen3-0.6b",
        "eco-local-ai-slot-status-eco-fast": "ready",
      },
    },
    tier: "page",
    realism: "seeded",
    assert: [{ text: "Eco needs a little more free space" }],
    notes: "Forced through eco-force-download=quota; the storage headline is the honest copy for it.",
  },
  {
    id: "pilot.welcome-first-run",
    group: "pilot",
    title: "First-run welcome (clock paused)",
    route: "/chat",
    search: DESKTOP_DEVICE_SEARCH,
    // Removals run last, so this un-suppresses the first-run surface the base
    // onboarding bundle exists to hide.
    seed: { removeLocal: ["eco-onboarding"] },
    tier: "page",
    realism: "seeded",
    clock: { mode: "paused", advanceMs: 1_200 },
    assert: [{ text: "Welcome to Eco" }],
    notes: "Proves clock.install + runFor: the botanical intro is parked 1.2s in, identically every run.",
  },
  {
    id: "pilot.message-actions-hover",
    group: "pilot",
    title: "Assistant reply — actions row revealed on hover",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { idb: ["conversation-assistant-dom"] },
    tier: "micro",
    realism: "seeded",
    capture: { mode: "element", selector: FIXTURE_ASSISTANT_ROW },
    assert: [{ selector: FIXTURE_ASSISTANT_ROW }],
    prepare: async (page) => {
      const row = page.locator(FIXTURE_ASSISTANT_ROW).first();
      await row.hover();
      // The row is `md:opacity-0 md:group-hover:opacity-100`, so the proof that
      // the hover landed is the computed opacity, not the element's existence.
      const actions = row.locator('[aria-label="More actions"]').first();
      await expect(actions).toBeVisible();
      await expect
        .poll(async () =>
          actions.evaluate((node) => {
            const rowEl = node.closest("div");
            return rowEl ? Number(getComputedStyle(rowEl).opacity) : 0;
          }),
        )
        .toBeGreaterThan(0.9);
    },
    notes: "Real pointer hover — a programmatic event would not trigger the CSS group-hover reveal.",
  },
  {
    id: "pilot.message-actions-menu",
    group: "pilot",
    title: "Assistant reply — more-actions menu open",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    seed: { idb: ["conversation-assistant-dom"] },
    tier: "micro",
    realism: "seeded",
    assert: [{ selector: FIXTURE_ASSISTANT_ROW }],
    prepare: async (page) => {
      await page.locator(FIXTURE_ASSISTANT_ROW).first().hover();
      await openMenu(page, `${FIXTURE_ASSISTANT_ROW} [aria-label="More actions"]`);
    },
    notes: "openMenu waits for role=menu, so a menu that failed to open fails the capture.",
  },
  {
    id: "pilot.settings-account",
    group: "pilot",
    title: "Settings — account tab (signed in)",
    route: "/settings",
    search: "tab=account",
    auth: "signed-in",
    tier: "component",
    realism: "mocked",
    assert: [{ text: "Account settings" }],
    notes: "The session is a fulfilled route mock — flagged 'mocked' so no one reads it as live account data.",
  },
  {
    id: "pilot.model-selector-sheet",
    group: "pilot",
    title: "Model selector — mobile bottom sheet",
    route: "/chat",
    search: READY_CHAT_SEARCH,
    tier: "component",
    realism: "seeded",
    // The sheet only exists on the mobile layout; the desktop twin is a
    // dropdown, which is a different state and gets its own entry in W3.
    axes: { viewports: ["mobile"] },
    assert: [{ testId: "model-selector" }],
    prepare: async (page) => {
      await page.locator('[data-testid="model-selector"]').first().tap();
      await expect(page.locator('[data-testid="sheet-title"]')).toBeVisible();
    },
    notes: "Uses a real touch tap (hasTouch project), not a click, because that is what a phone sends.",
  },
];
