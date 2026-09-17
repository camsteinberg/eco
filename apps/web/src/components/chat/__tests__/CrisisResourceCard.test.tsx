// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CrisisResourceCard } from "../CrisisResourceCard";

describe("CrisisResourceCard", () => {
  it("renders the four support lines as a labelled note", () => {
    render(<CrisisResourceCard />);

    const card = screen.getByRole("note", { name: "Support resources" });
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent(
      /you deserve support right now/i,
    );
    expect(card).toHaveTextContent(/Suicide & Crisis Lifeline/i);
    expect(card).toHaveTextContent(/lists free, confidential lines by country/i);
    expect(card).toHaveTextContent(/call your local emergency number/i);
  });

  it("links the two helplines so they open safely in a new tab", () => {
    render(<CrisisResourceCard />);

    const lifeline = screen.getByRole("link", { name: "988" });
    expect(lifeline).toHaveAttribute("href", "https://988lifeline.org");
    expect(lifeline).toHaveAttribute("target", "_blank");
    expect(lifeline).toHaveAttribute("rel", "noopener noreferrer");

    const directory = screen.getByRole("link", { name: "findahelpline.com" });
    expect(directory).toHaveAttribute("href", "https://findahelpline.com");
    expect(directory).toHaveAttribute("target", "_blank");
    expect(directory).toHaveAttribute("rel", "noopener noreferrer");
  });
});
