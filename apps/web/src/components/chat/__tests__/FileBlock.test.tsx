// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileBlock, parseFileBlocks } from "../FileBlock";

const defaultProps = {
  filename: "quarterly-spend.csv",
  size: "48",
  type: "csv" as const,
  content: "month,amount\n2026-01,120\n",
};

describe("FileBlock", () => {
  it("renders the filename and a human-readable size", () => {
    render(<FileBlock {...defaultProps} />);
    expect(screen.getByText("quarterly-spend.csv")).toBeInTheDocument();
    expect(screen.getByText("48B")).toBeInTheDocument();
  });

  it("expands and collapses the file content", async () => {
    render(<FileBlock {...defaultProps} />);
    const toggle = screen.getByRole("button");

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/month,amount/)).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/month,amount/)).toBeInTheDocument();
  });

  // FileBlock only ever renders inside the user bubble, which paints its own
  // foreground over a primary-tinted background. Surface tokens dropped the
  // filename to ~1.9:1 and the size label to ~1.3:1 there — effectively
  // invisible. Every colour has to derive from the bubble's own text colour so
  // the chip stays legible in both themes.
  it("takes its colours from the surrounding bubble, not from surface tokens", () => {
    const { container } = render(<FileBlock {...defaultProps} />);

    const name = screen.getByText("quarterly-spend.csv");
    expect(name.getAttribute("style")).toBeNull();

    const size = screen.getByText("48B");
    expect(size.getAttribute("style")).toContain("currentcolor");

    const surfaceToken = /--eco-text\b|--eco-text-secondary|--eco-border\b|--eco-primary/;
    for (const el of container.querySelectorAll("[style]")) {
      expect(el.getAttribute("style")).not.toMatch(surfaceToken);
    }
  });
});

describe("parseFileBlocks", () => {
  it("splits file blocks out of the surrounding user text", () => {
    const { files, userText } = parseFileBlocks(
      'Please check this.\n<file name="a.csv" size="12">\n```\nx,y\n```\n</file>'
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("a.csv");
    expect(files[0]?.size).toBe("12");
    expect(userText).toBe("Please check this.");
  });

  it("returns the original text when there are no file blocks", () => {
    const { files, userText } = parseFileBlocks("just a message");
    expect(files).toHaveLength(0);
    expect(userText).toBe("just a message");
  });
});
