// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WhyEcoCard } from "../WhyEcoCard";

describe("WhyEcoCard", () => {
  it("renders three quiet brand cues", () => {
    render(<WhyEcoCard />);
    expect(screen.getByText("Private")).toBeDefined();
    expect(screen.getByText("On-device")).toBeDefined();
    expect(screen.getByText("Waterless")).toBeDefined();
  });

  it("each pillar has a brief description", () => {
    render(<WhyEcoCard />);
    expect(
      screen.getByText("Local chats stay in this browser")
    ).toBeDefined();
    expect(
      screen.getByText("The model runs on your machine, not a server")
    ).toBeDefined();
    expect(
      screen.getByText("Designed to avoid data-center water waste")
    ).toBeDefined();
  });

  it('includes a "Read the methodology" link pointing to /impact', () => {
    render(<WhyEcoCard />);
    const link = screen.getByRole("link", { name: /read the methodology/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("/impact");
  });

  it("stays quiet through type and colour, never a blanket opacity", () => {
    // A wrapper opacity dims the text tokens along with everything else, which
    // put the descriptions under AA (4.36:1) and cost the titles three points
    // of contrast. The block reads quiet from its own small type and muted
    // colour instead.
    const { container } = render(<WhyEcoCard />);
    for (const el of container.querySelectorAll("*")) {
      // getAttribute, not className: the pillar icons are SVG elements, whose
      // className is an SVGAnimatedString rather than a string.
      expect(el.getAttribute("class") ?? "").not.toMatch(/\bopacity-\d/);
    }
  });

  it("does not read from localStorage (no onboarding gating)", () => {
    // WhyEcoCard should render unconditionally -- no localStorage access
    localStorage.clear();
    const { container } = render(<WhyEcoCard />);
    expect(container.textContent).toContain("Private");
    expect(container.textContent).toContain("On-device");
    expect(container.textContent).toContain("Waterless");
  });
});
