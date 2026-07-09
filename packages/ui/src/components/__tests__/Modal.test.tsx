// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { Modal } from "../Modal";

// Mock motion/react to avoid animation complexities in tests
vi.mock("motion/react", () => ({
  motion: {
    div: "div",
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  useReducedMotion: () => false,
}));

describe("Modal", () => {
  it("renders with title text when open", () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Test Modal">
        <p>Modal content</p>
      </Modal>,
    );
    expect(screen.getByText("Test Modal")).toBeInTheDocument();
    expect(screen.getByText("Modal content")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(
      <Modal
        open={true}
        onOpenChange={() => {}}
        title="Title"
        description="A description"
      >
        <p>content</p>
      </Modal>,
    );
    expect(screen.getByText("A description")).toBeInTheDocument();
  });

  it("does not render content when closed", () => {
    render(
      <Modal open={false} onOpenChange={() => {}} title="Hidden">
        <p>Hidden content</p>
      </Modal>,
    );
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden content")).not.toBeInTheDocument();
  });

  it("calls onOpenChange when close button is clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Modal open={true} onOpenChange={onOpenChange} title="Closable">
        <p>content</p>
      </Modal>,
    );
    const closeButton = screen.getByLabelText("Close");
    await user.click(closeButton);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
