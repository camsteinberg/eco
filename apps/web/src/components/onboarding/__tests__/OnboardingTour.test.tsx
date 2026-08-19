// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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

/**
 * The tour points at real elements and drops any step whose target is not
 * mounted, so a test that expects the tour to run has to put the targets on the
 * page first. Each test gets all of them; the ones about step filtering clear
 * that and mount only what they mean to prove.
 */
function mountTourTargets(...targets: string[]): void {
  for (const target of targets) {
    const el = document.createElement("div");
    el.setAttribute("data-tour-target", target);
    document.body.appendChild(el);
  }
}

function clearTourTargets(): void {
  for (const el of Array.from(document.querySelectorAll("[data-tour-target]"))) {
    el.remove();
  }
}

const ALL_TOUR_TARGETS = ["model-selector", "impact-footer"];

function stepElements(config: Record<string, unknown> | null): string[] {
  const steps = config?.steps as Array<{ element: string }> | undefined;
  return (steps ?? []).map((step) => step.element);
}

describe("OnboardingTour", () => {
  beforeEach(() => {
    localStorage.clear();
    mountTourTargets(...ALL_TOUR_TARGETS);
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

  afterEach(() => {
    clearTourTargets();
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

  it('driver config has popoverClass "eco-tour-popover" and the two real steps', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<OnboardingTour />);
    });
    await user.click(screen.getByText(/show me around/i));
    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig!.popoverClass).toBe("eco-tour-popover");
    expect(stepElements(capturedConfig)).toEqual([
      '[data-tour-target="model-selector"]',
      '[data-tour-target="impact-footer"]',
    ]);
  });

  it("drops only the steps whose target is not mounted", async () => {
    clearTourTargets();
    mountTourTargets("model-selector");

    const user = userEvent.setup();
    await act(async () => {
      render(<OnboardingTour />);
    });
    await user.click(screen.getByText(/show me around/i));

    expect(stepElements(capturedConfig)).toEqual(['[data-tour-target="model-selector"]']);
    expect(mockDrive).toHaveBeenCalled();
  });

  it("does not start a tour when none of its targets are mounted", async () => {
    clearTourTargets();

    const user = userEvent.setup();
    await act(async () => {
      render(<OnboardingTour />);
    });
    await user.click(screen.getByText(/show me around/i));

    expect(capturedConfig).toBeNull();
    expect(mockDrive).not.toHaveBeenCalled();
    // The offer stands on the next visit rather than being silently consumed.
    expect(localStorage.getItem("eco-tour-completed")).toBeNull();
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
