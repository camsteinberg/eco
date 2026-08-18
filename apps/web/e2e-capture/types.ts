// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Page } from "@playwright/test";

/**
 * The capture lane's data model.
 *
 * A capture is declared, not scripted: every UI state Eco can be in is one
 * `StateEntry` in a manifest file. The lane's runner (`capture.ts`) turns an
 * entry plus a rendering context (viewport / theme / motion / font size) into
 * exactly one PNG. Later waves add manifest entries only — the mechanisms all
 * live here and in `capture.ts`.
 */

export type ViewportName = "mobile" | "tablet" | "desktop";
export type ThemeName = "light" | "dark" | "system";
export type MotionName = "no-preference" | "reduce";

/**
 * Font-size names are the values the app's own appearance control writes.
 * `AppearanceTab.tsx` stores 'Default' | 'Compact' | 'Comfortable' under
 * `eco-font-size` and the pre-paint script in `app/layout.tsx` lowercases them
 * into `documentElement.dataset.fontSize`, which `globals.css` matches on
 * (`[data-font-size="compact"]`). We name the lowercase (rendered) form and
 * seed the capitalized (stored) form — see `FONT_SIZE_STORAGE_VALUE`.
 */
export type FontSizeName = "default" | "compact" | "comfortable";

/** The stored `eco-font-size` value for each rendered font-size name. */
export const FONT_SIZE_STORAGE_VALUE: Record<FontSizeName, string> = {
  default: "Default",
  compact: "Compact",
  comfortable: "Comfortable",
};

/**
 * How widely a state is worth shooting.
 *
 * - `page` — a whole route. Layout is the point, so all three viewports.
 * - `component` — a region or overlay. Desktop + mobile catch the two layouts.
 * - `micro` — a hover/focus/open-menu detail. Desktop only; it needs a
 *   pointer, and the mobile twin would be a different state, not this one.
 *
 * The mapping itself lives in `entryRunsInContext` (capture.ts) — one place.
 */
export type CaptureTier = "page" | "component" | "micro";

/**
 * How honest the pixels are.
 *
 * - `real` — the app produced this on its own.
 * - `seeded` — we set storage / harness knobs, but the app rendered the rest.
 * - `mocked` — a network response was faked (auth session, API payload).
 *
 * The generated index flags `mocked` states so a reviewer never mistakes a
 * stubbed screen for shipping behavior.
 */
export type Realism = "real" | "seeded" | "mocked";

/** IndexedDB fixtures the harness can install, by name. */
export type IdbFixtureName = "conversation-assistant-dom" | "conversation-hybrid-continuation";

/**
 * Storage to plant before the first paint.
 *
 * Removals run LAST so an entry can un-suppress something the base
 * onboarding-suppression bundle sets (e.g. drop `eco-tour-completed` to
 * capture the tour's first step).
 */
export type SeedRecipe = {
  local?: Record<string, string>;
  removeLocal?: string[];
  session?: Record<string, string>;
  removeSession?: string[];
  idb?: IdbFixtureName[];
};

/**
 * A proof that the state actually rendered.
 *
 * Every entry carries at least one. They run before the screenshot (and again
 * after `prepare`), so a blank or half-hydrated frame fails the run instead of
 * quietly becoming a baseline.
 */
export type StateAssertion =
  | { text: string; exact?: boolean }
  | { testId: string }
  | { role: Parameters<Page["getByRole"]>[0]; name?: string }
  | { selector: string };

export type CaptureMode = "viewport" | "fullPage" | "element";

export type CaptureSpec = {
  mode?: CaptureMode;
  /** Required when `mode` is 'element' — the region to shoot. */
  selector?: string;
};

/**
 * Time control.
 *
 * `fixed` (the default) freezes `Date.now()` so relative timestamps
 * ("2 minutes ago") are stable without stopping timers. `paused` installs a
 * fake clock, which also holds `setTimeout`/`requestAnimationFrame` — use it to
 * park a progress animation at a chosen moment via `advanceMs`.
 */
export type ClockSpec = {
  mode: "fixed" | "paused";
  timeISO?: string;
  advanceMs?: number;
};

/** Per-entry overrides of the tier's default axis expansion. */
export type AxisOverrides = {
  viewports?: ViewportName[];
  themes?: ThemeName[];
  motion?: MotionName[];
  fontSize?: FontSizeName[];
};

/**
 * The context one screenshot is taken in — parsed from the Playwright project
 * name, so a project is exactly one point on the axis grid.
 */
export type CaptureContext = {
  viewport: ViewportName;
  /** The app's own stored preference (`eco-theme`); 'system' means unset. */
  theme: ThemeName;
  /**
   * The OS-level preference we emulate. Equal to `theme` for the explicit
   * light/dark projects; for a 'system' project it is what the browser reports
   * while `eco-theme` stays unset, which is the whole point of that project.
   */
  colorScheme: "light" | "dark";
  motion: MotionName;
  fontSize: FontSizeName;
  /** Playwright project name, e.g. `desktop-dark` or `desktop-light-reduce`. */
  project: string;
  /** Absolute directory this run's PNGs and metadata are written to. */
  outputRoot: string;
  runId: string;
};

export type StateEntry = {
  /** Stable dotted id, `<group>.<name>`. This is API: never rename casually. */
  id: string;
  group: string;
  title: string;
  route: string;
  /** Query string (no leading `?`) — harness knobs only, see KNOWN_HARNESS_KEYS. */
  search?: string;
  seed?: SeedRecipe;
  auth?: "guest" | "signed-in";
  tier: CaptureTier;
  realism: Realism;
  axes?: AxisOverrides;
  capture?: CaptureSpec;
  clock?: ClockSpec;
  assert: StateAssertion[];
  /** Real interaction (hover, click, Tab) run after the state settles. */
  prepare?: (page: Page, ctx: CaptureContext) => Promise<void>;
  /** Marks a state only reachable through a dev/diagnostics seam. */
  internal?: boolean;
  notes?: string;
};

/** One row of the run manifest written alongside the PNGs. */
export type ShotRecord = {
  id: string;
  title: string;
  path: string;
  project: string;
  viewport: ViewportName;
  theme: ThemeName;
  motion: MotionName;
  fontSize: FontSizeName;
  tier: CaptureTier;
  realism: Realism;
  route: string;
  /** Human-readable form of the entry's assertions, for the generated index. */
  asserts: string[];
  bytes: number;
  sha256: string;
};
