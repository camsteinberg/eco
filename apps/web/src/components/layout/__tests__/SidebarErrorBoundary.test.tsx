// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SidebarErrorBoundary } from "../SidebarErrorBoundary";

// A child component that throws on demand
let shouldThrow = false;

function ThrowingChild() {
  if (shouldThrow) {
    throw new Error("Sidebar crashed!");
  }
  return <div data-testid="sidebar-content">Sidebar content</div>;
}

describe("SidebarErrorBoundary", () => {
  beforeEach(() => {
    shouldThrow = false;
    // Silence React error boundary console.error noise in test output
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders children when no error occurs", () => {
    render(
      <SidebarErrorBoundary>
        <ThrowingChild />
      </SidebarErrorBoundary>
    );

    expect(screen.getByTestId("sidebar-content")).toBeDefined();
    expect(screen.getByText("Sidebar content")).toBeDefined();
  });

  it('shows a person-first recovery message and button when child throws', () => {
    shouldThrow = true;

    render(
      <SidebarErrorBoundary>
        <ThrowingChild />
      </SidebarErrorBoundary>
    );

    expect(screen.queryByTestId("sidebar-content")).toBeNull();
    expect(screen.getByText("Show my chats")).toBeDefined();
    expect(
      screen.getByText("Your chats are safe \u2014 this list didn't load.")
    ).toBeDefined();
    // The copy speaks to the person; it never names an internal component.
    expect(screen.queryByText(/sidebar/i)).toBeNull();
  });

  it('clicking the recovery button resets and renders children again', () => {
    shouldThrow = true;

    render(
      <SidebarErrorBoundary>
        <ThrowingChild />
      </SidebarErrorBoundary>
    );

    expect(screen.getByText("Show my chats")).toBeDefined();

    // Stop throwing so re-render succeeds
    shouldThrow = false;

    fireEvent.click(screen.getByText("Show my chats"));

    expect(screen.getByTestId("sidebar-content")).toBeDefined();
    expect(screen.queryByText("Show my chats")).toBeNull();
  });
});
