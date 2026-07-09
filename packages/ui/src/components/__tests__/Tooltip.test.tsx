// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Tooltip } from "../Tooltip";

// Radix Tooltip uses ResizeObserver and portals
beforeAll(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
});

describe("Tooltip", () => {
  it("renders children", () => {
    render(
      <Tooltip content="Tooltip text">
        <button>Hover me</button>
      </Tooltip>,
    );
    expect(screen.getByText("Hover me")).toBeInTheDocument();
  });

  it("does not show tooltip content initially", () => {
    render(
      <Tooltip content="Secret info">
        <button>Trigger</button>
      </Tooltip>,
    );
    // Radix Tooltip renders content in a portal only on trigger
    expect(screen.queryByText("Secret info")).not.toBeInTheDocument();
  });

  it("trigger has correct data-state attribute", () => {
    render(
      <Tooltip content="Test">
        <button>Trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByText("Trigger");
    expect(trigger).toHaveAttribute("data-state", "closed");
  });

  it("renders with custom side offset", () => {
    render(
      <Tooltip content="Offset tooltip" sideOffset={16}>
        <button>Target</button>
      </Tooltip>,
    );
    expect(screen.getByText("Target")).toBeInTheDocument();
  });

  it("accepts different side positions", () => {
    const { rerender } = render(
      <Tooltip content="Side test" side="bottom">
        <button>Target</button>
      </Tooltip>,
    );
    expect(screen.getByText("Target")).toBeInTheDocument();

    rerender(
      <Tooltip content="Side test" side="left">
        <button>Target</button>
      </Tooltip>,
    );
    expect(screen.getByText("Target")).toBeInTheDocument();
  });
});
