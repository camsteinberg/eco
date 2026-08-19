// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allGaps,
  allStates,
  gapsFor,
  KNOWN_HARNESS_KEYS,
  KNOWN_ROUTE_PARAMS,
  manifestFor,
  manifestGroups,
} from "../../e2e-capture/manifest";

/**
 * The capture manifest's invariants, enforced in the unit gate.
 *
 * `manifest/index.ts` already throws on a malformed entry at module load, so
 * importing it here is itself half the test — a bad entry fails this file
 * before a single assertion runs. The rest pins the properties that make a
 * capture run reviewable rather than merely large.
 */
describe("capture manifest", () => {
  it("loads without tripping its own invariant guards", () => {
    expect(allStates.length).toBeGreaterThan(0);
  });

  it("declares no empty groups", () => {
    for (const group of manifestGroups) {
      expect(manifestFor(group).length, `group "${group}" is empty`).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown group loudly instead of returning nothing", () => {
    expect(() => manifestFor("no-such-group")).toThrow(/Unknown capture manifest group/);
  });

  it("gives every state a unique, group-prefixed, dotted id", () => {
    const ids = allStates.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const entry of allStates) {
      expect(entry.id, `${entry.id} must be lowercase dotted`).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      expect(entry.id.startsWith(`${entry.group}.`), `${entry.id} must start with its group`).toBe(true);
    }
  });

  it("proves every state with at least one assertion", () => {
    for (const entry of allStates) {
      expect(entry.assert.length, `${entry.id} has no assertions`).toBeGreaterThan(0);
    }
  });

  it("requires a selector for element captures and a prepare() for micro states", () => {
    for (const entry of allStates) {
      if (entry.capture?.mode === "element") {
        expect(entry.capture.selector, `${entry.id} is element-mode without a selector`).toBeTruthy();
      }
      if (entry.tier === "micro") {
        expect(entry.prepare, `${entry.id} is a micro state without prepare()`).toBeTypeOf("function");
      }
    }
  });

  it("only uses search params the validation harness actually reads", () => {
    // vitest runs with cwd = apps/web.
    const harnessSource = readFileSync(resolve(process.cwd(), "src/lib/validation-harness.ts"), "utf8");

    for (const key of KNOWN_HARNESS_KEYS) {
      // Slot-scoped knobs are read through a template literal
      // (`eco-validation-slot-${slot}`), so the per-slot name never appears
      // verbatim — match the template's literal prefix for those.
      const literalPrefix = key.replace(/(eco-fast|eco-smart)$/, "");
      const isRead = harnessSource.includes(key) || harnessSource.includes(literalPrefix);
      expect(isRead, `KNOWN_HARNESS_KEYS lists "${key}" but validation-harness.ts never reads it`).toBe(true);
    }
  });

  it("keeps entry search strings inside the known-key set", () => {
    for (const entry of allStates) {
      if (!entry.search) continue;
      for (const key of new URLSearchParams(entry.search).keys()) {
        const known = KNOWN_HARNESS_KEYS.has(key) || KNOWN_ROUTE_PARAMS.has(key);
        expect(known, `${entry.id} uses unknown search param "${key}"`).toBe(true);
      }
    }
  });
});

/**
 * The gap list is the inventory's own honesty check, so it gets the same
 * treatment as the states: it has to load, it has to be unique, and it must not
 * claim a surface the lane actually photographs.
 */
describe("capture manifest gaps", () => {
  it("makes every group declare its gaps, empty or not", () => {
    for (const group of manifestGroups) {
      expect(() => gapsFor(group), `group "${group}" declares no gaps array`).not.toThrow();
    }
  });

  it("rejects an unknown group loudly", () => {
    expect(() => gapsFor("no-such-group")).toThrow(/Unknown capture manifest group/);
  });

  it("gives every gap a unique, group-prefixed id and a real reason", () => {
    const ids = allGaps.map((gap) => gap.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const gap of allGaps) {
      expect(gap.id.startsWith(`${gap.group}.`), `${gap.id} must start with its group`).toBe(true);
      expect(gap.surface.trim().length, `${gap.id} has no surface`).toBeGreaterThan(0);
      // A one-liner here would defeat the point: the reason is what lets a
      // later reader re-check the claim instead of taking it on trust.
      expect(gap.reason.trim().length, `${gap.id}'s reason is too thin to verify`).toBeGreaterThan(40);
    }
  });

  it("never declares a gap for a state that is actually captured", () => {
    const capturedIds = new Set(allStates.map((entry) => entry.id));
    for (const gap of allGaps) {
      expect(capturedIds.has(gap.id), `${gap.id} is declared a gap but is in the manifest`).toBe(false);
    }
  });
});
