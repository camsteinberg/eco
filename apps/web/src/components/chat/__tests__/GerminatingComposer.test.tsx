// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { GerminatingComposer } from "../GerminatingComposer";

describe("GerminatingComposer", () => {
  it("renders a disabled composer with the germinating placeholder by default", () => {
    render(<GerminatingComposer />);
    const input = screen.getByPlaceholderText(
      "Eco is getting ready on this device…",
    );
    expect(input).toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("aria-disabled", "true");
  });

  it("shows the seedling and no send button while germinating", () => {
    render(<GerminatingComposer ready={false} />);
    // The send slot is the seedling (decorative) — no interactive send yet, so
    // there is no way to submit early.
    expect(
      screen.queryByRole("button", { name: /send message/i }),
    ).not.toBeInTheDocument();
  });

  it("announces readiness politely via a status region", () => {
    const { rerender } = render(<GerminatingComposer ready={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Eco is getting ready");
    rerender(<GerminatingComposer ready />);
    expect(screen.getByRole("status")).toHaveTextContent("Eco is ready");
  });

  it("swaps to the live composer when ready (send button + live placeholder)", () => {
    render(<GerminatingComposer ready />);
    expect(screen.getByPlaceholderText("Ask Eco anything...")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /send message/i }),
    ).toBeInTheDocument();
    // Even when ready, this stand-in never sends — the live ChatInput does.
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
    expect(
      screen.queryByPlaceholderText(/getting ready on this device/i),
    ).not.toBeInTheDocument();
  });
});
