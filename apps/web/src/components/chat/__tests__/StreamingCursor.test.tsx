// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StreamingCursor } from "../StreamingCursor";

describe("StreamingCursor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing when phase is 'idle'", () => {
    const { container } = render(<StreamingCursor phase="idle" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders three pulsing dots when phase is 'thinking'", () => {
    render(<StreamingCursor phase="thinking" />);
    const cursor = screen.getByTestId("streaming-cursor");
    expect(cursor).toBeTruthy();
    expect(cursor.getAttribute("data-breathing")).toBe("true");
    // Three dot elements
    const dots = cursor.querySelectorAll("span.rounded-full");
    expect(dots.length).toBe(3);
    // Should have sr-only label
    expect(screen.getByText("Thinking...")).toBeTruthy();
  });

  it("renders a simple blinking caret bar when phase is 'generating'", () => {
    render(<StreamingCursor phase="generating" />);
    const cursor = screen.getByTestId("streaming-cursor");
    expect(cursor).toBeTruthy();
    expect(cursor.getAttribute("data-generating")).toBe("true");
    // No three-dot structure
    const dots = cursor.querySelectorAll("span.rounded-full");
    expect(dots.length).toBe(0);
    // A simple caret bar affordance
    const bar = cursor.querySelector("span.rounded-sm");
    expect(bar).toBeTruthy();
    // No decorative leaf/svg — kept clean to avoid clutter
    expect(cursor.querySelector("svg")).toBeNull();
    expect(screen.getByText("Generating...")).toBeTruthy();
  });

  it("renders seedling SVG icon with Motion v12 animation when phase is 'tool-executing'", () => {
    render(<StreamingCursor phase="tool-executing" />);
    const cursor = screen.getByTestId("streaming-cursor");
    expect(cursor).toBeTruthy();
    // Should have data-tool-executing attribute
    expect(cursor.getAttribute("data-tool-executing")).toBe("true");
    // Should contain an SVG seedling
    const svg = cursor.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    // Should have sr-only label (single source of accessible name)
    expect(screen.getByText("Running tool...")).toBeTruthy();
  });

  it("renders the calm loading indicator (seed + halo) when phase is 'loading'", () => {
    // Cold-load window (#4 W3a): a distinct botanical "warming up" motif, not the
    // staccato thinking dots, so the residual model-load wait reads honestly.
    render(<StreamingCursor phase="loading" />);
    const cursor = screen.getByTestId("streaming-cursor");
    expect(cursor).toBeTruthy();
    expect(cursor.getAttribute("data-loading")).toBe("true");
    // Distinct from the thinking dots: not the three-dot structure.
    expect(cursor.querySelectorAll("span.rounded-full").length).not.toBe(3);
    // Uses the eco-accent family (seed) — no hardcoded color.
    expect(
      cursor.querySelector("[class*='bg-[var(--eco-accent)]']"),
    ).toBeTruthy();
    // Single accessible label, truthful + jargon-free.
    expect(screen.getByText("Preparing model...")).toBeTruthy();
  });

  it("loading indicator degrades to a static element under prefers-reduced-motion", () => {
    // Motion's useReducedMotion reads matchMedia; force reduce-motion on.
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("reduce"),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    // Still renders the indicator + its accessible label (the animation is the
    // only thing suppressed; structure is unchanged so the static state is calm).
    render(<StreamingCursor phase="loading" />);
    const cursor = screen.getByTestId("streaming-cursor");
    expect(cursor.getAttribute("data-loading")).toBe("true");
    expect(screen.getByText("Preparing model...")).toBeTruthy();
  });

  it("renders three dots in thinking state when phase is 'queued'", () => {
    render(<StreamingCursor phase="queued" />);
    const cursor = screen.getByTestId("streaming-cursor");
    expect(cursor).toBeTruthy();
    expect(cursor.getAttribute("data-breathing")).toBe("true");
    expect(cursor.querySelectorAll("span.rounded-full").length).toBe(3);
  });

  it("renders generating cursor bar when phase is omitted", () => {
    render(<StreamingCursor />);
    const cursor = screen.getByTestId("streaming-cursor");
    expect(cursor).toBeTruthy();
    expect(cursor.getAttribute("data-generating")).toBe("true");
  });

  it("hard-swaps between thinking and generating (different elements, no morph continuity)", () => {
    const { rerender, container } = render(
      <StreamingCursor phase="thinking" />,
    );
    // Thinking: three dots present
    const thinkingEl = container.querySelector("[data-breathing]");
    expect(thinkingEl).toBeTruthy();
    const dotsBefore = container.querySelectorAll("span.rounded-full");
    expect(dotsBefore.length).toBe(3);

    // Transition to generating: dots gone, bar appears
    rerender(<StreamingCursor phase="generating" />);
    const generatingEl = container.querySelector("[data-generating]");
    expect(generatingEl).toBeTruthy();
    const dotsAfter = container.querySelectorAll("span.rounded-full");
    expect(dotsAfter.length).toBe(0);
    const bar = container.querySelector("span.rounded-sm");
    expect(bar).toBeTruthy();

    // No morph-state attributes remain
    expect(container.querySelector("[data-morph-state]")).toBeNull();
  });

  it("uses eco-accent color for both thinking dots and generating bar", () => {
    const { container: thinkingContainer } = render(
      <StreamingCursor phase="thinking" />,
    );
    const thinkingDots = thinkingContainer.querySelectorAll(
      "[class*='bg-[var(--eco-accent)]']",
    );
    expect(thinkingDots.length).toBe(3);

    const { container: genContainer } = render(
      <StreamingCursor phase="generating" />,
    );
    const genBar = genContainer.querySelector(
      "[class*='bg-[var(--eco-accent)]']",
    );
    expect(genBar).toBeTruthy();
  });

  it("uses data attributes for all animated phases", () => {
    const { container: thinkingContainer } = render(
      <StreamingCursor phase="thinking" />,
    );
    expect(
      thinkingContainer.querySelector("[data-breathing='true']"),
    ).toBeTruthy();

    const { container: genContainer } = render(
      <StreamingCursor phase="generating" />,
    );
    expect(
      genContainer.querySelector("[data-generating='true']"),
    ).toBeTruthy();

    const { container: toolContainer } = render(
      <StreamingCursor phase="tool-executing" />,
    );
    expect(
      toolContainer.querySelector("[data-tool-executing='true']"),
    ).toBeTruthy();
  });
});
