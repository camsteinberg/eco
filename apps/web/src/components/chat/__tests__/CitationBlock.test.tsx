// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Citation } from "../../../lib/citation-parser";

// useReducedMotion is read inside the component; expose a mutable flag so a single
// test can flip it without a separate module factory.
const reducedMotion = { value: false };

// Render Motion elements as plain DOM, stripping motion-only props so jsdom
// doesn't warn about unknown attributes. Mirrors the MessageBubble test pattern.
vi.mock("motion/react", () => {
  const makeComponent = (tag: string) => {
    const Component = (props: Record<string, unknown>) => {
      // Drop motion-only props so jsdom doesn't warn about unknown attributes.
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

import { CitationBlock } from "../CitationBlock";

function groundingCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    id: 1,
    title: "Photosynthesis",
    url: "https://en.wikipedia.org/wiki/Photosynthesis",
    source: "Wikipedia",
    asOf: "2023",
    ...overrides,
  };
}

describe("CitationBlock", () => {
  afterEach(() => {
    reducedMotion.value = false;
    vi.clearAllMocks();
  });

  it("renders nothing with no citations", () => {
    const { container } = render(<CitationBlock citations={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the grounding chip for a sourced citation", () => {
    const { getByTestId } = render(
      <CitationBlock
        citations={[
          {
            id: 1,
            title: "Paris",
            url: "https://en.wikipedia.org/wiki/Paris",
            source: "Wikipedia",
            asOf: "2023",
          },
        ]}
      />,
    );
    expect(getByTestId("grounding-citation")).toBeTruthy();
  });

  it("renders the grounding chip for a single sourced citation", () => {
    render(<CitationBlock citations={[groundingCitation()]} />);

    const chip = screen.getByTestId("grounding-citation");
    expect(chip).toBeInTheDocument();
    // It's a link to the article, opening in a new tab safely.
    expect(chip.tagName).toBe("A");
    expect(chip).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Photosynthesis",
    );
    expect(chip).toHaveAttribute("target", "_blank");
    expect(chip).toHaveAttribute("rel", "noopener noreferrer");

    // Source name and the "as of" trust signal are both shown.
    expect(chip).toHaveTextContent("Wikipedia");
    expect(chip).toHaveTextContent("as of 2023");

    // Accessible name describes the source + that it opens a new tab.
    expect(
      screen.getByRole("link", {
        name: "Source: Wikipedia, as of 2023 (opens in a new tab)",
      }),
    ).toBe(chip);

    // The leaf glyph is decorative.
    const leaf = chip.querySelector("svg");
    expect(leaf).toBeTruthy();
    expect(leaf).toHaveAttribute("aria-hidden", "true");
  });

  it("omits the 'as of' segment when asOf is absent", () => {
    render(
      <CitationBlock citations={[groundingCitation({ asOf: undefined })]} />,
    );

    const chip = screen.getByTestId("grounding-citation");
    expect(chip).toHaveTextContent("Wikipedia");
    expect(chip).not.toHaveTextContent("as of");
    // Accessible name drops the date too.
    expect(chip).toHaveAttribute(
      "aria-label",
      "Source: Wikipedia (opens in a new tab)",
    );
  });

  it("renders nothing for a source-less citation (dead research path removed)", () => {
    const { container } = render(
      <CitationBlock
        citations={[{ id: 1, title: "Parsed source", url: "https://example.com/x" }]}
      />,
    );

    // The dead research/sources-list path is gone — a source-less citation renders nothing.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("grounding-citation")).not.toBeInTheDocument();
  });

  it("still renders the chip under prefers-reduced-motion", () => {
    reducedMotion.value = true;
    render(<CitationBlock citations={[groundingCitation()]} />);

    const chip = screen.getByTestId("grounding-citation");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("Wikipedia");
    expect(chip).toHaveTextContent("as of 2023");
  });
});

// ── Web search chip ────────────────────────────────────────────────────────
// A searched turn must be legible AS a searched turn: the time the sources were
// read (the host states it — a small local model cannot date its own answer) and
// every title it read, as a link the person can check.

const FETCHED_AT = "2026-09-11T18:05:00.000Z";

function webCitation(index: number, overrides: Partial<Citation> = {}): Citation {
  return {
    id: index + 1,
    title: `Result ${String(index + 1)}`,
    url: `https://example-${String(index + 1)}.test/page`,
    source: "Web search",
    asOf: FETCHED_AT,
    ...overrides,
  };
}

describe("CitationBlock — web search", () => {
  afterEach(() => {
    reducedMotion.value = false;
  });

  it("names the fetch time and the number of sources", () => {
    const { getByTestId } = render(
      <CitationBlock citations={[webCitation(0), webCitation(1), webCitation(2)]} />,
    );

    const chip = getByTestId("web-search-citation");
    const localTime = new Date(FETCHED_AT).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(chip).toHaveTextContent(`Searched the web at ${localTime} · 3 sources`);
    // The ISO instant travels verbatim for anything reading the DOM.
    expect(chip).toHaveAttribute("data-fetched-at", FETCHED_AT);
  });

  it("says 'source' for a single result", () => {
    const { getByTestId } = render(<CitationBlock citations={[webCitation(0)]} />);
    expect(getByTestId("web-search-citation")).toHaveTextContent("· 1 source");
  });

  it("links every title out safely", () => {
    render(<CitationBlock citations={[webCitation(0), webCitation(1)]} />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "https://example-1.test/page");
    expect(links[1]).toHaveAttribute("href", "https://example-2.test/page");
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getByText("Result 1")).toBeTruthy();
  });

  it("drops the time rather than invent one when `asOf` is unusable", () => {
    const { getByTestId } = render(
      <CitationBlock citations={[webCitation(0, { asOf: "not a date" })]} />,
    );
    const chip = getByTestId("web-search-citation");
    expect(chip).toHaveTextContent("Searched the web · 1 source");
    expect(chip).not.toHaveAttribute("data-fetched-at", "");
  });

  it("never renders the grounding chip for a searched turn", () => {
    render(<CitationBlock citations={[webCitation(0)]} />);
    expect(screen.queryByTestId("grounding-citation")).toBeNull();
  });

  it("keeps the grounding chip for a grounded turn", () => {
    const { getByTestId } = render(<CitationBlock citations={[groundingCitation()]} />);
    expect(getByTestId("grounding-citation")).toBeTruthy();
    expect(screen.queryByTestId("web-search-citation")).toBeNull();
  });
});
