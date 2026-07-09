// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock driver.js before importing the component
const mockDrive = vi.fn();
const mockDestroy = vi.fn();
let capturedConfig: Record<string, unknown> | null = null;
const navigationMock = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigationMock.searchParams,
}));

vi.mock("driver.js", () => ({
  driver: (config: Record<string, unknown>) => {
    capturedConfig = config;
    return {
      drive: mockDrive,
      destroy: mockDestroy,
    };
  },
}));

vi.mock("driver.js/dist/driver.css", () => ({}));

import { OnboardingTour } from "../OnboardingTour";
import { getOnboardingStore } from "../../../stores/onboardingStore";

describe("OnboardingTour", () => {
  beforeEach(() => {
    localStorage.clear();
    capturedConfig = null;
    navigationMock.searchParams = new URLSearchParams();
    mockDrive.mockClear();
    mockDestroy.mockClear();
    // The tour is gated behind onboarding wizard completion.
    // Set the store to completed so the tour can render.
    const store = getOnboardingStore();
    if (store) {
      store.setState({ hasCompletedOnboarding: true, step: "complete" });
    }
  });

  it("renders welcome overlay when localStorage has no tour-completed key", async () => {
    await act(async () => {
      render(<OnboardingTour />);
    });
    expect(screen.getByText("Welcome to Eco")).toBeDefined();
    expect(screen.getByText(/show me around/i)).toBeDefined();
    expect(screen.getByText(/skip/i)).toBeDefined();
  });

  it("does NOT render welcome overlay when tour is already completed", async () => {
    localStorage.setItem("eco-tour-completed", "true");
    await act(async () => {
      render(<OnboardingTour />);
    });
    expect(screen.queryByText("Welcome to Eco")).toBeNull();
  });

  it('clicking "Show me around" calls driver.drive()', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<OnboardingTour />);
    });
    const btn = screen.getByText(/show me around/i);
    await user.click(btn);
    expect(mockDrive).toHaveBeenCalled();
  });

  it('clicking "Skip" sets localStorage key without calling driver', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<OnboardingTour />);
    });
    const btn = screen.getByText(/skip/i);
    await user.click(btn);
    expect(localStorage.getItem("eco-tour-completed")).toBe("true");
    expect(mockDrive).not.toHaveBeenCalled();
  });

  it('driver config has popoverClass "eco-tour-popover" and 3 steps', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<OnboardingTour />);
    });
    await user.click(screen.getByText(/show me around/i));
    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig!.popoverClass).toBe("eco-tour-popover");
    expect(capturedConfig!.steps).toHaveLength(3);
  });

  it("onDestroyed callback marks tour as completed", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<OnboardingTour />);
    });
    await user.click(screen.getByText(/show me around/i));
    expect(capturedConfig).not.toBeNull();

    // Simulate tour destruction (completion)
    const onDestroyed = capturedConfig!.onDestroyed as () => void;
    act(() => {
      onDestroyed();
    });
    expect(localStorage.getItem("eco-tour-completed")).toBe("true");
  });

  it("on tour complete, marks tour-covered features as discovered and leaves keyboard shortcuts undiscovered", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<OnboardingTour />);
    });
    await user.click(screen.getByText(/show me around/i));

    const onDestroyed = capturedConfig!.onDestroyed as () => void;
    act(() => {
      onDestroyed();
    });

    // Tour-covered features should be marked as discovered
    expect(localStorage.getItem("eco-discovery-model-selector")).toBe("true");
    expect(localStorage.getItem("eco-discovery-privacy")).toBe("true");
    expect(localStorage.getItem("eco-discovery-attestation")).toBe("true");
    expect(localStorage.getItem("eco-discovery-impact")).toBe("true");

    // Non-tour features should NOT be marked as discovered
    expect(localStorage.getItem("eco-discovery-keyboard-shortcuts")).toBeNull();
  });

  it("relaunches the tour from the explicit guide event even after completion", async () => {
    localStorage.setItem("eco-tour-completed", "true");

    await act(async () => {
      render(<OnboardingTour />);
    });

    await act(async () => {
      window.dispatchEvent(new Event("eco:open-guide"));
    });

    expect(mockDrive).toHaveBeenCalled();
  });

  it("launches the tour from the tour query parameter", async () => {
    localStorage.setItem("eco-tour-completed", "true");
    navigationMock.searchParams = new URLSearchParams("tour=1");

    await act(async () => {
      render(<OnboardingTour />);
    });

    expect(mockDrive).toHaveBeenCalled();
  });

  it("on skip, does NOT mark any features as discovered (all get dots)", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<OnboardingTour />);
    });
    await user.click(screen.getByText(/skip/i));

    // No feature discovery keys should be set
    expect(localStorage.getItem("eco-discovery-privacy")).toBeNull();
    expect(localStorage.getItem("eco-discovery-attestation")).toBeNull();
    expect(localStorage.getItem("eco-discovery-impact")).toBeNull();
    expect(localStorage.getItem("eco-discovery-model-selector")).toBeNull();
    expect(localStorage.getItem("eco-discovery-keyboard-shortcuts")).toBeNull();
  });
});
