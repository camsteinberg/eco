// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { IDB_SEEDS, installIdbSeed, isIdbSeedName } from "./seeds/idb";
import {
  FONT_SIZE_STORAGE_VALUE,
  type CaptureContext,
  type IdbFixtureName,
  type ShotRecord,
  type StateAssertion,
  type StateEntry,
} from "./types";

/**
 * The capture runner — the one place a `StateEntry` becomes a PNG.
 *
 * Everything that makes a screenshot reproducible lives here, in a fixed order:
 * clock → media emulation → storage seeding → navigate → settle → interact →
 * shoot → record. Manifest entries declare *what* state they want; they never
 * re-implement any of the *how*.
 */

/** The moment every capture pretends it is, unless an entry says otherwise. */
const DEFAULT_CLOCK_ISO = "2026-03-17T14:32:00-04:00";

/** How long a state has to prove itself before the run fails. */
const ASSERT_TIMEOUT_MS = 10_000;

/**
 * First-run suppression bundle.
 *
 * Copied deliberately (not imported) from
 * `e2e/local-runtime-launch-confidence.spec.ts`, which is the canonical recipe
 * for "an app that has been used before". Without it, essentially every capture
 * would be a screenshot of the onboarding overlay instead of the state asked
 * for. Entries that DO want a first-run surface un-suppress the specific key
 * through `seed.removeLocal` — removals are applied last for exactly that.
 */
const ONBOARDING_SUPPRESSION_LOCAL: Record<string, string> = {
  "eco-onboarding": JSON.stringify({
    state: {
      hasCompletedOnboarding: true,
      step: "complete",
      hardwareCapability: "wasm",
      deviceMemoryGB: 16,
      recommendedModelId: "local/qwen3-0.6b",
    },
    version: 1,
  }),
  "eco-home-entry-dismissed": "true",
  "eco-tour-completed": "true",
  "eco-discovery-model-selector": "true",
  "eco-discovery-keyboard-shortcuts": "true",
  "eco-cookie-consent-dismissed": "true",
  "eco-selected-model": "eco-fast",
  "eco-selected-model-explicit": "false",
  "eco-privacy-tier": "device",
  "eco-privacy-tier-explicit": "false",
};

const ONBOARDING_SUPPRESSION_SESSION: Record<string, string> = {
  "eco-skip-sw-registration-once": "true",
};

/**
 * IndexedDB fixtures are installed by the app itself, through the harness's
 * `eco-history-fixture` seam — the lane never writes to IndexedDB directly, so
 * the seeded conversation is exactly the one the app's own installer builds
 * (`src/lib/validation-conversation-history-fixture.ts`).
 */
const IDB_FIXTURE_PARAM: Record<IdbFixtureName, string> = {
  "conversation-assistant-dom": "assistant-dom",
  "conversation-hybrid-continuation": "hybrid-continuation",
};

function isIdbFixtureName(name: string): name is IdbFixtureName {
  return Object.prototype.hasOwnProperty.call(IDB_FIXTURE_PARAM, name);
}

/**
 * The conversation the app should reopen.
 *
 * A lane-seeded conversation is written straight into IndexedDB, so nothing has
 * told the app it is the active one. Without this key the store falls back to
 * "the most recently updated conversation", which is only reliable while there
 * is exactly one — naming it explicitly keeps a seeded capture pointing at its
 * own conversation no matter what else the profile holds.
 */
const ACTIVE_CONVERSATION_KEY = "eco-active-conversation";

type InitSeedPayload = {
  local: Record<string, string>;
  session: Record<string, string>;
  removeLocal: string[];
  removeSession: string[];
};

function buildSeedPayload(entry: StateEntry, ctx: CaptureContext): InitSeedPayload {
  const local: Record<string, string> = { ...ONBOARDING_SUPPRESSION_LOCAL };

  for (const name of entry.seed?.idb ?? []) {
    if (isIdbSeedName(name)) {
      local[ACTIVE_CONVERSATION_KEY] = IDB_SEEDS[name].conversation.id;
    }
  }

  // Theme: the pre-paint script in app/layout.tsx reads these two keys before
  // React runs, so seeding them here is what makes a dark capture dark on the
  // very first painted frame rather than after a flash.
  if (ctx.theme === "system") {
    delete local["eco-theme"];
  } else {
    local["eco-theme"] = ctx.theme;
  }
  local["eco-font-size"] = FONT_SIZE_STORAGE_VALUE[ctx.fontSize];

  Object.assign(local, entry.seed?.local ?? {});

  return {
    local,
    session: { ...ONBOARDING_SUPPRESSION_SESSION, ...(entry.seed?.session ?? {}) },
    // `eco-theme` is removed rather than set for the system-theme projects, and
    // entry removals run after everything so an entry can un-suppress a banner.
    removeLocal: [
      ...(ctx.theme === "system" ? ["eco-theme"] : []),
      ...(entry.seed?.removeLocal ?? []),
    ],
    removeSession: entry.seed?.removeSession ?? [],
  };
}

function buildUrl(entry: StateEntry): string {
  const params = new URLSearchParams(entry.search ?? "");
  for (const name of entry.seed?.idb ?? []) {
    // Lane seeds are written directly (see installIdbSeeds); only the app's own
    // fixtures ride the URL.
    if (isIdbFixtureName(name)) {
      params.set("eco-history-fixture", IDB_FIXTURE_PARAM[name]);
    }
  }

  const query = params.toString();
  return query ? `${entry.route}?${query}` : entry.route;
}

/**
 * Plant any lane-seeded conversations, at document-start.
 *
 * Registered AFTER the storage seed so the ordering inside the page matches the
 * declared order (storage, then database), and before `mock` so a state that
 * needs both gets the conversation on its warm-up navigation too.
 */
async function installIdbSeeds(page: Page, entry: StateEntry): Promise<void> {
  for (const name of entry.seed?.idb ?? []) {
    if (isIdbSeedName(name)) {
      await page.addInitScript(installIdbSeed, IDB_SEEDS[name]);
    }
  }
}

function locatorFor(page: Page, assertion: StateAssertion): Locator {
  if ("testId" in assertion) {
    return page.locator(`[data-testid="${assertion.testId}"]`).first();
  }
  if ("text" in assertion) {
    return page.getByText(assertion.text, { exact: assertion.exact ?? false }).first();
  }
  if ("role" in assertion) {
    return (assertion.name === undefined
      ? page.getByRole(assertion.role)
      : page.getByRole(assertion.role, { name: assertion.name })
    ).first();
  }
  return page.locator(assertion.selector).first();
}

function describeAssertion(assertion: StateAssertion): string {
  if ("testId" in assertion) return `testId=${assertion.testId}`;
  if ("text" in assertion) return `text=${assertion.text}`;
  if ("role" in assertion) return `role=${assertion.role}${assertion.name ? ` name=${assertion.name}` : ""}`;
  return `selector=${assertion.selector}`;
}

async function runAssertions(page: Page, entry: StateEntry, phase: string): Promise<void> {
  for (const assertion of entry.assert) {
    await expect(
      locatorFor(page, assertion),
      `${entry.id} (${phase}): expected ${describeAssertion(assertion)} to be visible`,
    ).toBeVisible({ timeout: ASSERT_TIMEOUT_MS });
  }
}

/**
 * Refuse to screenshot a Next.js dev error overlay.
 *
 * A compile or runtime error paints a full-screen overlay that would otherwise
 * become a perfectly valid-looking "baseline" of a broken app. Checked BEFORE
 * the overlay host is hidden, because hiding it would hide the evidence too.
 */
async function assertNoDevErrorOverlay(page: Page, entryId: string): Promise<void> {
  const overlay = page.locator(
    "nextjs-portal [data-nextjs-dialog], nextjs-portal [data-nextjs-error-overlay], nextjs-portal [data-nextjs-call-stack]",
  );
  const count = await overlay.count();
  if (count > 0) {
    const text = (await overlay.first().innerText().catch(() => "")).slice(0, 800);
    throw new Error(
      `${entryId}: a Next.js dev error overlay is on screen — refusing to capture it.\n${text}`,
    );
  }
}

/**
 * Wait until React has actually attached to the DOM.
 *
 * `load` fires on server HTML alone, and a screenshot taken then shows a page
 * whose buttons do nothing and whose client-only regions are still empty. The
 * React fiber/container key is the cheapest true signal that hydration ran, and
 * it works on every route (content pages included) without an app-side marker.
 */
async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const isHydrated = (node: object): boolean =>
        Object.keys(node).some(
          (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$"),
        );

      if (isHydrated(document)) return true;
      return Array.from(document.body.children).some((child) => isHydrated(child));
    },
    undefined,
    { timeout: 15_000 },
  );
}

/**
 * Bring the page to a state worth photographing, or fail.
 *
 * Order matters: the error-overlay check runs first (nothing else is
 * meaningful if the app is broken), the overlay host is hidden only after that,
 * and the entry's own assertions run last — they are the definition of "this
 * really is the state we asked for".
 */
async function settle(page: Page, entry: StateEntry): Promise<void> {
  await assertNoDevErrorOverlay(page, entry.id);

  // The dev-tools indicator and any future dev chrome live in <nextjs-portal>.
  // It is not part of the product, so it never belongs in a baseline.
  await page.addStyleTag({
    content: "nextjs-portal { display: none !important; }",
  });

  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (entry.hydrates !== false) {
    await waitForHydration(page);
  }
  await runAssertions(page, entry, "settle");

  // Best-effort: quiet network makes late-arriving images deterministic, but a
  // page with a long-lived connection (or a dev-server HMR socket) never goes
  // idle and that is not a reason to fail a capture.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);

  const bodyLength = await page.evaluate(() => document.body.innerText.trim().length);
  if (bodyLength === 0) {
    throw new Error(`${entry.id}: page body rendered no text — refusing to capture a blank frame`);
  }
}

/**
 * Where a shot lives inside the run directory.
 *
 * Shared with `global-setup.ts` (which writes the expected-shot list) and the
 * coverage script, so "where did it go" and "where should it be" can never
 * drift apart.
 */
export function shotRelativePath(entryId: string, project: string): string {
  return `shots/${project}/${entryId}.png`;
}

function shotPathFor(entry: StateEntry, ctx: CaptureContext): string {
  return join(ctx.outputRoot, shotRelativePath(entry.id, ctx.project));
}

function recordShot(entry: StateEntry, ctx: CaptureContext, path: string): void {
  const bytes = statSync(path).size;
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const record: ShotRecord = {
    id: entry.id,
    title: entry.title,
    path,
    project: ctx.project,
    viewport: ctx.viewport,
    theme: ctx.theme,
    colorScheme: ctx.colorScheme,
    motion: ctx.motion,
    fontSize: ctx.fontSize,
    tier: entry.tier,
    realism: entry.realism,
    route: entry.route,
    asserts: entry.assert.map(describeAssertion),
    server: entry.server ?? "any",
    ...(entry.notes === undefined ? {} : { notes: entry.notes }),
    bytes,
    sha256,
  };

  appendFileSync(
    join(ctx.outputRoot, `.shots-${String(process.pid)}.jsonl`),
    `${JSON.stringify(record)}\n`,
  );
}

/** Capture one manifest state in one rendering context. */
export async function captureState(
  page: Page,
  entry: StateEntry,
  ctx: CaptureContext,
  testInfo: TestInfo,
): Promise<void> {
  const clock = entry.clock ?? { mode: "fixed" as const };
  const time = new Date(clock.timeISO ?? DEFAULT_CLOCK_ISO);

  if (clock.mode === "paused") {
    // install() also freezes timers and rAF, which parks progress animations
    // and typewriter effects exactly where advanceMs leaves them.
    await page.clock.install({ time });
  } else {
    await page.clock.setFixedTime(time);
  }

  await page.emulateMedia({
    colorScheme: ctx.colorScheme,
    reducedMotion: ctx.motion,
  });

  // Hide the capture machine's own battery.
  //
  // `useBatteryAwareness` reads the real Battery Status API, and below 30% on a
  // discharging laptop the app shows a "Low battery mode" notice above the
  // composer. That notice then appears in EVERY chat capture, depending on
  // nothing but how charged the machine happened to be — it made two unrelated
  // states come out byte-identical on 2026-08-18 and would make a run
  // unreproducible on any other laptop. Removing the API is the app's own
  // "battery unavailable" path (`computeRestriction(null)` → no restriction), so
  // this reads as a desktop on mains rather than as a special case. The forced
  // battery states are unaffected: the harness override is consulted first and
  // returns before this check.
  await page.addInitScript(() => {
    // The property lives on the prototype, and `'getBattery' in navigator`
    // walks the chain — so deleting it from the instance would change nothing.
    Reflect.deleteProperty(Navigator.prototype, "getBattery");
  });

  const seed = buildSeedPayload(entry, ctx);
  await page.addInitScript((payload: InitSeedPayload) => {
    try {
      for (const [key, value] of Object.entries(payload.local)) {
        window.localStorage.setItem(key, value);
      }
      for (const [key, value] of Object.entries(payload.session)) {
        window.sessionStorage.setItem(key, value);
      }
      for (const key of payload.removeLocal) {
        window.localStorage.removeItem(key);
      }
      for (const key of payload.removeSession) {
        window.sessionStorage.removeItem(key);
      }
    } catch {
      // Storage can be unavailable in locked-down contexts; the assertions
      // below will fail loudly if the missing seed actually mattered.
    }
  }, seed);

  await installIdbSeeds(page, entry);

  // Before the first navigation: anything a route fetches on mount has already
  // fired by the time `prepare` runs.
  if (entry.mock) {
    await entry.mock(page, ctx);
  }

  await page.goto(buildUrl(entry));
  await settle(page, entry);

  if (clock.mode === "paused" && clock.advanceMs !== undefined) {
    await page.clock.runFor(clock.advanceMs);
  }

  if (entry.prepare) {
    await entry.prepare(page, ctx);
    // The interaction changed the page; the state contract must still hold.
    await runAssertions(page, entry, "after prepare");
  }

  const mode = entry.capture?.mode ?? "viewport";
  const options = { animations: "disabled" as const, caret: "hide" as const, scale: "css" as const };

  if (process.env.ECO_CAPTURE_MODE === "baseline") {
    // Comparison mode: assert against committed baselines instead of writing
    // into the artifact tree, so the same manifest doubles as a regression gate.
    const name = `${entry.id}.png`;
    if (mode === "element") {
      await expect(page.locator(entry.capture?.selector ?? "body").first()).toHaveScreenshot(name, options);
    } else {
      await expect(page).toHaveScreenshot(name, { ...options, fullPage: mode === "fullPage" });
    }
    return;
  }

  const path = shotPathFor(entry, ctx);
  mkdirSync(dirname(path), { recursive: true });

  if (mode === "element") {
    await page.locator(entry.capture?.selector ?? "body").first().screenshot({ path, ...options });
  } else {
    await page.screenshot({ path, fullPage: mode === "fullPage", ...options });
  }

  recordShot(entry, ctx, path);
  await testInfo.attach(entry.id, { path, contentType: "image/png" });
}

/**
 * Drive real keyboard focus to an element.
 *
 * `element.focus()` sets `:focus` but NOT `:focus-visible` — the ring the
 * design actually ships is keyboard-only, so a programmatic focus would
 * screenshot a state users never see. Tabbing is the only honest way in.
 */
export async function focusVisibleState(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector).first();
  await expect(target).toBeVisible({ timeout: ASSERT_TIMEOUT_MS });

  await page.evaluate(() => {
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();
  });

  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press("Tab");
    const focused = await target.evaluate((node) => node === document.activeElement);
    if (focused) {
      await page.evaluate(() => {
        document.body.removeAttribute("tabindex");
      });
      return;
    }
  }

  throw new Error(
    `focusVisibleState: "${selector}" was not reachable within 40 Tab presses. `
      + "Either it is not keyboard-focusable (a real accessibility finding) or it sits behind a focus trap.",
  );
}

/**
 * Wait until a Motion animation has actually come to rest.
 *
 * `animations: 'disabled'` fast-forwards CSS animations and does NOTHING to a
 * Motion spring — the app's entrances are springs, so a state photographed the
 * moment its text becomes *visible* is caught mid-flight and comes out a few
 * percent of scale different every run. Playwright's visibility check is about
 * layout, not opacity, so `toBeVisible()` is not the signal it looks like.
 *
 * Two identical consecutive reads is the only settle signal that does not guess
 * at a duration. Found the hard way twice: W6 needed it to stop reduced-motion
 * twins differing by settle noise instead of by the branch it was measuring, and
 * `setup-gate.setup-reassurance-first` was byte-unstable across runs until it
 * used this (its sibling `-second` was stable only because a 9s rotation wait
 * happened to outlast the spring).
 */
export async function motionSettled(page: Page, selector: string): Promise<void> {
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

/** Click a menu trigger and wait for its menu to actually be open. */
export async function openMenu(page: Page, triggerSelector: string): Promise<Locator> {
  const trigger = page.locator(triggerSelector).first();
  await expect(trigger).toBeVisible({ timeout: ASSERT_TIMEOUT_MS });
  await trigger.click();

  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible({ timeout: ASSERT_TIMEOUT_MS });
  return menu;
}

const TIER_VIEWPORTS: Record<StateEntry["tier"], readonly CaptureContext["viewport"][]> = {
  page: ["mobile", "tablet", "desktop"],
  component: ["mobile", "desktop"],
  micro: ["desktop"],
};

/**
 * The ONE place tier becomes an axis expansion.
 *
 * A Playwright project is one point on the grid; this decides whether a given
 * entry belongs at that point. Motion and font-size projects are opt-in only:
 * re-shooting all ~280 states at every font size would bury the handful of
 * states where the axis actually changes anything.
 */
export function entryRunsInContext(entry: StateEntry, ctx: CaptureContext): boolean {
  const tierFilter = process.env.ECO_CAPTURE_TIER;
  if (tierFilter && !tierFilter.split(",").map((tier) => tier.trim()).includes(entry.tier)) {
    return false;
  }

  // A prod-only state does not exist on the dev server, so it is not "missing"
  // from a dev run — it never belonged to it.
  if (entry.server === "prod" && process.env.ECO_CAPTURE_SERVER !== "prod") {
    return false;
  }

  const viewports = entry.axes?.viewports ?? TIER_VIEWPORTS[entry.tier];
  if (!viewports.includes(ctx.viewport)) return false;

  const themes = entry.axes?.themes ?? (["light", "dark"] as const);
  if (!themes.includes(ctx.theme)) return false;

  const motions = entry.axes?.motion ?? (["no-preference"] as const);
  if (!motions.includes(ctx.motion)) return false;

  const fontSizes = entry.axes?.fontSize ?? (["default"] as const);
  return fontSizes.includes(ctx.fontSize);
}
