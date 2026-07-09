// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// Mock motion/react to avoid animation issues in test environment
vi.mock("motion/react", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    motion: {
      button: React.forwardRef(
        (props: Record<string, unknown>, ref: React.Ref<HTMLButtonElement>) => {
          const {
            whileTap: _whileTap,
            transition: _transition,
            ...rest
          } = props;
          return React.createElement("button", { ...rest, ref });
        },
      ),
    },
    useReducedMotion: () => false,
  };
});

import { Button } from "../Button";

describe("Button", () => {
  it("renders with children text", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button")).toHaveTextContent("Click me");
  });

  it("applies primary variant classes by default", () => {
    render(<Button>Primary</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("bg-[var(--eco-primary)]");
  });

  it("applies secondary variant classes", () => {
    render(<Button variant="secondary">Secondary</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain(
      "border-[var(--eco-primary)]",
    );
  });

  it("applies danger variant classes", () => {
    render(<Button variant="danger">Danger</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("bg-[var(--eco-coral)]");
  });

  it("disabled state prevents interaction", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Disabled
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading state shows spinner SVG and disables button", () => {
    render(<Button loading>Loading</Button>);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    const svg = button.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  it("applies size classes", () => {
    render(<Button size="lg">Large</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("px-6");
    expect(button.className).toContain(
      "rounded-[var(--eco-radius-sm)]",
    );
  });

  it("includes focus-visible ring styles", () => {
    render(<Button>Focus</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("focus-visible:ring-2");
    expect(button.className).toContain(
      "focus-visible:ring-[var(--eco-primary)]/30",
    );
  });
});
