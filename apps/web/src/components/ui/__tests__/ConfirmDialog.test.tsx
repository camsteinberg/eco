// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ConfirmDialog } from "../ConfirmDialog";

// jsdom does not implement HTMLDialogElement.showModal/close natively
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
  }
});

describe("ConfirmDialog", () => {
  const baseProps = {
    open: true,
    title: "Delete item?",
    message: "This action cannot be undone.",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it("renders title and message when open", () => {
    render(<ConfirmDialog {...baseProps} />);
    expect(screen.getByText("Delete item?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...baseProps} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...baseProps} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses custom confirm label", () => {
    render(<ConfirmDialog {...baseProps} confirmLabel="Delete" />);
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("does not render dialog content when open is false", () => {
    render(<ConfirmDialog {...baseProps} open={false} />);
    // The dialog element exists but should not be open
    const dialog = document.querySelector("dialog");
    expect(dialog).not.toHaveAttribute("open");
  });

  it("cancel button has hover and transition classes", () => {
    render(<ConfirmDialog {...baseProps} />);
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(cancelBtn.className).toContain("transition-colors");
    expect(cancelBtn.className).toContain("hover:bg-[var(--eco-primary-soft)]");
  });

  it("confirm button has hover and transition classes", () => {
    render(<ConfirmDialog {...baseProps} />);
    const confirmBtn = screen.getByRole("button", { name: "Confirm" });
    expect(confirmBtn.className).toContain("transition-all");
    expect(confirmBtn.className).toContain("hover:opacity-90");
  });

  it("renders an inline error message when provided", () => {
    render(
      <ConfirmDialog
        {...baseProps}
        errorMessage="We couldn't complete that request. Please try again."
      />,
    );

    expect(
      screen.getByText("We couldn't complete that request. Please try again."),
    ).toBeInTheDocument();
  });

  it("disables the confirm button when confirmDisabled is true", () => {
    render(<ConfirmDialog {...baseProps} confirmDisabled />);

    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });
});
