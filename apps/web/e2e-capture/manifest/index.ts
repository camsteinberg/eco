// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { CaptureGap, StateEntry } from "../types";
import { axesGaps, axesStates } from "./axes";
import { chatInteractionsGaps, chatInteractionsStates } from "./chat-interactions";
import { chatSurfaceGaps, chatSurfaceStates } from "./chat-surface";
import { overlaysGaps, overlaysStates } from "./overlays";
import { pilotGaps, pilotStates } from "./pilot";
import { routesGaps, routesStates } from "./routes";
import { settingsGaps, settingsStates } from "./settings";
import { setupGateGaps, setupGateStates } from "./setup-gate";
import { sidebarGaps, sidebarStates } from "./sidebar";

/**
 * The manifest: every UI state the capture lane knows how to shoot.
 *
 * Groups are added by later waves — a wave is one new `<group>.ts` file plus
 * one line in `GROUPS` below. The invariant guards at the bottom of this file
 * run at MODULE LOAD, so a malformed entry fails the whole lane loudly (and
 * fails the unit suite) instead of silently producing a missing or duplicate
 * screenshot that nobody notices in a 300-image contact sheet.
 */

const GROUPS: Record<string, StateEntry[]> = {
  pilot: pilotStates,
  routes: routesStates,
  "setup-gate": setupGateStates,
  "chat-surface": chatSurfaceStates,
  "chat-interactions": chatInteractionsStates,
  settings: settingsStates,
  sidebar: sidebarStates,
  overlays: overlaysStates,
  axes: axesStates,
};

/**
 * What each group could NOT photograph, and why.
 *
 * Every group declares an array — an empty one is a claim ("this group is
 * complete"), not an omission, which is why the guard below requires the key to
 * exist rather than defaulting it. The generated index prints all of these
 * under HONEST GAPS, so a reviewer reads the inventory's limits next to the
 * inventory instead of trusting that silence means coverage.
 */
const GAPS: Record<string, CaptureGap[]> = {
  pilot: pilotGaps,
  routes: routesGaps,
  "setup-gate": setupGateGaps,
  "chat-surface": chatSurfaceGaps,
  "chat-interactions": chatInteractionsGaps,
  settings: settingsGaps,
  sidebar: sidebarGaps,
  overlays: overlaysGaps,
  axes: axesGaps,
};

/**
 * URL knobs the validation harness reads (`src/lib/validation-harness.ts`).
 *
 * A manifest entry may only put these in its `search`. Anything else is either
 * a typo (which would silently capture the un-forced state) or a production
 * query param that does not belong in a forced capture. Kept in sync with the
 * harness by `src/__tests__/capture-manifest.test.ts`, which greps the harness
 * module for each name.
 */
export const KNOWN_HARNESS_KEYS: ReadonlySet<string> = new Set([
  "eco-force-download",
  "eco-force-local-runtime",
  "eco-force-protection",
  "eco-force-remote",
  "eco-force-capability",
  "eco-force-browser",
  "eco-force-platform",
  "eco-force-device-memory",
  "eco-force-opfs",
  "eco-force-data-saver",
  "eco-force-metered",
  "eco-force-connection",
  "eco-force-cache-verified",
  "eco-heavy-work-dry-run",
  "eco-heavy-work-model",
  "eco-history-fixture",
  "eco-local-generation-fixture",
  "eco-local-generation-model",
  "eco-local-generation-slot",
  "eco-validation-selected-model",
  "eco-validation-slot-eco-fast",
  "eco-validation-slot-eco-smart",
  "eco-validation-slot-status-eco-fast",
  "eco-validation-slot-status-eco-smart",
]);

/**
 * Real product query params a route reads (not harness knobs) — allowed in
 * `search` because they select a shipping state, e.g. which settings tab opens.
 */
export const KNOWN_ROUTE_PARAMS: ReadonlySet<string> = new Set([
  "tab",
  "prompt",
  "eco-diagnostics",
  // Auth + gate continuation and result params. Each one is read by a shipping
  // route: `callbackUrl`/`prompt` by the auth pages (auth-continuation.ts),
  // `returnTo` by /gate, `signedOut` by /sign-in, `token` and `error` by
  // /reset-password, `billing` by the billing settings tab.
  "returnTo",
  "billing",
  "signedOut",
  "error",
  "token",
  "callbackUrl",
  // `tour=1` launches the guided tour and is read by OnboardingTour, which then
  // strips it from the URL with replaceState — a shipping entry point (the help
  // menu links to it), not a harness knob.
  "tour",
]);

const ID_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function fail(entryId: string, problem: string): never {
  throw new Error(
    `Capture manifest is invalid — entry "${entryId}": ${problem}. `
      + `Fix the manifest; the capture lane refuses to run on an ambiguous state list.`,
  );
}

function assertEntryIsWellFormed(entry: StateEntry, group: string): void {
  if (!ID_PATTERN.test(entry.id)) {
    fail(entry.id, `id must match ${String(ID_PATTERN)} (lowercase, dot-separated)`);
  }

  if (!entry.id.startsWith(`${group}.`)) {
    fail(entry.id, `id must be prefixed with its group ("${group}.")`);
  }

  if (entry.group !== group) {
    fail(entry.id, `group is "${entry.group}" but it is registered under "${group}"`);
  }

  if (entry.assert.length < 1) {
    fail(entry.id, "needs at least one assertion — an unproven screenshot proves nothing");
  }

  if (entry.capture?.mode === "element" && !entry.capture.selector) {
    fail(entry.id, "capture mode 'element' requires a selector");
  }

  if (entry.tier === "micro" && !entry.prepare) {
    fail(entry.id, "micro states must define prepare() — the interaction IS the state");
  }

  if (entry.mock && entry.realism !== "mocked") {
    fail(
      entry.id,
      `declares mock() but realism is "${entry.realism}" — a faked response is never real, `
        + "and the generated index has to be able to say so",
    );
  }

  if (entry.search === undefined) {
    return;
  }

  for (const key of new URLSearchParams(entry.search).keys()) {
    if (!KNOWN_HARNESS_KEYS.has(key) && !KNOWN_ROUTE_PARAMS.has(key)) {
      fail(
        entry.id,
        `search param "${key}" is not a known harness knob or route param. `
          + "Add it to KNOWN_HARNESS_KEYS only if src/lib/validation-harness.ts really reads it",
      );
    }
  }
}

function buildManifest(): StateEntry[] {
  const all: StateEntry[] = [];
  const seen = new Set<string>();

  for (const [group, entries] of Object.entries(GROUPS)) {
    if (entries.length === 0) {
      throw new Error(`Capture manifest group "${group}" is empty — remove it or fill it.`);
    }

    for (const entry of entries) {
      assertEntryIsWellFormed(entry, group);
      if (seen.has(entry.id)) {
        fail(entry.id, "duplicate id — ids are the lane's stable API and must be unique");
      }
      seen.add(entry.id);
      all.push(entry);
    }
  }

  return all;
}

/**
 * Every documented gap, in group order. Validated against the state list, so a
 * gap can never claim a surface the lane actually shoots.
 */
function buildGaps(states: StateEntry[]): CaptureGap[] {
  const capturedIds = new Set(states.map((entry) => entry.id));
  const all: CaptureGap[] = [];
  const seen = new Set<string>();

  for (const group of Object.keys(GROUPS)) {
    const gaps = GAPS[group];
    if (!gaps) {
      throw new Error(
        `Capture manifest group "${group}" declares no gaps array. Export a \`${group}Gaps\` — `
          + "an empty array is the claim that the group is complete, and that claim has to be made on purpose.",
      );
    }

    for (const gap of gaps) {
      if (gap.group !== group) {
        fail(gap.id, `gap group is "${gap.group}" but it is registered under "${group}"`);
      }
      if (!gap.id.startsWith(`${group}.`)) {
        fail(gap.id, `gap id must be prefixed with its group ("${group}.")`);
      }
      if (capturedIds.has(gap.id)) {
        fail(gap.id, "is declared as an uncaptured gap but a state with that id IS captured");
      }
      if (seen.has(gap.id)) {
        fail(gap.id, "duplicate gap id");
      }
      if (gap.reason.trim().length === 0) {
        fail(gap.id, "a gap without a reason is an excuse — say what makes it unreachable");
      }
      seen.add(gap.id);
      all.push(gap);
    }
  }

  return all;
}

/** Every entry, in group order. Validated at module load. */
export const allStates: StateEntry[] = buildManifest();

/** Every state the lane knowingly does not capture. Validated at module load. */
export const allGaps: CaptureGap[] = buildGaps(allStates);

/** The group names the manifest currently declares. */
export const manifestGroups: string[] = Object.keys(GROUPS);

/** Documented gaps for one group; throws on an unknown group, like manifestFor. */
export function gapsFor(group: string): CaptureGap[] {
  const gaps = GAPS[group];
  if (!gaps) {
    throw new Error(
      `Unknown capture manifest group "${group}". Known groups: ${manifestGroups.join(", ")}`,
    );
  }
  return gaps;
}

/** Entries for one group; throws on an unknown group so typos fail loudly. */
export function manifestFor(group: string): StateEntry[] {
  const entries = GROUPS[group];
  if (!entries) {
    throw new Error(
      `Unknown capture manifest group "${group}". Known groups: ${manifestGroups.join(", ")}`,
    );
  }
  return entries;
}
