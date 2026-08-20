// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  isTourCompleted,
  markTourCompleted,
  markFeatureDiscovered,
} from "../../lib/onboarding";
import { ECO_OPEN_GUIDE_EVENT } from "../../lib/onboarding-guide";
import { getOnboardingStore } from "../../stores/onboardingStore";
import { WelcomeOverlay } from "./WelcomeOverlay";

/**
 * OnboardingTour manages the first-run experience:
 * 1. Shows a welcome overlay on first visit
 * 2. Launches a 2-step driver.js tour when user clicks "Show me around"
 * 3. Manages discovery dot activation based on tour completion vs skip
 *
 * State is persisted via lib/onboarding.ts localStorage helpers.
 */
export function OnboardingTour() {
  const [showWelcome, setShowWelcome] = useState(false);
  const driverRef = useRef<ReturnType<typeof import("driver.js").driver> | null>(null);
  const initGuard = useRef(false);
  const queryLaunchGuard = useRef(false);
  const searchParams = useSearchParams();

  useEffect(() => {
    if (initGuard.current) return;
    initGuard.current = true;

    // Do not show the tour until the onboarding wizard has been completed.
    // This prevents the old tour from running alongside the new wizard.
    const onboardingStore = getOnboardingStore();
    if (onboardingStore && !onboardingStore.getState().hasCompletedOnboarding) {
      return;
    }

    if (!isTourCompleted()) {
      setShowWelcome(true);
    }
  }, []);

  const handleStartTour = useCallback(async () => {
    setShowWelcome(false);
    driverRef.current?.destroy();

    const { driver } = await import("driver.js");
    await import("driver.js/dist/driver.css");

    const steps = [
      {
        element: '[data-tour-target="model-selector"]',
        popover: {
          title: "Choose how Eco answers",
          description:
            "Use Auto for Eco’s recommended path, or pick an on-device model when you want replies to stay in this browser.",
          side: "top" as const,
          align: "end" as const,
        },
      },
      {
        element: '[data-tour-target="impact-footer"]',
        popover: {
          title: "Track impact quietly",
          description:
            "Eco estimates water, energy, and CO2 savings so you can see the difference without leaving the conversation.",
          side: "top" as const,
          align: "center" as const,
        },
      },
    ];
    // A step whose target is not on screen cannot be pointed at, so it is
    // dropped. If nothing the tour talks about is mounted there is no tour to
    // run: bail without marking it completed, so the offer comes back on the
    // next visit instead of an empty popover opening in the corner.
    const availableSteps = steps.filter((step) => document.querySelector(step.element));
    if (availableSteps.length === 0) {
      return;
    }

    const driverInstance = driver({
      popoverClass: "eco-tour-popover",
      overlayColor: "#1a1a1a",
      overlayOpacity: 0.6,
      stagePadding: 12,
      stageRadius: 12,
      animate: true,
      smoothScroll: true,
      allowClose: true,
      showProgress: false,
      onDestroyed: () => {
        markTourCompleted();
        // Mark tour-covered features as discovered so they don't get dots
        markFeatureDiscovered("model-selector");
        markFeatureDiscovered("privacy");
        markFeatureDiscovered("attestation");
        markFeatureDiscovered("impact");
      },
      steps: availableSteps,
    });

    driverRef.current = driverInstance;
    driverInstance.drive();
  }, []);

  useEffect(() => {
    const handleOpenGuide = () => {
      void handleStartTour();
    };

    window.addEventListener(ECO_OPEN_GUIDE_EVENT, handleOpenGuide);
    return () => window.removeEventListener(ECO_OPEN_GUIDE_EVENT, handleOpenGuide);
  }, [handleStartTour]);

  useEffect(() => {
    if (queryLaunchGuard.current || searchParams.get("tour") !== "1") {
      return;
    }

    queryLaunchGuard.current = true;
    void handleStartTour();

    const url = new URL(window.location.href);
    url.searchParams.delete("tour");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [handleStartTour, searchParams]);

  const handleSkipTour = () => {
    setShowWelcome(false);
    markTourCompleted();
    // Do NOT mark any features as discovered -- all 5 get discovery dots
  };

  if (showWelcome) {
    return <WelcomeOverlay onStart={handleStartTour} onSkip={handleSkipTour} />;
  }

  return null;
}
