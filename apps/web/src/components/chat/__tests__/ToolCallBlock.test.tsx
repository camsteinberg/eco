// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallBlock } from "../ToolCallBlock";

describe("ToolCallBlock", () => {
  it("renders tool display name", () => {
    render(<ToolCallBlock name="calculator" status="complete" />);
    expect(screen.getByText("Calculator")).toBeTruthy();
  });

  it("renders web_search display name", () => {
    render(<ToolCallBlock name="web_search" status="complete" />);
    expect(screen.getByText("Web Search")).toBeTruthy();
  });

  it("is expanded when running", () => {
    render(
      <ToolCallBlock
        name="calculator"
        status="running"
        input={{ expression: "2+2" }}
      />
    );
    // Should show input when expanded
    expect(screen.getByText(/expression/)).toBeTruthy();
  });

  it("is collapsed by default when complete", () => {
    render(
      <ToolCallBlock
        name="calculator"
        status="complete"
        input={{ expression: "2+2" }}
        output="4"
      />
    );
    // Input should not be visible when collapsed
    expect(screen.queryByText(/expression/)).toBeNull();
  });

  it("toggles expand/collapse on click", () => {
    render(
      <ToolCallBlock
        name="calculator"
        status="complete"
        input={{ expression: "2+2" }}
        output="4"
      />
    );

    // Initially collapsed
    expect(screen.queryByText(/expression/)).toBeNull();

    // Click to expand
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/expression/)).toBeTruthy();

    // Click to collapse
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText(/expression/)).toBeNull();
  });

  it("shows output when expanded", () => {
    render(
      <ToolCallBlock
        name="calculator"
        status="running"
        input={{ expression: "2+2" }}
        output="4"
      />
    );
    expect(screen.getByText(/4/)).toBeTruthy();
  });

  it("sets aria-expanded attribute", () => {
    render(<ToolCallBlock name="calculator" status="running" />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders error status", () => {
    render(
      <ToolCallBlock
        name="calculator"
        status="error"
        output="Expression error"
      />
    );
    expect(screen.getByText("Calculator")).toBeTruthy();
  });

  it("collapses to the quiet summary when the call settles (running → complete)", () => {
    // A block that mounts during "running" opens expanded; once the call
    // settles it must fold back to the calm headline instead of leaving raw
    // args JSON open in the conversation (audit 2026-06-09 RC8).
    const { rerender } = render(
      <ToolCallBlock name="calculator" status="running" input={{ expression: "2+2" }} />
    );
    expect(screen.getByText(/expression/)).toBeTruthy();

    rerender(
      <ToolCallBlock name="calculator" status="complete" input={{ expression: "2+2" }} output="4" />
    );
    expect(screen.queryByText(/expression/)).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves the user's manual expansion alone when the call settles", () => {
    const { rerender } = render(
      <ToolCallBlock
        name="calculator"
        status="running"
        defaultCollapsed
        input={{ expression: "2+2" }}
      />
    );
    // force-collapsed while running; the user opens it by hand.
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/expression/)).toBeTruthy();

    rerender(
      <ToolCallBlock
        name="calculator"
        status="complete"
        defaultCollapsed
        input={{ expression: "2+2" }}
        output="4"
      />
    );
    // The settle transition must NOT override the user's explicit choice.
    expect(screen.getByText(/expression/)).toBeTruthy();
  });

  it("renders the friendly summary as a quiet headline label, not raw JSON", () => {
    render(
      <ToolCallBlock
        name="unit-conversion"
        status="complete"
        input={{ family: "length", from: "mi", to: "km", value: 5 }}
        output="5 mi = 8.0467 km"
        summary="5 miles → kilometers"
      />
    );
    // Display name + friendly summary appear in the collapsed headline.
    expect(screen.getByText("Unit conversion")).toBeTruthy();
    expect(screen.getByText("5 miles → kilometers")).toBeTruthy();
    // Raw args JSON is NOT shown in the collapsed headline.
    expect(screen.queryByText(/"family"/)).toBeNull();
  });

  it("keeps raw input in the expanded detail only (transparency)", () => {
    render(
      <ToolCallBlock
        name="unit-conversion"
        status="complete"
        input={{ family: "length", from: "mi", to: "km", value: 5 }}
        output="5 mi = 8.0467 km"
        summary="5 miles → kilometers"
      />
    );
    // Collapsed by default when complete — raw input hidden.
    expect(screen.queryByText(/Input:/)).toBeNull();
    // Expand → raw input becomes available.
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/Input:/)).toBeTruthy();
    expect(screen.getByText(/family/)).toBeTruthy();
  });

  it("falls back to the tool name alone when no summary is provided", () => {
    render(<ToolCallBlock name="calculator" status="complete" output="391" />);
    expect(screen.getByText("Calculator")).toBeTruthy();
  });

  it("renders code_execution tool calls as disabled inert code, not runnable artifacts", () => {
    const { container } = render(
      <ToolCallBlock
        name="code_execution"
        status="complete"
        input={{ language: "html", code: "<button onclick='alert(1)'>Run</button>" }}
        output="Local code execution is disabled"
      />,
    );

    expect(screen.getByRole("group", { name: /disabled code execution tool call/i })).toBeTruthy();
    expect(screen.getByText(/Code execution is disabled in Eco web v1.0/i)).toBeTruthy();
    expect(screen.getByText("<button onclick='alert(1)'>Run</button>")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run code/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview tab/i })).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
