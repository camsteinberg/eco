// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WhyEcoCard } from "../WhyEcoCard";

describe("WhyEcoCard", () => {
  it("renders three quiet brand cues", () => {
    render(<WhyEcoCard />);
    expect(screen.getByText("Private")).toBeDefined();
    expect(screen.getByText("Decentralized")).toBeDefined();
    expect(screen.getByText("Waterless")).toBeDefined();
  });

  it("each pillar has a brief description", () => {
    render(<WhyEcoCard />);
    expect(
      screen.getByText("Local chats stay in this browser")
    ).toBeDefined();
    expect(
      screen.getByText("Built for people-powered AI")
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

  it("does not read from localStorage (no onboarding gating)", () => {
    // WhyEcoCard should render unconditionally -- no localStorage access
    localStorage.clear();
    const { container } = render(<WhyEcoCard />);
    expect(container.textContent).toContain("Private");
    expect(container.textContent).toContain("Decentralized");
    expect(container.textContent).toContain("Waterless");
  });
});
