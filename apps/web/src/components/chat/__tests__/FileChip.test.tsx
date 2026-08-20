// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileChip } from "../FileChip";

const defaultProps = {
  filename: "document.txt",
  size: 1024,
  status: "done" as const,
  onRemove: vi.fn(),
};

describe("FileChip", () => {
  it("renders filename and size", () => {
    render(<FileChip {...defaultProps} />);
    expect(screen.getByText("document.txt")).toBeInTheDocument();
    expect(screen.getByText("1KB")).toBeInTheDocument();
  });

  it("shows spinner for reading status", () => {
    render(<FileChip {...defaultProps} status="reading" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows spinner for extracting status", () => {
    render(<FileChip {...defaultProps} status="extracting" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows error state with message", () => {
    render(
      <FileChip {...defaultProps} status="error" errorMessage="Unsupported file type" />
    );
    expect(screen.getByText("Unsupported file type")).toBeInTheDocument();
  });

  it("shows the On-device badge for a completed attachment with no Eco Network copy", () => {
    render(<FileChip {...defaultProps} />);
    // v1.0 is on-device only — every attachment is read locally, so the badge
    // reads On-device with no Eco Network / "On network" wording.
    expect(screen.getByText("On-device")).toBeInTheDocument();
    expect(screen.queryByText(/On network/i)).toBeNull();
    expect(screen.queryByTitle(/Eco Network/i)).toBeNull();
  });

  it("calls onRemove when X is clicked", async () => {
    const onRemove = vi.fn();
    render(<FileChip {...defaultProps} onRemove={onRemove} />);
    const removeButton = screen.getByRole("button", { name: /remove/i });
    await userEvent.click(removeButton);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("shows truncation indicator when truncated is true", () => {
    render(<FileChip {...defaultProps} truncated={true} />);
    expect(screen.getByText("(truncated)")).toBeInTheDocument();
  });

  it("hides truncation indicator when truncated is false", () => {
    render(<FileChip {...defaultProps} truncated={false} />);
    expect(screen.queryByText("(truncated)")).not.toBeInTheDocument();
  });

  it("truncates long filenames", () => {
    render(<FileChip {...defaultProps} filename="a-very-long-filename-that-exceeds-limit.txt" />);
    // Should show truncated version, not the full name
    expect(screen.queryByText("a-very-long-filename-that-exceeds-limit.txt")).not.toBeInTheDocument();
  });

  it("shows MB for large files", () => {
    render(<FileChip {...defaultProps} size={5 * 1024 * 1024} />);
    expect(screen.getByText("5.0MB")).toBeInTheDocument();
  });

  it("keeps the trailing badge whole when the filename is long", () => {
    // At narrow widths a long name used to squeeze the row until "On-device"
    // wrapped onto two lines and the pill's cap clipped past the chip edge.
    // The filename is the only element allowed to shrink.
    render(
      <FileChip
        {...defaultProps}
        filename="server-2026-08-20-diagnostics-export.txt"
        truncated={true}
      />
    );

    const badge = screen.getByText("On-device");
    expect(badge.className).toContain("whitespace-nowrap");
    expect(badge.className).toContain("shrink-0");

    for (const label of ["1KB", "(truncated)"]) {
      expect(screen.getByText(label).className).toContain("shrink-0");
    }

    const name = screen.getByTitle("server-2026-08-20-diagnostics-export.txt");
    expect(name.className).toContain("min-w-0");
    expect(name.className).toContain("truncate");
  });
});
