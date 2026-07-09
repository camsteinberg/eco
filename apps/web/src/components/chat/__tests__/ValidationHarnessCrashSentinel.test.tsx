// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalInferenceErrorBoundary } from "../LocalInferenceErrorBoundary";
import { ValidationHarnessCrashSentinel } from "../ValidationHarnessCrashSentinel";

const originalValidationHarness = process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS;

describe("ValidationHarnessCrashSentinel", () => {
  afterEach(() => {
    if (originalValidationHarness === undefined) {
      delete process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS;
    } else {
      process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS = originalValidationHarness;
    }
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("forces the local runtime crash recovery UI when the mission harness is enabled", () => {
    process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS = "true";
    window.history.replaceState({}, "", "/chat?eco-force-local-runtime=crash");

    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <LocalInferenceErrorBoundary localRecoveryAvailable>
        <ValidationHarnessCrashSentinel />
      </LocalInferenceErrorBoundary>,
    );

    expect(screen.getByText(/on-device ai ran into a problem/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try on-device again/i })).toBeInTheDocument();
    expect(screen.queryByText(/eco network/i)).not.toBeInTheDocument();
  });
});
