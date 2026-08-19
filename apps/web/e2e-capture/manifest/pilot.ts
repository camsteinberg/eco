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
export const READY_SLOT_SEARCH = [
  "eco-validation-slot-eco-fast=local/qwen3-0.6b",
  "eco-validation-slot-status-eco-fast=ready",
  "eco-validation-selected-model=eco-fast",
  "eco-force-cache-verified=1",
].join("&");

/** Force a predictable device so recommendation never varies by host hardware. */
export const DESKTOP_DEVICE_SEARCH = [
  "eco-force-capability=webgpu",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=16",
  "eco-force-opfs=true",
].join("&");

export const READY_CHAT_SEARCH = `${READY_SLOT_SEARCH}&${DESKTOP_DEVICE_SEARCH}`;

/**
 * A CPU-only desktop. Used by the states that reach the real download path,
 * where the plan size decides whether a forced failure survives the storage
 * preflight — see `pilot.setup-error-storage` for the measurement.
 */
export const WASM_DEVICE_SEARCH = [
  "eco-force-capability=wasm",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=8",
  "eco-force-opfs=true",
].join("&");

/**
 * Storage that keeps the model-upgrade offer off a chat capture.
 *
 * On the forced desktop profile the upgrade machine offers LFM2-2.6B a few
 * seconds after the chat mounts, and its floating card lands over whatever the
 * shot was meant to show (it contaminated `pilot.chat-empty-ready`). A settled
 * cycle for the same target suppresses the offer — `planUpgradeOffer` returns
 * null the moment a record names the target in any phase but `offered` — and
 * "declined" is the honest one to seed: it is exactly the state of a person who
 * has already said no thanks.
 *
 * The target id is not guessed. `recommend('eco-smart', profile)` resolves to
 * `candidate/lfm2-2.6b-onnx` for `DESKTOP_DEVICE_SEARCH`, confirmed on
 * 2026-08-18 by reading the record the app itself wrote after an unsuppressed
 * load. If the recommendation ever moves, the card reappears in the captures —
 * visible in review rather than silently wrong.
 */
export const UPGRADE_DECLINED_LOCAL: Record<string, string> = {
  "eco-local-ai-upgrade-v1": JSON.stringify({
    version: 1,
    phase: "declined",
    targetModelId: "candidate/lfm2-2.6b-onnx",
    baseModelId: "local/qwen3-0.6b",
    deferral: null,
    swapAttempts: 0,
    updatedAt: 0,
  }),
};

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
    // A WASM device, not the shared desktop one, because of a measured race.
    //
    // `downloadByPlan` runs a REAL storage-headroom preflight immediately BEFORE
    // the harness's forced-failure seam, and it raises the same
    // `InsufficientStorageError` — it just words it differently. It declines
    // when free space is under `plan × 1.1`, and a Playwright origin reports
    // only about 0.9–1.1 GB free. W2 hit the consequence first; measured here on
    // 2026-08-19, two fresh contexts per profile:
    //
    //   webgpu / chromium / desktop  → plan 0.8 GB, threshold 0.88, free 0.9–1.1
    //   wasm   / chromium / desktop  → plan 0.5 GB, threshold 0.55, free 0.9–1.1
    //
    // The WebGPU profile sits ON its threshold, so the preflight pre-empts the
    // forced failure at random. The WASM profile clears it by roughly 1.7×.
    //
    // Note what does NOT work, since it is the obvious thing to reach for: the
    // download target is the DEVICE'S recommendation, so binding a small model
    // to the slot does not shrink the plan. Binding a 350M through
    // `eco-validation-slot-*` left the plan at 0.8 GB and made the preflight win
    // outright; only the profile moves it.
    search: `eco-force-download=quota&${WASM_DEVICE_SEARCH}`,
    seed: {
      // Load-bearing, and measured: with these keys removed the gate stops at
      // the first-run choice and no storage copy renders at all. They no longer
      // confer readiness (see READY_SLOT_SEARCH), but they are still what steers
      // the gate into the resume/download path where the forced failure lands.
      local: {
        "eco-local-ai-slot-eco-fast": "local/qwen3-0.6b",
        "eco-local-ai-slot-status-eco-fast": "ready",
      },
    },
    tier: "page",
    realism: "seeded",
    // The headline alone is NOT enough: the real preflight and the forced quota
    // seam share it. They differ in the subtitle, which quotes the error
    // verbatim — the preflight names both figures ("…only about X GB is
    // available on this device"), the quota seam names one. Asserting the
    // quota-only sentence makes a preflight pre-emption fail the run instead of
    // passing quietly as the wrong state.
    assert: [
      { text: "Eco needs a little more free space" },
      { text: "Eco ran out of free space while setting up this model" },
    ],
    notes:
      "Forced through eco-force-download=quota; the storage headline is the honest copy for it. "
      + "Runs on a CPU device so the download plan stays well clear of the real storage "
      + "preflight, which would otherwise pre-empt the forced failure at random.",
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
