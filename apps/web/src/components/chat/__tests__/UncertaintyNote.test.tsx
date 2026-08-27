// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// useReducedMotion is read inside the component; expose a mutable flag so a single
// test can flip it without a separate module factory. Mirrors the CitationBlock test.
const reducedMotion = { value: false };

// Render Motion elements as plain DOM, stripping motion-only props so jsdom doesn't
// warn about unknown attributes.
vi.mock("motion/react", () => {
  const makeComponent = (tag: string) => {
    const Component = (props: Record<string, unknown>) => {
      const {
        children,
        initial: _i,
        animate: _a,
        exit: _e,
        transition: _t,
        whileHover: _wh,
        whileTap: _wt,
        variants: _v,
        layout: _l,
        ...rest
      } = props;
      return createElement(tag, rest, children as ReactNode);
    };
    Component.displayName = `motion.${tag}`;
    return Component;
  };
  const motion = new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      target[prop] ??= makeComponent(prop);
      return target[prop];
    },
  });
  return {
    motion,
    useReducedMotion: () => reducedMotion.value,
  };
});

import { UncertaintyNote } from "../UncertaintyNote";

describe("UncertaintyNote", () => {
  afterEach(() => {
    reducedMotion.value = false;
    vi.clearAllMocks();
  });

  it("renders the unverified copy and is an accessible note", () => {
    render(<UncertaintyNote status="unverified" />);

    const note = screen.getByTestId("uncertainty-note");
    expect(note).toBeInTheDocument();
    // role="note" + a descriptive aria-label so assistive tech announces the caveat.
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveAttribute(
      "aria-label",
      "Unverified: Eco couldn’t confirm this against a source",
    );

    // Copy speaks to the user's concern (reliability), in plain warm language —
    // the status alone, with no instruction to go verify elsewhere (Cam, 2026-08-07:
    // the "worth a quick double-check" clause handed the user homework).
    expect(note).toHaveTextContent(/couldn.t confirm this against a source/i);
    expect(note).not.toHaveTextContent(/double-check/i);
  });

  it("renders the lookups-off copy: answered from memory, not checked", () => {
    render(<UncertaintyNote status="lookups-off" />);

    const note = screen.getByTestId("uncertainty-note");
    expect(note).toHaveAttribute("data-status", "lookups-off");
    expect(note).toHaveAttribute(
      "aria-label",
      "From memory: web lookups are off, so this wasn’t checked against a source",
    );
    expect(note).toHaveTextContent(/from memory/i);
    expect(note).toHaveTextContent(/not checked against a source/i);
    // Points the user at the setting that changes this, without homework.
    expect(note).toHaveTextContent(/web lookups are off/i);
  });

  it("renders the distinct unreachable (transient) copy", () => {
    render(<UncertaintyNote status="unreachable" />);

    const note = screen.getByTestId("uncertainty-note");
    // Transient state gets a state-accurate prefix ("Couldn’t verify"), not a flat
    // "Unverified" verdict (which is the epistemic, no-source-confirmed case).
    expect(note).toHaveAttribute(
      "aria-label",
      "Couldn’t verify: Eco couldn’t reach its sources to check this just now",
    );
    // "couldn't reach … just now" reads as transient/retryable — distinct from
    // "no source confirmed it".
    expect(note).toHaveTextContent(/couldn.t reach its sources/i);
    expect(note).toHaveTextContent(/just now/i);
    // Not the unverified string.
    expect(note).not.toHaveTextContent(/confirm this against a source/i);
  });

  it("carries no internal jargon in the user-facing copy", () => {
    // Principle (Cam): write what the user wants (reliability), not the architecture.
    render(<UncertaintyNote status="unverified" />);
    const note = screen.getByTestId("uncertainty-note");
    expect(note).not.toHaveTextContent(
      /wikipedia|wikidata|open-meteo|hedge|grounding|source-routing/i,
    );
  });

  it("marks the botanical glyph as decorative", () => {
    render(<UncertaintyNote status="unverified" />);
    const note = screen.getByTestId("uncertainty-note");
    const sprout = note.querySelector("svg");
    expect(sprout).toBeTruthy();
    expect(sprout?.parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("still renders under prefers-reduced-motion", () => {
    reducedMotion.value = true;
    render(<UncertaintyNote status="unreachable" />);

    const note = screen.getByTestId("uncertainty-note");
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent(/couldn.t reach its sources/i);
  });
});
