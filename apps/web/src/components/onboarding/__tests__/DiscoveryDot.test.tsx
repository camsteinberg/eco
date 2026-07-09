// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiscoveryDot } from "../DiscoveryDot";

describe("DiscoveryDot", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("does not render dot when tour is not completed", async () => {
    // Tour not completed (no localStorage key)
    await act(async () => {
      render(
        <DiscoveryDot featureId="model-selector">
          <button type="button">Test Button</button>
        </DiscoveryDot>
      );
    });
    // Children should render
    expect(screen.getByText("Test Button")).toBeDefined();
    // No dot
    expect(document.querySelector("[data-discovery-dot]")).toBeNull();
  });

  it("renders dot when tour is completed and feature is not discovered", async () => {
    localStorage.setItem("eco-tour-completed", "true");
    await act(async () => {
      render(
        <DiscoveryDot featureId="model-selector">
          <button type="button">Test Button</button>
        </DiscoveryDot>
      );
    });
    expect(screen.getByText("Test Button")).toBeDefined();
    expect(document.querySelector("[data-discovery-dot]")).not.toBeNull();
  });

  it("does not render dot when feature is already discovered", async () => {
    localStorage.setItem("eco-tour-completed", "true");
    localStorage.setItem("eco-discovery-model-selector", "true");
    await act(async () => {
      render(
        <DiscoveryDot featureId="model-selector">
          <button type="button">Test Button</button>
        </DiscoveryDot>
      );
    });
    expect(document.querySelector("[data-discovery-dot]")).toBeNull();
  });

  it("clicking the wrapper dismisses the dot and sets localStorage", async () => {
    localStorage.setItem("eco-tour-completed", "true");
    const user = userEvent.setup();
    await act(async () => {
      render(
        <DiscoveryDot featureId="model-selector">
          <button type="button">Test Button</button>
        </DiscoveryDot>
      );
    });
    // Dot should be visible
    expect(document.querySelector("[data-discovery-dot]")).not.toBeNull();

    // Click the child (which triggers the wrapper's onClick)
    await user.click(screen.getByText("Test Button"));

    // Dot should be dismissed
    expect(document.querySelector("[data-discovery-dot]")).toBeNull();
    expect(localStorage.getItem("eco-discovery-model-selector")).toBe("true");
  });

  it("mouseenter dismisses the dot", async () => {
    localStorage.setItem("eco-tour-completed", "true");
    const user = userEvent.setup();
    await act(async () => {
      render(
        <DiscoveryDot featureId="model-selector">
          <button type="button">Test Button</button>
        </DiscoveryDot>
      );
    });
    expect(document.querySelector("[data-discovery-dot]")).not.toBeNull();

    // Hover over the wrapper
    await user.hover(screen.getByText("Test Button"));

    expect(document.querySelector("[data-discovery-dot]")).toBeNull();
    expect(localStorage.getItem("eco-discovery-model-selector")).toBe("true");
  });
});
