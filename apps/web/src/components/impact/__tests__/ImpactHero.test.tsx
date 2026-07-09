// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImpactHero } from "../ImpactHero";

describe("ImpactHero", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a static estimate without any network fetch", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<ImpactHero />);

    // The hero number is a static, methodology-backed estimate.
    expect(screen.getByText("~250")).toBeInTheDocument();
    expect(screen.getByText("mL")).toBeInTheDocument();
    // No live/per-user data is fetched on the impact page.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("labels the figure as an estimate rather than measured telemetry", () => {
    render(<ImpactHero />);

    expect(screen.getByText(/estimated, not measured/i)).toBeInTheDocument();
    expect(screen.getByText(/on your own device/i)).toBeInTheDocument();
  });
});
