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
      span: React.forwardRef(
        (props: Record<string, unknown>, ref: React.Ref<HTMLSpanElement>) => {
          const {
            layout: _layout,
            transition: _transition,
            ...rest
          } = props;
          return React.createElement("span", { ...rest, ref });
        },
      ),
    },
    useReducedMotion: () => false,
  };
});

import { Toggle } from "../Toggle";

describe("Toggle", () => {
  it("renders with label text", () => {
    render(<Toggle label="Enable feature" />);
    expect(screen.getByText("Enable feature")).toBeInTheDocument();
  });

  it("renders a switch role element", () => {
    render(<Toggle label="Toggle me" />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("calls onCheckedChange when toggled", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Toggle
        label="Toggle me"
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    await userEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("disabled state prevents toggling", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Toggle
        label="Disabled toggle"
        disabled
        onCheckedChange={onCheckedChange}
      />,
    );
    const toggle = screen.getByRole("switch");
    expect(toggle).toBeDisabled();
    await userEvent.click(toggle);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("has aria-labelledby linking to label", () => {
    render(<Toggle label="Accessible toggle" />);
    const toggle = screen.getByRole("switch");
    const labelId = toggle.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const label = document.getElementById(labelId!);
    expect(label).toHaveTextContent("Accessible toggle");
  });

  it("includes focus-visible ring styles", () => {
    render(<Toggle label="Focus toggle" />);
    const toggle = screen.getByRole("switch");
    expect(toggle.className).toContain("focus-visible:ring-2");
  });
});
