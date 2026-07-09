// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { ImpactShareCardCanvas } from "../ImpactShareCardCanvas";

const sampleImpact = {
  waterSavedLiters: 1.25,
  energySavedWh: 10,
  co2SavedGrams: 6.3,
};

describe("ImpactShareCardCanvas", () => {
  it("renders the dashboard share experience by default", () => {
    render(
      <ImpactShareCardCanvas
        impact={sampleImpact}
        daysActive={7}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: /share your impact card/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "My impact with Eco" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("7 days of impact")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /story/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy text/i })).toBeInTheDocument();
  });

  it("supports conversation sharing without the lifetime badge", () => {
    render(
      <ImpactShareCardCanvas
        impact={sampleImpact}
        title="This conversation’s impact"
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "This conversation’s impact" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/days of impact/i)).not.toBeInTheDocument();
  });
});
