// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { Button } from "../Button";

describe("Button", () => {
  it("renders children text", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("renders primary variant with primary bg color", () => {
    render(<Button variant="primary">Primary</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toHaveStyle({ backgroundColor: "var(--eco-primary)" });
    expect(btn.className).toContain("rounded-full");
    expect(btn.className).toContain("text-white");
  });

  it("renders secondary variant with border and transparent bg", () => {
    render(<Button variant="secondary">Secondary</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("border");
    expect(btn.className).toContain("rounded-xl");
  });

  it("renders ghost variant with no border", () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("rounded-lg");
    expect(btn.className).not.toContain("border");
  });

  it("renders danger variant with danger bg color", () => {
    render(<Button variant="danger">Danger</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toHaveStyle({ backgroundColor: "var(--eco-coral)" });
    expect(btn.className).toContain("text-white");
  });

  it("renders sm size with appropriate padding", () => {
    render(<Button size="sm">Small</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("px-3");
    expect(btn.className).toContain("py-1.5");
    expect(btn.className).toContain("text-sm");
  });

  it("renders md size with appropriate padding", () => {
    render(<Button size="md">Medium</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("px-4");
    expect(btn.className).toContain("py-2.5");
  });

  it("renders lg size with appropriate padding", () => {
    render(<Button size="lg">Large</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("px-6");
    expect(btn.className).toContain("py-3.5");
  });

  it("shows loading spinner and disables when loading=true", () => {
    render(<Button loading>Loading</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    // Spinner SVG should be present
    const svg = btn.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg?.className.baseVal || svg?.getAttribute("class") || "").toContain("animate-spin");
  });

  it("applies fullWidth class when fullWidth=true", () => {
    render(<Button fullWidth>Full Width</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("w-full");
  });

  it("forwards additional HTML button attributes", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} type="submit" aria-label="Submit form">
        Submit
      </Button>
    );
    const btn = screen.getByRole("button", { name: "Submit form" });
    expect(btn).toHaveAttribute("type", "submit");
    const user = userEvent.setup();
    await user.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("has transition-all duration-150 ease classes", () => {
    render(<Button>Transitions</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("transition-all");
    expect(btn.className).toContain("duration-150");
  });

  it("is disabled when disabled prop is true", () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
  });

  it("renders active:scale-[0.98] class for press feedback", () => {
    render(<Button>Press me</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("active:scale-[0.98]");
  });
});
