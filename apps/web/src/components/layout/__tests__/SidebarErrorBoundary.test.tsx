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

  it('shows "Reload sidebar" button when child throws', () => {
    shouldThrow = true;

    render(
      <SidebarErrorBoundary>
        <ThrowingChild />
      </SidebarErrorBoundary>
    );

    expect(screen.queryByTestId("sidebar-content")).toBeNull();
    expect(screen.getByText("Reload sidebar")).toBeDefined();
    expect(screen.getByText("Sidebar encountered an error")).toBeDefined();
  });

  it('clicking "Reload sidebar" resets and renders children again', () => {
    shouldThrow = true;

    render(
      <SidebarErrorBoundary>
        <ThrowingChild />
      </SidebarErrorBoundary>
    );

    expect(screen.getByText("Reload sidebar")).toBeDefined();

    // Stop throwing so re-render succeeds
    shouldThrow = false;

    fireEvent.click(screen.getByText("Reload sidebar"));

    expect(screen.getByTestId("sidebar-content")).toBeDefined();
    expect(screen.queryByText("Reload sidebar")).toBeNull();
  });
});
