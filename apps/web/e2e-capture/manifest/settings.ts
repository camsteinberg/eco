// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, type Page } from "@playwright/test";
import type { CaptureGap, StateEntry } from "../types";

/**
 * W5 — the states INSIDE the settings tabs.
 *
 * W1 photographs every tab's default (member and guest) and the two billing
 * return banners; the pilot owns the signed-in account default. This wave is
 * everything a person can make those tabs do once they are there: the Eco tab
 * with and without a model, the storage panel's four outcomes, the eight
 * surfaces of the Switch-your-AI dialog, the account form's dirty / saved /
 * failed / confirming states, an honest Supporter account, and the appearance
 * controls in their non-default positions.
 *
 * Everything below was reached against the running dev:validation server on
 * 2026-08-18 before it was written down. Four findings are load-bearing:
 *
 * 1. **Switching tabs in-app drops the harness query string.** `SettingsTabs`
 *    navigates with `buildSettingsHref(tab)`, which is a clean `?tab=…` — so a
 *    `prepare` that hops to Appearance and back loses the forced device AND the
 *    seeded slot, and the Eco tab re-renders as "not set up". Any state needing
 *    a *setting* changed plus a *forced device* has to persist the setting
 *    first and arrive on the target tab by URL (see `technicalDetailsOn`).
 * 2. **The settings store is encrypted IndexedDB** (`eco-settings`, nacl
 *    secretbox keyed from localStorage), so there is no seedable plaintext row.
 *    The honest way in is the app's own switch, flipped on a warm-up
 *    navigation — which is what `technicalDetailsOn` does.
 * 3. **The storage panel reads real Cache Storage** through the shipping cache
 *    format (`eco-local-ai-<sanitised id>` + the `x-eco-cache-size-bytes`
 *    stamp). Writing that format on a warm-up navigation gives a truthful
 *    per-model breakdown without downloading gigabytes. Seeded models must NOT
 *    be the slot's bound model: an entry seeded for the bound model is gone by
 *    the time the panel renders (observed), while unbound models survive.
 * 4. **'Busy' is a localStorage lease, not a network state.** A live
 *    `eco-local-heavy-work-owner-v1` row — exactly what another tab's readiness
 *    check writes — makes `acquireLease('switch-model')` fail, which is the only
 *    honest way to reach BusyNotice and, three seconds earlier, RetryingNotice.
 *
 * ── Deliberately NOT captured ─────────────────────────────────────────────
 *
 * - **The dialog's smoke-failure copy** (`smokeFailedHeadline`, both confidence
 *   variants). Reaching it means a model that downloads and loads and then
 *   fails its readiness check; `eco-force-download` fails before the load and
 *   `eco-force-local-runtime=crash` fails at it, so both land on the
 *   load-failed headline instead. Nothing forces a smoke failure, and faking
 *   one would mean editing `src/`.
 * - **`SettingsEcoTab`'s legacy single-line storage summary** and its
 *   "Yes, clear <model>" confirm. `LocalAiSettingsAdapter` always passes a
 *   breakdown, so the branch cannot render in the shipping app — it is dead
 *   code behind a prop, not a state a person can meet.
 * - **The `saving` disabled beat** of the account form (`Saving…`) and the
 *   delete-in-progress dialog copy. Both live between a click and a fulfilled
 *   route mock; holding the response open would park them, but the pair is two
 *   words of button copy inside states already captured.
 */

/** Forced devices. Same recipes as `setup-gate.ts`, kept local because that
 *  file exports none of them; each names a real population, not a knob soup. */

/** No WebGPU, plenty of memory: the CPU/WASM band, and the richest Switch list
 *  that does not include the duplicate-named 1.2B pair. */
const CPU_DEVICE = [
  "eco-force-capability=wasm",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=16",
  "eco-force-opfs=true",
].join("&");

/** 2 GB: `canServe` is false, so `useSwitchAI` offers nothing at all. The slot
 *  still holds its model, which is the point — this is a device that lost its
 *  headroom, not a device that never had a model. */
const BELOW_FLOOR_DEVICE = [
  "eco-force-capability=webgpu",
  "eco-force-browser=chromium",
  "eco-force-platform=desktop",
  "eco-force-device-memory=2",
].join("&");

/**
 * The bound model for every Eco-tab state: 0.28 GB of plan bytes.
 *
 * The Switch dialog's Save runs the same real storage preflight the setup gate
 * does, and a Playwright profile reports roughly 0.9–1.1 GB of origin quota, so
 * anything near 0.8 GB trips the preflight at random and renders a storage
 * error instead of the state asked for (see setup-gate.ts). Everything this
 * wave downloads is 350M-class.
 */
const BOUND_MODEL = "candidate/lfm2.5-350m-onnx";

/** The row a switch entry picks: 0.37 GB, and the CPU band's recommendation. */
const SWITCH_TARGET_ROW = /Eco Tiny/;

/** A slot the harness reports as ready — parameterised, unlike pilot's
 *  `READY_SLOT_SEARCH`, because these states need a smaller model bound. */
function readySlot(modelId: string): string {
  return [
    `eco-validation-slot-eco-fast=${modelId}`,
    "eco-validation-slot-status-eco-fast=ready",
    "eco-validation-selected-model=eco-fast",
    "eco-force-cache-verified=1",
  ].join("&");
}

/** The same slot mid-download: the card and the dialog row both say so. */
function preparingSlot(modelId: string): string {
  return [
    `eco-validation-slot-eco-fast=${modelId}`,
    "eco-validation-slot-status-eco-fast=preparing",
    "eco-validation-selected-model=eco-fast",
    "eco-force-cache-verified=1",
  ].join("&");
}

/** The Eco tab with a model already bound on a CPU-only device. */
const ECO_TAB = `tab=models&${readySlot(BOUND_MODEL)}&${CPU_DEVICE}`;

/**
 * A live heavy-work lease held by something else in this browser.
 *
 * Byte-identical in shape to what `acquireLocalHeavyWork` writes, so the
 * runtime reads it as a genuine concurrent readiness check. `expiresAt` is a
 * year 2100 stamp: the runner freezes the clock at 2026-03-17, and a lease that
 * expired against the fixed clock would be swept before the dialog asked.
 */
const HELD_RUNTIME_LEASE = JSON.stringify({
  ownerId: "readiness:another-eco-tab",
  kind: "readiness",
  startedAt: 1,
  expiresAt: 4_102_444_800_000,
});

/** Cached weights to plant, in the shipping cache format. Neither is bound. */
const CACHED_MODELS: [modelId: string, files: [url: string, bytes: number][]][] = [
  [
    "candidate/granite-4.0-350m-onnx",
    [
      ["https://models.eco.invalid/granite-4.0-350m/model_q4.onnx", 268_000_000],
      ["https://models.eco.invalid/granite-4.0-350m/tokenizer.json", 12_000_000],
    ],
  ],
  [
    "candidate/smollm2-360m-instruct-onnx",
    [["https://models.eco.invalid/smollm2-360m/model_int8.onnx", 361_000_000]],
  ],
];

const STORAGE_PANEL = '[data-testid="local-ai-storage-panel"]';

// ── Warm-up navigations (entry `mock` hooks) ────────────────────────────────

/**
 * Has the settings store's encrypted write for `key` actually reached the disk?
 *
 * `setShowTechnicalDetails` (and every sibling in settingsStore.ts) updates React
 * synchronously and then fires the persist as a FLOATING promise —
 * `void safeSettingsWrite(...)`, which encrypts and puts into the `eco-settings`
 * database. Nothing in the DOM reports when that lands, so a reload issued right
 * after the click can beat it and the setting is silently lost.
 *
 * The row itself is the only honest signal. The stored VALUE is ciphertext, but
 * the KEY is plaintext, and its presence is all we need.
 *
 * Opened only if the database already exists: a bare `indexedDB.open(name)` on a
 * missing database CREATES it at version 1 with no object stores, which would
 * then satisfy the app's own `openDB(name, 1, { upgrade })` without ever running
 * the upgrade — breaking the very store we are waiting on.
 */
async function settingPersisted(page: Page, key: string): Promise<boolean> {
  return page.evaluate(async (settingKey: string) => {
    const databases = await indexedDB.databases();
    if (!databases.some((entry) => entry.name === "eco-settings")) return false;

    return new Promise<boolean>((resolve) => {
      const open = indexedDB.open("eco-settings");
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("settings")) {
          db.close();
          resolve(false);
          return;
        }
        const request = db.transaction("settings", "readonly").objectStore("settings").getKey(settingKey);
        request.onerror = () => {
          db.close();
          resolve(false);
        };
        request.onsuccess = () => {
          const found = request.result !== undefined;
          db.close();
          resolve(found);
        };
      };
    });
  }, key);
}

/**
 * Turn the app's own "Show technical details" switch on and prove it persisted.
 *
 * The setting lives in encrypted IndexedDB, so this is the only way to reach it
 * without writing ciphertext by hand — and the reload is the proof the write
 * landed, so the capture's own navigation cannot photograph a half-saved state.
 *
 * The wait between the click and the reload is not belt-and-braces: without it
 * this helper was the single largest source of flake in the full-grid run on
 * 2026-08-19 (5 of 6 flaky entries, across four projects — both states that use
 * it). The reload was racing the write.
 */
async function technicalDetailsOn(page: Page): Promise<void> {
  await page.goto("/settings?tab=appearance");
  const toggle = page.getByRole("switch", { name: "Toggle technical details" });
  await toggle.click();
  await expect.poll(async () => settingPersisted(page, "show-technical-details")).toBe(true);
  await page.reload();
  await expect(page.getByRole("switch", { name: "Toggle technical details" }))
    .toHaveAttribute("aria-checked", "true");
}

/**
 * Plant two models' worth of cached weights, stamped the way the download
 * pipeline stamps them.
 *
 * `/privacy` is the warm-up host because it never boots the local-AI stack, so
 * nothing reconciles the namespaces out from under the seed before the settings
 * page reads them.
 */
async function seedCachedModels(page: Page): Promise<void> {
  await page.goto("/privacy");
  await page.evaluate(async (models: typeof CACHED_MODELS) => {
    for (const [modelId, files] of models) {
      const cache = await caches.open(`eco-local-ai-${modelId.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
      for (const [url, bytes] of files) {
        // A stamped, bodiless entry: the panel accounts by the stamp, which is
        // what the real pipeline writes for a streamed file.
        await cache.put(url, new Response("", {
          headers: { "x-eco-cache-size-bytes": String(bytes) },
        }));
      }
    }
  }, CACHED_MODELS);
}

/** Serve a truthful `/v1/auth/profile` — the exact shape `apps/api` returns. */
function profilePayload(tier: "free" | "supporter") {
  return async (page: Page): Promise<void> => {
    await page.route("**/v1/auth/profile", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "test-user-id",
          email: "test@eco.network",
          name: "Test User",
          subscriptionTier: tier,
          // apps/api/src/routes/profile.ts — price is a constant, and
          // billingConfigured is true wherever Stripe keys are set.
          supporterMembership: { supporterPriceMonthlyUsd: 15, billingConfigured: true },
        }),
      }));
  };
}

// ── Interactions ────────────────────────────────────────────────────────────

/**
 * Open the Switch dialog, and wait for it to stop moving.
 *
 * The modal card enters on a Motion spring (`springPresets.modal`), which
 * `animations: 'disabled'` does not touch — screenshots taken on the way in
 * differ by a percent of scale between runs. Polling the card's own transform
 * and opacity is the only settle signal that does not guess at a duration.
 */
async function openSwitchDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open Switch your AI dialog" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Switch your AI" })).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const host = document.querySelector('[role="dialog"]');
        const card = host?.firstElementChild ?? host;
        if (!(card instanceof HTMLElement)) return 1;
        const style = getComputedStyle(card);
        const { a, d } = new DOMMatrixReadOnly(style.transform);
        return Math.max(Math.abs(a - 1), Math.abs(d - 1), 1 - Number(style.opacity));
      }),
    )
    .toBeLessThan(0.002);
}

/** Open the dialog, pick the 350M row, and commit it. */
async function saveSwitchTo(page: Page, row: RegExp): Promise<void> {
  await openSwitchDialog(page);
  await page.getByRole("radio", { name: row }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

/**
 * How long a post-Save surface gets to appear.
 *
 * Committing a switch really builds a download plan, which really fetches the
 * model manifest from the dev server. Under four parallel workers that request
 * alone has been seen to take over a second, and the default 5s expect budget
 * made the failure notices flaky — reliably right, occasionally late.
 */
const SWITCH_RESULT_TIMEOUT = { timeout: 20_000 };

/**
 * Wait for the download surface to stop moving.
 *
 * `animations: 'disabled'` only fast-forwards CSS animations; the progress bar
 * and the botanical illustration are Motion springs that keep running under it.
 * The bar has no `initial`, so it springs DOWN from the container's full width
 * to its 2% floor — an early shot caught an 85%-full bar on a download that had
 * not received a byte — and the illustration's growth spring (stiffness 55) is
 * slower still. Two checks, because they answer different questions: the bar
 * really is at the floor, and nothing has moved between two polls.
 */
function loadingSurfaceSignature(): string {
  const fill = Array.from(document.querySelectorAll<HTMLElement>('[role="status"] div'))
    .find((node) => node.style.background === "var(--eco-primary)");
  const track = fill?.parentElement;
  const plant = document.querySelector<HTMLElement>('[role="img"][aria-label^="A botanical"]');
  if (!fill || !track || !plant) return "";
  const width = (fill.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100;
  const style = getComputedStyle(plant);
  return `${width.toFixed(2)}|${style.transform}|${style.opacity}`;
}

async function loadingSurfaceSettled(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const fill = Array.from(document.querySelectorAll<HTMLElement>('[role="status"] div'))
          .find((node) => node.style.background === "var(--eco-primary)");
        const track = fill?.parentElement;
        if (!fill || !track) return -1;
        return (fill.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100;
      }),
    )
    .toBeLessThan(4);

  let previous = "";
  await expect
    .poll(async () => {
      const current = await page.evaluate(loadingSurfaceSignature);
      const settled = current !== "" && current === previous;
      previous = current;
      return settled;
    })
    .toBe(true);
}

/**
 * Re-apply the runner's dev-chrome style tag after a reload.
 *
 * `settle` injects it once; a `prepare` that reloads throws it away, and the
 * Next.js dev indicator would land in the frame.
 */
async function reloadWith(page: Page, init: () => void): Promise<void> {
  await page.addInitScript(init);
  await page.reload();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

/** What this wave deliberately did not capture, in a printable form. */
export const settingsGaps: CaptureGap[] = [
  {
    id: "settings.switch-smoke-failed",
    group: "settings",
    surface: "The switch dialog's smoke-failure copy (smokeFailedHeadline, both confidence variants)",
    reason:
      "Reaching it means a model that downloads AND loads and then fails its readiness check. eco-force-download fails "
      + "before the load and eco-force-local-runtime=crash fails at it, so both land on the load-failed headline instead. "
      + "Nothing forces a smoke failure, and faking one would mean editing src/.",
  },
  {
    id: "settings.eco-legacy-storage-summary",
    group: "settings",
    surface: "SettingsEcoTab's legacy single-line storage summary and its “Yes, clear <model>” confirm",
    reason:
      "LocalAiSettingsAdapter always passes a breakdown, so the branch cannot render in the shipping app — it is dead code "
      + "behind a prop, not a state a person can meet.",
  },
  {
    id: "settings.account-saving-beat",
    group: "settings",
    surface: "The account form's `saving` disabled beat (“Saving…”) and the delete-in-progress dialog copy",
    reason:
      "Both live between a click and a fulfilled route mock; holding the response open would park them, but the pair is two "
      + "words of button copy inside states already captured.",
  },
];

export const settingsStates: StateEntry[] = [
  // ── Settings → Eco: the tab itself ──────────────────────────────────────
  {
    id: "settings.eco-not-set-up",
    group: "settings",
    title: "Eco tab — no model on this device yet",
    route: "/settings",
    search: `tab=models&${CPU_DEVICE}`,
    tier: "page",
    realism: "seeded",
    assert: [
      { text: "Eco isn't set up on this device yet." },
      { role: "button", name: "Set up Eco" },
    ],
    notes: "No slot is seeded, so the tab offers setup instead of naming a model. The only Eco-tab state with no storage panel and no web-lookups switch.",
  },
  {
    id: "settings.eco-model-preparing",
    group: "settings",
    title: "Eco tab — the running model is still downloading",
    route: "/settings",
    search: `tab=models&${preparingSlot(BOUND_MODEL)}&${CPU_DEVICE}`,
    tier: "component",
    realism: "seeded",
    assert: [
      { text: "Currently running" },
      { text: "Setting up on this device…" },
    ],
    notes: "A slot left 'preparing' must never read as a ready model, so the card carries a quiet second line under the name.",
  },
  {
    id: "settings.eco-provenance-line",
    group: "settings",
    title: "Eco tab — provenance line shown (technical details on)",
    route: "/settings",
    search: ECO_TAB,
    tier: "component",
    realism: "mocked",
    mock: technicalDetailsOn,
    assert: [
      { text: "Currently running" },
      { text: "Liquid AI · 0.3 GB" },
    ],
    notes: "The mono provenance under the model name appears only for people who asked for technical details. Flagged 'mocked' because the setting is flipped on a warm-up navigation — nothing here is faked, but the manifest reserves that field for any pre-navigation hook.",
  },
  {
    id: "settings.eco-technical-details-open",
    group: "settings",
    title: "Eco tab — technical details disclosure open",
    route: "/settings",
    search: ECO_TAB,
    tier: "micro",
    realism: "mocked",
    mock: technicalDetailsOn,
    assert: [{ text: "Currently running" }],
    prepare: async (page) => {
      await page.getByRole("button", { name: /Show technical details/ }).click();
      const details = page.getByRole("region", { name: "Show technical details" });
      await expect(details.getByText("candidate/lfm2.5-350m-onnx")).toBeVisible();
      await expect(details.getByText("Transformers.js v4")).toBeVisible();
      // The disclosure is the last thing on a long tab: without this the frame
      // stops at its first row and the state's whole point is below the fold.
      await details.scrollIntoViewIfNeeded();
    },
    notes: "Everything the branded copy deliberately hides — raw id, runtime, context window, format, quality rating, known limitation — in one place, exactly as AGPL transparency asks.",
  },
  {
    id: "settings.eco-web-lookups-off",
    group: "settings",
    title: "Eco tab — web lookups switched off",
    route: "/settings",
    search: ECO_TAB,
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "Look up facts from the web" }],
    prepare: async (page) => {
      const toggle = page.getByRole("switch", { name: "Toggle web fact lookups" });
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    },
    notes: "Grounding ships on; this is the off position, which is the state that makes the fully-on-device promise absolute. Only the switch changes — the copy is deliberately identical either way.",
  },
  {
    id: "settings.eco-custom-instructions-filled",
    group: "settings",
    title: "Eco tab — custom instructions written",
    route: "/settings",
    search: ECO_TAB,
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "How Eco talks to you" }],
    prepare: async (page) => {
      await page.getByRole("textbox", { name: "Custom instructions" }).fill(
        "I'm a landscape gardener in Vermont. Prefer short answers, metric units, and skip the preamble.",
      );
      await expect(page.getByText("95 / 1500")).toBeVisible();
    },
    notes: "The editor with content and its character counter — the empty placeholder version rides along in every other Eco-tab shot.",
  },

  // ── Settings → Eco: the storage panel ───────────────────────────────────
  {
    id: "settings.storage-empty",
    group: "settings",
    title: "Storage — nothing cached (measured)",
    route: "/settings",
    search: ECO_TAB,
    tier: "component",
    realism: "seeded",
    capture: { mode: "element", selector: STORAGE_PANEL },
    assert: [
      { testId: "local-ai-storage-panel" },
      { text: "Nothing cached on this device yet" },
    ],
    notes: "The panel alone, so the soil bar and the empty-state illustration are legible; the whole-page version is W1's. The 'available' figure comes from navigator.storage.estimate and is a property of the browser profile, so it moves between runs — that difference is the browser talking, not the UI changing, and it is left un-faked on purpose.",
  },
  {
    id: "settings.storage-cached-models",
    group: "settings",
    title: "Storage — two cached models",
    route: "/settings",
    search: ECO_TAB,
    tier: "component",
    realism: "mocked",
    capture: { mode: "element", selector: STORAGE_PANEL },
    mock: seedCachedModels,
    assert: [
      { testId: "local-ai-storage-panel" },
      { text: "Granite 4.0 350M" },
      { text: "SmolLM2 360M" },
    ],
    notes: "Real Cache Storage entries in the shipping format, planted on a warm-up navigation — the per-model byte figures are ours but the accounting is the app's. The soil bar's 'available' half still comes from the real browser estimate and moves between runs. Note the cards print raw catalog names ('SmolLM2 360M') where the rest of the product prints branded ones ('Eco Tiny').",
  },
  {
    id: "settings.storage-remove-confirming",
    group: "settings",
    title: "Storage — Remove, waiting on confirmation",
    route: "/settings",
    search: ECO_TAB,
    tier: "micro",
    realism: "mocked",
    capture: { mode: "element", selector: STORAGE_PANEL },
    mock: seedCachedModels,
    assert: [{ testId: "local-ai-storage-panel" }],
    prepare: async (page) => {
      await page.getByRole("button", { name: "Remove SmolLM2 360M from this device" }).click();
      await expect(page.getByRole("button", { name: /Confirm removing SmolLM2/ })).toBeVisible();
    },
    notes: "Deleting a model asks first, inline on the card — one row in confirm, the other still offering Remove.",
  },
  {
    id: "settings.storage-unmeasured",
    group: "settings",
    title: "Storage — the browser wouldn't say",
    route: "/settings",
    search: ECO_TAB,
    tier: "micro",
    realism: "seeded",
    capture: { mode: "element", selector: STORAGE_PANEL },
    assert: [{ testId: "local-ai-storage-panel" }],
    prepare: async (page) => {
      // A browser with no Cache API (private windows do this) — installed
      // before the reload because the hook reads `caches` as it mounts.
      await reloadWith(page, () => {
        Object.defineProperty(window, "caches", { get: () => undefined, configurable: true });
      });
      await expect(page.getByText("Eco couldn't check storage on this device")).toBeVisible();
    },
    notes: "The honest distinction the panel draws: it will not claim 'nothing cached' when it could not look. Gigabytes may still be on disk.",
  },
  {
    id: "settings.storage-measuring",
    group: "settings",
    title: "Storage — measuring",
    route: "/settings",
    search: ECO_TAB,
    tier: "micro",
    realism: "seeded",
    capture: { mode: "element", selector: STORAGE_PANEL },
    assert: [{ testId: "local-ai-storage-panel" }],
    prepare: async (page) => {
      // The estimate that never answers is what a slow disk feels like; the
      // panel's own skeleton is otherwise a sub-second flash nobody can catch.
      await reloadWith(page, () => {
        Object.defineProperty(navigator.storage, "estimate", {
          value: () => new Promise(() => undefined),
          configurable: true,
        });
      });
      await expect(page.getByText("Measuring storage…")).toBeVisible();
    },
    notes: "The soil-bar skeleton. Held open by a stalled navigator.storage.estimate, because nothing in the app delays it.",
  },

  // ── Switch your AI ──────────────────────────────────────────────────────
  {
    id: "settings.switch-list",
    group: "settings",
    title: "Switch your AI — the list",
    route: "/settings",
    search: ECO_TAB,
    tier: "component",
    realism: "seeded",
    assert: [{ text: "Switch your AI" }],
    prepare: async (page) => {
      await openSwitchDialog(page);
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("radiogroup", { name: "Available AIs" })).toBeVisible();
      await expect(dialog.getByText("Recommended for your device")).toBeVisible();
      // Scoped to the dialog: the tab's own "Currently running" section heading
      // carries the same words, and an unscoped lookup is ambiguous.
      await expect(dialog.getByText("Currently running")).toBeVisible();
    },
    notes: "One calm ranked list: a leafed recommendation at the top, the bound model captioned 'Currently running', no tiers and no provenance. The assertion holds before the dialog opens because the tab's own button carries the same words.",
  },
  {
    id: "settings.switch-row-selected",
    group: "settings",
    title: "Switch your AI — a different model picked",
    route: "/settings",
    search: ECO_TAB,
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "Switch your AI" }],
    prepare: async (page) => {
      await openSwitchDialog(page);
      const row = page.getByRole("radio", { name: /Eco Basic/ });
      await row.click();
      await expect(row).toHaveAttribute("aria-checked", "true");
    },
    notes: "The selection mark moves off the bound model onto a third row, which is the only difference from settings.switch-list — the whole row is the control, so the ring plus the check is the entire affordance.",
  },
  {
    id: "settings.switch-current-preparing",
    group: "settings",
    title: "Switch your AI — the current model is still setting up",
    route: "/settings",
    search: `tab=models&${preparingSlot(BOUND_MODEL)}&${CPU_DEVICE}`,
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "Switch your AI" }],
    prepare: async (page) => {
      await openSwitchDialog(page);
      await expect(page.getByText("Setting up…")).toBeVisible();
    },
    notes: "Same list, one caption different: an unfinished download reads 'Setting up…' where a ready one reads 'Currently running'.",
  },
  {
    id: "settings.switch-no-alternatives",
    group: "settings",
    title: "Switch your AI — nothing else fits this device",
    route: "/settings",
    search: `tab=models&${readySlot(BOUND_MODEL)}&${BELOW_FLOOR_DEVICE}`,
    tier: "component",
    realism: "seeded",
    assert: [{ text: "Switch your AI" }],
    prepare: async (page) => {
      await openSwitchDialog(page);
      await expect(page.getByText("No alternative AIs are available on this device right now."))
        .toBeVisible();
    },
    notes: "A 2 GB device: `canServe` is false, so the list is empty and the seedling stands in for it. Save stays disabled — there is nothing to save.",
  },
  {
    id: "settings.switch-downloading",
    group: "settings",
    title: "Switch your AI — downloading the new model",
    route: "/settings",
    search: ECO_TAB,
    tier: "component",
    realism: "seeded",
    assert: [{ text: "Switch your AI" }],
    prepare: async (page) => {
      await saveSwitchTo(page, SWITCH_TARGET_ROW);
      await expect(page.getByText("Downloading model…")).toBeVisible(SWITCH_RESULT_TIMEOUT);
      // Cancel is replaced by Stop for exactly as long as the load is in flight.
      await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
      await loadingSurfaceSettled(page);
    },
    notes: "The lane holds weight requests open, so this parks at the first byte: seed illustration, empty bar, no percentage, and a Stop that means it. Nothing is downloaded.",
  },
  {
    id: "settings.switch-network-notice",
    group: "settings",
    title: "Switch your AI — the connection dropped",
    route: "/settings",
    search: `eco-force-download=hosting&${ECO_TAB}`,
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "Switch your AI" }],
    prepare: async (page) => {
      await saveSwitchTo(page, SWITCH_TARGET_ROW);
      await expect(page.getByText("Your connection dropped while downloading Eco Tiny (SmolLM)."))
        .toBeVisible(SWITCH_RESULT_TIMEOUT);
    },
    notes: "A transport failure is about the network, so the copy says so and offers no downgrade — the footer's 'Try again' is the whole remedy. eco-force-download=hosting is the one mode that raises DownloadFailedError.",
  },
  {
    id: "settings.switch-failure-notice",
    group: "settings",
    title: "Switch your AI — that model wouldn't run here",
    route: "/settings",
    search: `eco-force-download=cache&${ECO_TAB}`,
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "Switch your AI" }],
    prepare: async (page) => {
      await saveSwitchTo(page, SWITCH_TARGET_ROW);
      await expect(page.getByText("We couldn't get Eco Tiny (SmolLM) running here."))
        .toBeVisible(SWITCH_RESULT_TIMEOUT);
      await expect(page.getByRole("button", { name: /^Try Eco Compact/ })).toBeVisible();
    },
    notes: "The cascade offer: a named next-best fit plus 'Pick another'. eco-force-download=cache, opfs, storage and quota all land on this same headline — the four differ only in the error the download raises, which the dialog does not surface.",
  },
  {
    id: "settings.switch-busy-notice",
    group: "settings",
    title: "Switch your AI — the runtime is busy",
    route: "/settings",
    search: ECO_TAB,
    seed: { local: { "eco-local-heavy-work-owner-v1": HELD_RUNTIME_LEASE } },
    tier: "micro",
    realism: "seeded",
    assert: [{ text: "Switch your AI" }],
    prepare: async (page) => {
      await saveSwitchTo(page, SWITCH_TARGET_ROW);
      // Busy retries itself once after 3s; this is the state after that retry
      // found the lease still held, which is what makes it a real answer.
      await expect(page.getByText("A readiness check is already running.", { exact: false }))
        .toBeVisible(SWITCH_RESULT_TIMEOUT);
    },
    notes: "Calm and neutral, not a warning: another local model task holds the runtime. The lease is a seeded localStorage row of exactly the shape another tab writes.",
  },
  {
    id: "settings.switch-retrying",
    group: "settings",
    title: "Switch your AI — quietly retrying",
    route: "/settings",
    search: ECO_TAB,
    seed: { local: { "eco-local-heavy-work-owner-v1": HELD_RUNTIME_LEASE } },
    tier: "micro",
    realism: "seeded",
    // The retry window is a real 3-second wait; a paused clock freezes it open
    // so the screenshot can never race the timer.
    clock: { mode: "paused" },
    assert: [{ text: "Switch your AI" }],
    prepare: async (page) => {
      await saveSwitchTo(page, SWITCH_TARGET_ROW);
      await expect(page.getByText("Finishing a quick check…")).toBeVisible(SWITCH_RESULT_TIMEOUT);
    },
    notes: "The three seconds before the silent retry: the same neutral surface as busy, with a breathing leaf, so a transient hold never costs the user a 'Try again' they did not need.",
  },

  // ── Settings → Account ──────────────────────────────────────────────────
  {
    id: "settings.account-name-dirty",
    group: "settings",
    title: "Account — name edited, not yet saved",
    route: "/settings",
    search: "tab=account",
    auth: "signed-in",
    tier: "micro",
    realism: "mocked",
    assert: [{ text: "Profile" }],
    prepare: async (page) => {
      await page.locator("#settings-name").fill("Sam Rivera");
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    },
    notes: "Save only exists once something changed — the form has no permanently-disabled button.",
  },
  {
    id: "settings.account-saved",
    group: "settings",
    title: "Account — saved",
    route: "/settings",
    search: "tab=account",
    auth: "signed-in",
    tier: "micro",
    realism: "mocked",
    assert: [{ text: "Profile" }],
    prepare: async (page) => {
      await page.locator("#settings-name").fill("Sam Rivera");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved.")).toBeVisible();
    },
    notes: "The confirmation replaces the Save button rather than joining it, so the row never reads as unsaved work. The PATCH is answered by the lane's blanket /v1 mock.",
  },
  {
    id: "settings.account-save-error",
    group: "settings",
    title: "Account — the save failed",
    route: "/settings",
    search: "tab=account",
    auth: "signed-in",
    tier: "micro",
    realism: "mocked",
    mock: async (page) => {
      await page.route("**/v1/auth/profile", (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
          : route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    },
    assert: [{ text: "Profile" }],
    prepare: async (page) => {
      await page.locator("#settings-name").fill("Sam Rivera");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Failed to save profile")).toBeVisible();
    },
    notes: "A 500 on the PATCH. The message is the thrown text, and Save stays put so the edit is never lost — worth a designer's eye, it is the least designed string in settings.",
  },
  {
    id: "settings.account-delete-confirm",
    group: "settings",
    title: "Account — delete confirmation",
    route: "/settings",
    search: "tab=account",
    auth: "signed-in",
    tier: "component",
    realism: "mocked",
    assert: [{ text: "Delete account" }],
    prepare: async (page) => {
      await page.getByRole("button", { name: "Delete account" }).click();
      await expect(page.getByText("Delete your account")).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete my account" })).toBeVisible();
    },
    notes: "A native <dialog> rather than the app's Modal, so it renders in the top layer with its own backdrop — the one destructive confirmation in settings.",
  },
  {
    id: "settings.account-supporter",
    group: "settings",
    title: "Account — a Supporter's account tab",
    route: "/settings",
    search: "tab=account",
    auth: "signed-in",
    tier: "component",
    realism: "mocked",
    mock: profilePayload("supporter"),
    assert: [{ text: "You're a Supporter — thank you." }],
    notes: "One sentence differs from the signed-in default (pilot.settings-account), and it is the only place the account tab acknowledges membership at all.",
  },

  // ── Settings → Billing ──────────────────────────────────────────────────
  {
    id: "settings.billing-supporter-active",
    group: "settings",
    title: "Billing — an active Supporter",
    route: "/settings",
    search: "tab=billing",
    auth: "signed-in",
    tier: "page",
    realism: "mocked",
    mock: profilePayload("supporter"),
    assert: [
      { text: "You're a Supporter — thank you for keeping Eco independent." },
      { role: "button", name: "Manage subscription" },
    ],
    notes: "The plan badge, the Stripe portal button, and the Supporter card marked Current. W1's billing shots run on the blanket /v1 mock, which returns no tier at all and so hides this whole half of the tab.",
  },
  {
    id: "settings.billing-free-with-checkout",
    group: "settings",
    title: "Billing — free, with checkout available",
    route: "/settings",
    search: "tab=billing",
    auth: "signed-in",
    tier: "page",
    realism: "mocked",
    mock: profilePayload("free"),
    assert: [
      { role: "button", name: "Become a Supporter" },
      { text: "Same features on both. Always." },
    ],
    notes: "What a free account sees once Stripe is configured: the two pricing cards with Free marked Current, and the promise that they are the same product. Unreachable in W1's shots, where billingConfigured is false and the Plans section never renders.",
  },

  // ── Settings → Appearance ───────────────────────────────────────────────
  {
    id: "settings.appearance-font-compact",
    group: "settings",
    title: "Appearance — font size set to Compact",
    route: "/settings",
    search: "tab=appearance",
    tier: "micro",
    realism: "real",
    assert: [{ text: "Font size" }],
    prepare: async (page) => {
      await page.getByRole("button", { name: "Compact", exact: true }).click();
      await expect(page.getByRole("button", { name: "Compact", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      // The control is only honest if the document actually changed with it.
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.dataset.fontSize))
        .toBe("compact");
    },
    notes: "The segmented control in its non-default position, and the page it just resized. The app-wide font-size axis (every state re-shot at each size) is W6's.",
  },
  {
    id: "settings.appearance-font-comfortable",
    group: "settings",
    title: "Appearance — font size set to Comfortable",
    route: "/settings",
    search: "tab=appearance",
    tier: "micro",
    realism: "real",
    assert: [{ text: "Font size" }],
    prepare: async (page) => {
      await page.getByRole("button", { name: "Comfortable", exact: true }).click();
      await expect(page.getByRole("button", { name: "Comfortable", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.dataset.fontSize))
        .toBe("comfortable");
    },
  },
  {
    id: "settings.appearance-theme-system",
    group: "settings",
    title: "Appearance — theme handed back to the system",
    route: "/settings",
    search: "tab=appearance",
    tier: "micro",
    realism: "real",
    assert: [{ text: "Theme" }],
    prepare: async (page) => {
      await page.getByRole("button", { name: "System", exact: true }).click();
      await expect(page.getByRole("button", { name: "System", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
    },
    notes: "Chosen from an explicit light or dark preference, so the click really moves the selection. The emulated OS scheme matches the project, which is why the page itself does not flip.",
  },
  {
    id: "settings.appearance-switches-flipped",
    group: "settings",
    title: "Appearance — sounds on, tool results collapsed",
    route: "/settings",
    search: "tab=appearance",
    tier: "micro",
    realism: "real",
    assert: [{ text: "Sounds & feedback" }],
    prepare: async (page) => {
      const sounds = page.getByRole("switch", { name: "Toggle sound effects" });
      const expand = page.getByRole("switch", { name: "Toggle expand tool results" });
      await sounds.click();
      await expand.click();
      await expect(sounds).toHaveAttribute("aria-checked", "true");
      await expect(expand).toHaveAttribute("aria-checked", "false");
    },
    notes: "Both switches away from their defaults in one shot — sounds ship off, expand-tool-results ships on, and neither changes anything else on the page.",
  },

  // ── The settings shell ──────────────────────────────────────────────────
  {
    id: "settings.tabs-skeleton",
    group: "settings",
    title: "Settings — loading skeleton",
    route: "/settings",
    search: "tab=appearance",
    tier: "component",
    realism: "seeded",
    assert: [{ role: "heading", name: "Settings" }],
    prepare: async (page) => {
      // `SettingsTabs` renders its skeleton until the encrypted settings store
      // answers. Opening that database and never answering is what a stalled
      // IndexedDB feels like, and the only way to hold the skeleton still.
      await reloadWith(page, () => {
        const factory = IDBFactory.prototype;
        // Deliberately unbound: this is the original implementation, re-invoked
        // with the caller's own `this` below.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const open = factory.open;
        factory.open = function stalledOpen(name: string, ...rest: [number?]) {
          const request = open.call(this, name, ...rest);
          // Every other database (chat history, the model cache bookkeeping)
          // must keep working; only the settings store is held open.
          if (name !== "eco-settings") return request;
          return new Proxy(request, {
            get(target, prop) {
              if (prop === "addEventListener" || prop === "removeEventListener") {
                return () => undefined;
              }
              const value: unknown = Reflect.get(target, prop);
              return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
            },
            set(target, prop, value) {
              if (prop === "onsuccess" || prop === "onerror" || prop === "onupgradeneeded") {
                return true;
              }
              return Reflect.set(target, prop, value);
            },
          });
        };
      });
      await expect(page.locator(".skeleton-shimmer").first()).toBeVisible();
    },
    notes: "The tab bar and four content rows a person sees for the moment before their settings decrypt. Every tab shows the same one, so it is captured once.",
  },
];
