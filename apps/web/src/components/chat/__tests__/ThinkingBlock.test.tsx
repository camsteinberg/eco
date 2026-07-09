// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThinkingBlock } from "../ThinkingBlock";

describe("ThinkingBlock", () => {
  it("renders thinking content with collapsed state by default", () => {
    render(<ThinkingBlock content="Let me reason about this..." />);
    // Should show the toggle but content area should be hidden
    expect(screen.getByTestId("thinking-toggle")).toBeTruthy();
    // The content text should not be visible (overflow hidden + height 0)
    const contentArea = screen.getByTestId("thinking-content");
    expect(contentArea.getAttribute("data-collapsed")).toBe("true");
  });

  it("expands on click to show full content", () => {
    render(<ThinkingBlock content="My reasoning step by step" />);
    const toggle = screen.getByTestId("thinking-toggle");
    fireEvent.click(toggle);
    const contentArea = screen.getByTestId("thinking-content");
    expect(contentArea.getAttribute("data-collapsed")).toBe("false");
  });

  it("shows 'Thinking...' label when collapsed", () => {
    render(<ThinkingBlock content="Some reasoning" />);
    expect(screen.getByText("Thinking...")).toBeTruthy();
  });

  it("has accessible button with aria-expanded", () => {
    render(<ThinkingBlock content="My reasoning" />);
    const toggle = screen.getByTestId("thinking-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
