// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WaterCounter } from "../WaterCounter";

describe("WaterCounter", () => {
  it("renders water counter with liters value displayed", () => {
    render(<WaterCounter liters={5.2} isDevicePrivate={false} />);
    // The aria-label should contain the value
    const el = screen.getByLabelText(/water saved/i);
    expect(el).toBeTruthy();
  });

  it("shows '0 L' with On-Device label when isDevicePrivate=true", () => {
    render(<WaterCounter liters={0} isDevicePrivate={true} />);
    expect(screen.getByText("On-Device")).toBeTruthy();
    expect(screen.getByLabelText(/0\.0 liters/i)).toBeTruthy();
  });

  it("shows formatted liters value (e.g., '1.5 kL' for 1500)", () => {
    render(<WaterCounter liters={1500} isDevicePrivate={false} />);
    const el = screen.getByLabelText(/1\.5 kiloliters/i);
    expect(el).toBeTruthy();
  });

  it("renders SVG droplet element with data-testid='water-droplet'", () => {
    render(<WaterCounter liters={50} isDevicePrivate={false} />);
    const droplet = screen.getByTestId("water-droplet");
    expect(droplet).toBeTruthy();
    expect(droplet.tagName.toLowerCase()).toBe("svg");
  });

  it("has aria-label with current water value for screen readers", () => {
    render(<WaterCounter liters={250} isDevicePrivate={false} />);
    const el = screen.getByLabelText(/water saved: 250\.0 liters/i);
    expect(el).toBeTruthy();
  });

  it("renders milestone ripple element when crossing 100L threshold", () => {
    const { rerender } = render(
      <WaterCounter liters={95} isDevicePrivate={false} />
    );
    // Before threshold — no ripple
    expect(screen.queryByTestId("milestone-ripple")).toBeNull();

    // Cross 100L threshold
    rerender(<WaterCounter liters={105} isDevicePrivate={false} />);
    const ripple = screen.getByTestId("milestone-ripple");
    expect(ripple).toBeTruthy();
  });
});
