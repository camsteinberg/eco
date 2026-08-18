// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect } from "@playwright/test";
import type { StateEntry } from "../types";

/**
 * The /chat setup gate — every surface a person can meet before the chat.
 *
 * `LocalAiSetupGate` renders one of four surfaces depending on where the setup
 * runner got to: the first-run `WelcomeCard`, the `WelcomeSetup` wait, the
 * `SetupErrorState`, or the `BelowFloorScreen`. Which one a device gets is
 * decided by real recommendation logic, so every entry here forces a device
 * (capability / browser / platform / memory) rather than describing a surface —
 * the copy differences between them ARE the product decision being reviewed.
 *
 * Two things were established empirically against the running dev:validation
 * server on 2026-08-18 and are load-bearing for this file:
 *
 * 1. Weights are fetched same-origin through `/api/local-models/…`, so any state
 *    that reaches the download path would really download a model. The lane
 *    holds those requests open (see `installRouteMocks` in fixtures.ts), which
 *    is what pins every WelcomeSetup capture at percent 0 instead of a
 *    different number every run.
 * 2. The slot harness params (`eco-validation-slot-status-eco-fast=preparing` /
 *    `=error`) are the reliable way into the resume and prior-attempt-failed
 *    surfaces. They do not need the legacy localStorage keys or a cache
 *    reconcile flip to get there.
 */

/** Forced devices. Each one is a real population, not a knob combination. */

/** Chromium + WebGPU + 16 GB — the only class that gets a genuine fast/deep pair. */
const DESKTOP_WEBGPU = [
  "eco-force-capability=webgpu",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=16",
  "eco-force-opfs=true",
].join("&");

/** No WebGPU at all: the CPU/WASM pair shipped in #175 (Eco Tiny + Eco Basic). */
const CPU_ONLY = [
  "eco-force-capability=wasm",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=16",
  "eco-force-opfs=true",
].join("&");

/**
 * The 4–7 GB WebGPU band (#176). eco-smart floors BELOW the everyday pick here,
 * so the size-step-up guard in `deriveFirstRunChoices` collapses the offer to
 * one tile — this is the single-option card most real mid-range laptops see.
 */
const MID_MEMORY_WEBGPU = [
  "eco-force-capability=webgpu",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=6",
  "eco-force-opfs=true",
].join("&");

/** Firefox/Safari/unknown UA: only the browser-agnostic floor tier is assignable. */
const UNVALIDATED_BROWSER = [
  "eco-force-capability=webgpu",
  "eco-force-browser=firefox",
  "eco-force-platform=desktop",
  "eco-force-device-memory=16",
  "eco-force-opfs=true",
].join("&");

/** 3 GB with WebGPU — above the floor, but only the smallest model fits. */
const LOW_MEMORY_WEBGPU = [
  "eco-force-capability=webgpu",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=3",
  "eco-force-opfs=true",
].join("&");

/**
 * 3 GB and no WebGPU: exactly one model is assignable, which is what makes the
 * fallback ladder one rung long and the exhausted copy drop its plural.
 */
const CPU_LOW_MEMORY = [
  "eco-force-capability=wasm",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=3",
].join("&");

/** Neither WebGPU nor a viable WASM tier → below floor, blamed on the browser. */
const NO_RUNTIME = [
  "eco-force-capability=unsupported",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=16",
].join("&");

/**
 * 2 GB with a working runtime. Verified: 3 GB still has an assignable model
 * (the card renders), 2 GB has none — `recommend` throws NoAssignableModelError,
 * which routes to below-floor, and `deriveBelowFloorReason` blames memory
 * rather than the browser because the runtime is fine.
 */
const BELOW_MEMORY_FLOOR = [
  "eco-force-capability=webgpu",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=2",
].join("&");

/**
 * iOS WebKit. `deriveBelowFloorReason` checks WebKit-mobile FIRST, so this is
 * the handoff surface even though the runtime is what is actually missing.
 */
const IOS_WEBKIT = [
  "eco-force-capability=unsupported",
  "eco-force-browser=safari",
  "eco-force-platform=mobile",
  "eco-force-device-memory=8",
].join("&");

/**
 * Bound models for the entries that reach the download path.
 *
 * `downloadByPlan` runs a REAL storage-headroom preflight
 * (`assertStorageHeadroom`) immediately before the harness's forced-failure
 * seam, and it throws the same `InsufficientStorageError` the seam does. A
 * Playwright profile reports an origin quota of roughly 0.9–1.1 GB (measured
 * 2026-08-18: 0.87, 0.87, 1.09, 1.14 GB across four fresh contexts), and the
 * preflight trips when the available budget is under `remaining × 1.1`.
 * Qwen3-0.6B's plan is ~0.79 GB, so its threshold (~0.87 GB) sits exactly on
 * that boundary — it pre-empts the forced failure on roughly one project per
 * run, at random, and renders the real storage error instead of the state the
 * entry asked for.
 *
 * So every entry here binds a 350M-class model: ~0.3–0.5 GB of plan bytes, a
 * threshold far under the smallest quota ever observed. This is about the test
 * profile, not the product — a real device has orders of magnitude more room.
 */
const SMALL_WEBGPU_MODEL = "candidate/lfm2.5-350m-onnx";
const SMALL_CPU_MODEL = "candidate/smollm2-360m-instruct-onnx";

/** A bound-but-unfinished pick: the runner resumes it and softens the copy. */
function resumingSlot(modelId: string): string {
  return `eco-validation-slot-eco-fast=${modelId}&eco-validation-slot-status-eco-fast=preparing`;
}

/** A pick whose last attempt ended in error: the runner remembers it out loud. */
function failedSlot(modelId: string): string {
  return `eco-validation-slot-eco-fast=${modelId}&eco-validation-slot-status-eco-fast=error`;
}

/** Indices 0 and 1 of REASSURANCE_COPY (WelcomeSetup.tsx) — unit-test-locked. */
const REASSURANCE_FIRST = "Your conversations run on your device.";
const REASSURANCE_SECOND = "Eco is open source — your AI, your trust.";
/** REASSURANCE_INTERVAL_MS in useEcoSetup.ts, plus room for the 0.4s crossfade. */
const REASSURANCE_ROTATION_MS = 9_000;

/** Either gate surface a choice-then-wait entry passes through. */
const GATE_SURFACE = "[data-eco-welcome-card], [data-eco-setup-surface]";

export const setupGateStates: StateEntry[] = [
  // ── WelcomeCard — the first-run model choice ────────────────────────────
  {
    id: "setup-gate.welcome-two-tile-selected",
    group: "setup-gate",
    title: "Welcome — the deeper model tile selected",
    route: "/chat",
    search: DESKTOP_WEBGPU,
    seed: { removeLocal: ["eco-onboarding"] },
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "Pick the model that fits your device" }],
    prepare: async (page) => {
      // The recommended (fast) tile is preselected, so the selection ring on the
      // second tile only exists after a real click. The CTA renaming itself is
      // the proof the choice actually took.
      const deeper = page.getByRole("radio").nth(1);
      await deeper.click();
      await expect(deeper).toHaveAttribute("aria-checked", "true");
      await expect(page.getByRole("button", { name: /Start with Eco Deeper/ })).toBeVisible();
    },
    notes: "Companion to pilot.welcome-first-run, which shows the same card with the recommended tile selected.",
  },
  {
    id: "setup-gate.welcome-cpu-pair",
    group: "setup-gate",
    title: "Welcome — the CPU-only pair (Eco Tiny / Eco Basic)",
    route: "/chat",
    search: CPU_ONLY,
    seed: { removeLocal: ["eco-onboarding"] },
    tier: "page",
    realism: "seeded",
    assert: [
      { text: "Pick the model that fits your device" },
      { text: "Eco Tiny" },
    ],
    notes: "A device with no WebGPU still gets a real choice of two (#175); the models are smaller than the WebGPU pair.",
  },
  {
    id: "setup-gate.welcome-single-mid-memory",
    group: "setup-gate",
    title: "Welcome — one option on a 4–7 GB WebGPU device",
    route: "/chat",
    search: MID_MEMORY_WEBGPU,
    seed: { removeLocal: ["eco-onboarding"] },
    tier: "page",
    realism: "seeded",
    assert: [{ text: "Chosen for your device." }, { text: "Eco Fast" }],
    notes: "The single-option layout: no radiogroup, no Recommended badge, and 'Your model' instead of a choice.",
  },
  {
    id: "setup-gate.welcome-single-unvalidated-browser",
    group: "setup-gate",
    title: "Welcome — one option on Firefox",
    route: "/chat",
    search: UNVALIDATED_BROWSER,
    seed: { removeLocal: ["eco-onboarding"] },
    tier: "page",
    realism: "seeded",
    assert: [{ text: "Chosen for your device." }, { text: "Eco Compact" }],
    notes: "Same single-option layout, different model: the premium tier is Chromium-validated, so Firefox gets the floor tier.",
  },
  {
    id: "setup-gate.welcome-single-low-memory",
    group: "setup-gate",
    title: "Welcome — one option on a 3 GB device",
    route: "/chat",
    search: LOW_MEMORY_WEBGPU,
    seed: { removeLocal: ["eco-onboarding"] },
    tier: "page",
    realism: "seeded",
    assert: [{ text: "Chosen for your device." }, { text: "Eco Light" }],
    notes: "The last rung above the memory floor — 3 GB still gets a model, 2 GB gets the below-floor screen.",
  },

  // ── WelcomeSetup — the wait ─────────────────────────────────────────────
  {
    id: "setup-gate.setup-resuming",
    group: "setup-gate",
    title: "Setup — finishing an interrupted download",
    route: "/chat",
    search: `${resumingSlot(SMALL_WEBGPU_MODEL)}&${LOW_MEMORY_WEBGPU}`,
    tier: "page",
    realism: "seeded",
    assert: [{ text: "Finishing your model download…" }],
    notes: "A slot left 'preparing' resumes that exact model, so the copy frames the wait as finishing, not starting. The 350M is this device's own pick and keeps the run clear of the storage-preflight boundary.",
  },
  {
    id: "setup-gate.setup-prior-attempt-failed",
    group: "setup-gate",
    title: "Setup — after a failed prior attempt",
    route: "/chat",
    search: `${failedSlot(SMALL_WEBGPU_MODEL)}&${LOW_MEMORY_WEBGPU}`,
    tier: "page",
    realism: "seeded",
    assert: [
      { text: "Getting your private AI ready" },
      { text: "Last time got interrupted" },
    ],
    notes: "The system shows memory of the last attempt instead of silently retrying. Also the standard <45% status line.",
  },
  {
    id: "setup-gate.setup-lightweight-device",
    group: "setup-gate",
    title: "Setup — the lighter-model expectation on a CPU-only device",
    route: "/chat",
    search: `${failedSlot(SMALL_CPU_MODEL)}&${CPU_ONLY}`,
    tier: "page",
    realism: "seeded",
    assert: [{ text: "Setting up a lighter AI that runs smoothly on this device" }],
    notes: "The only seam into the non-resuming setup surface is a failed prior slot, so the prior-attempt note rides along.",
  },
  {
    id: "setup-gate.setup-reassurance-first",
    group: "setup-gate",
    title: "Setup — reassurance line 1 (just after choosing)",
    route: "/chat",
    // The one-tile device deliberately: committing the choice on the two-tile
    // card binds the 0.76 GB model, whose preflight threshold sits on the test
    // profile's quota boundary (see SMALL_WEBGPU_MODEL).
    search: LOW_MEMORY_WEBGPU,
    seed: { removeLocal: ["eco-onboarding"] },
    tier: "micro",
    realism: "seeded",
    assert: [{ selector: GATE_SURFACE }],
    prepare: async (page) => {
      await page.getByRole("button", { name: /^Start with/ }).click();
      await expect(page.locator("[data-eco-setup-surface]")).toBeVisible();
      await expect(page.getByText(REASSURANCE_FIRST)).toBeVisible();
    },
    notes: "Committing the choice is the only way to 'setting-up' without a live download; the rotation starts here.",
  },
  {
    id: "setup-gate.setup-reassurance-second",
    group: "setup-gate",
    title: "Setup — reassurance line 2 (one rotation later)",
    route: "/chat",
    search: LOW_MEMORY_WEBGPU,
    seed: { removeLocal: ["eco-onboarding"] },
    tier: "micro",
    realism: "seeded",
    assert: [{ selector: GATE_SURFACE }],
    prepare: async (page) => {
      await page.getByRole("button", { name: /^Start with/ }).click();
      await expect(page.locator("[data-eco-setup-surface]")).toBeVisible();
      // Real timers, not a paused clock: under `clock.install` the rotation
      // fires but the crossfade never finishes, leaving both lines on screen.
      await page.waitForTimeout(REASSURANCE_ROTATION_MS);
      await expect(page.getByText(REASSURANCE_SECOND)).toBeVisible();
      await expect(page.getByText(REASSURANCE_FIRST)).toHaveCount(0);
    },
    notes: "Proves the rotation renders one line at a time — indices 0 and 1 are the load-bearing first impression.",
  },

  // ── SetupErrorState ─────────────────────────────────────────────────────
  {
    id: "setup-gate.error-insufficient-space",
    group: "setup-gate",
    title: "Setup error — not enough free space (with figures)",
    route: "/chat",
    search: `eco-force-download=storage&${resumingSlot(SMALL_CPU_MODEL)}&${CPU_LOW_MEMORY}`,
    tier: "page",
    realism: "seeded",
    assert: [
      { text: "Eco needs a little more free space" },
      { text: "is available on this device" },
    ],
    notes: "The storage headline overrides the exhausted copy. Differs from pilot.setup-error-storage (quota) in the subtitle — this one names both figures — and binds a 350M model so the real preflight can never pre-empt the forced failure and make the two identical.",
  },
  {
    id: "setup-gate.error-exhausted-multi-model",
    group: "setup-gate",
    title: "Setup error — every option tried",
    route: "/chat",
    search: `eco-force-download=cache&${resumingSlot(SMALL_CPU_MODEL)}&${CPU_ONLY}`,
    tier: "page",
    realism: "seeded",
    assert: [{ text: "We tried a few options" }],
    notes: "eco-force-download=cache, opfs and hosting all land here: the cascade replaces the failure reason with its own exhausted copy, so the three render identically.",
  },
  {
    id: "setup-gate.error-exhausted-one-model",
    group: "setup-gate",
    title: "Setup error — a one-model device",
    route: "/chat",
    search: `eco-force-download=cache&${resumingSlot(SMALL_CPU_MODEL)}&${CPU_LOW_MEMORY}`,
    tier: "page",
    realism: "seeded",
    assert: [{ text: "We couldn't get Eco's model running on this device just yet." }],
    notes: "The ladder is one model long here, so the copy drops the 'we tried a few options' claim it would not have earned.",
  },
  {
    id: "setup-gate.error-copied",
    group: "setup-gate",
    title: "Setup error — 'Copied' confirmation",
    route: "/chat",
    search: `eco-force-download=cache&${resumingSlot(SMALL_CPU_MODEL)}&${CPU_ONLY}`,
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "We tried a few options" }],
    prepare: async (page) => {
      // The label only flips if the clipboard write really succeeds, and a
      // headless context denies it by default.
      await page.context().grantPermissions(["clipboard-write"]);
      await page.getByRole("button", { name: "Copy what happened" }).click();
      await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    },
    notes: "The 2-second confirmation on the diagnostics copy. The payload never leaves the device.",
  },

  // ── BelowFloorScreen ────────────────────────────────────────────────────
  {
    id: "setup-gate.below-floor-runtime",
    group: "setup-gate",
    title: "Below floor — the browser can't run it",
    route: "/chat",
    search: NO_RUNTIME,
    tier: "page",
    realism: "seeded",
    assert: [{ text: "We're working with browser vendors to change it." }],
    notes: "No WebGPU and no viable WASM tier. Memory is irrelevant here — the runtime verdict is checked first.",
  },
  {
    id: "setup-gate.below-floor-memory",
    group: "setup-gate",
    title: "Below floor — not enough memory",
    route: "/chat",
    search: BELOW_MEMORY_FLOOR,
    tier: "page",
    realism: "seeded",
    assert: [{ text: "have enough memory for it to run well" }],
    notes: "A capable browser on a 2 GB device: the copy blames memory, never the browser, and offers the lighter-models note.",
  },
  {
    id: "setup-gate.below-floor-mobile-copy-link",
    group: "setup-gate",
    title: "Below floor — iOS handoff, no Web Share",
    route: "/chat",
    search: IOS_WEBKIT,
    tier: "page",
    realism: "seeded",
    assert: [
      { text: "Eco does run on iPhone and iPad" },
      { role: "button", name: "Copy link" },
    ],
    notes: "The designed iOS handoff. Without navigator.share the primary action falls back to copying the link.",
  },
  {
    id: "setup-gate.below-floor-mobile-web-share",
    group: "setup-gate",
    title: "Below floor — iOS handoff with Web Share",
    route: "/chat",
    search: IOS_WEBKIT,
    tier: "component",
    realism: "seeded",
    assert: [{ text: "Eco does run on iPhone and iPad" }],
    prepare: async (page) => {
      // MobileHandoff reads navigator.share in a useState initializer, so it has
      // to exist before the surface mounts — defining it now would change
      // nothing. Install it and reload rather than fake the button.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "share", {
          value: () => Promise.resolve(),
          configurable: true,
        });
      });
      await page.reload();
      // The reload throws away the style tag the runner injects during settle,
      // which is what keeps the Next.js dev indicator out of the frame.
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await expect(page.getByRole("button", { name: "Send Eco to your computer" })).toBeVisible();
    },
    notes: "What a real iPhone shows: the system share sheet is the fastest way to move to a computer.",
  },
  {
    id: "setup-gate.below-floor-link-copied",
    group: "setup-gate",
    title: "Below floor — 'Link copied' confirmation",
    route: "/chat",
    search: IOS_WEBKIT,
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "Eco does run on iPhone and iPad" }],
    prepare: async (page) => {
      await page.context().grantPermissions(["clipboard-write"]);
      await page.getByRole("button", { name: "Copy link" }).click();
      await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
    },
    notes: "The confirmed state of the fallback handoff — it reverts after 2.4 seconds.",
  },
  {
    id: "setup-gate.below-floor-disclosure-open",
    group: "setup-gate",
    title: "Below floor — 'What works today' open",
    route: "/chat",
    search: NO_RUNTIME,
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "What works today" }],
    prepare: async (page) => {
      await page.getByRole("button", { name: /What works today/ }).click();
      await expect(page.getByText("Eco runs today on:")).toBeVisible();
    },
    notes: "The one place the product says out loud which browsers do work. The assertion holds open or closed — the toggle keeps the same words.",
  },
];
