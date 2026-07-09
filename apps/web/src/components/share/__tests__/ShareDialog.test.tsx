// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ShareDialog } from "../ShareDialog";

// Mock share and export modules
vi.mock("../../../lib/share", () => ({
  copyConversationAsMarkdown: vi.fn(() => Promise.resolve()),
  downloadShareableHTML: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/export", () => ({
  exportConversationAsJSON: vi.fn(() => Promise.resolve('{"test": true}')),
  downloadFile: vi.fn(),
}));

import { copyConversationAsMarkdown, downloadShareableHTML } from "../../../lib/share";
import { exportConversationAsJSON, downloadFile } from "../../../lib/export";

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  conversationId: "conv-123",
  conversationTitle: "Test Conversation",
};

describe("ShareDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders when open=true, returns null when open=false", () => {
    const { rerender } = render(<ShareDialog {...defaultProps} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(<ShareDialog {...defaultProps} open={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("displays the conversation title", () => {
    render(<ShareDialog {...defaultProps} />);
    expect(screen.getByText("Test Conversation")).toBeInTheDocument();
  });

  it("truncates long conversation titles to 60 characters", () => {
    const longTitle = "A".repeat(80);
    render(<ShareDialog {...defaultProps} conversationTitle={longTitle} />);
    expect(screen.getByText("A".repeat(60) + "...")).toBeInTheDocument();
  });

  it("Copy as Markdown button calls copyConversationAsMarkdown", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<ShareDialog {...defaultProps} />);

    const btn = screen.getByRole("button", { name: "Copy as Markdown" });
    await user.click(btn);

    expect(copyConversationAsMarkdown).toHaveBeenCalledWith("conv-123");
  });

  it("shows Copied! text after successful copy", async () => {
    render(<ShareDialog {...defaultProps} />);

    const btn = screen.getByRole("button", { name: "Copy as Markdown" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(screen.getByText("Copied!")).toBeInTheDocument();

    // After 2 seconds, resets back
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("Copied!")).not.toBeInTheDocument();
    expect(screen.getByText("Copy as Markdown")).toBeInTheDocument();
  });

  it("shows visible local success confirmation after copy", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<ShareDialog {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: "Copy as Markdown" }));

    expect(screen.getByText("Copied locally as markdown.")).toBeInTheDocument();
  });

  it("shows retry guidance when markdown copy fails", async () => {
    vi.useRealTimers();
    vi.mocked(copyConversationAsMarkdown).mockRejectedValueOnce(new Error("copy failed"));
    const user = userEvent.setup();
    render(<ShareDialog {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: "Copy as Markdown" }));

    expect(screen.getByText("Try copy again")).toBeInTheDocument();
    expect(screen.getByText("Copy failed on this browser. Try again.")).toBeInTheDocument();
  });

  it("Download as HTML button calls downloadShareableHTML", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<ShareDialog {...defaultProps} />);

    const btn = screen.getByRole("button", { name: "Download as HTML" });
    await user.click(btn);

    expect(downloadShareableHTML).toHaveBeenCalledWith("conv-123", "Test Conversation");
  });

  it("surfaces a recoverable error when HTML download fails", async () => {
    vi.useRealTimers();
    vi.mocked(downloadShareableHTML).mockRejectedValueOnce(new Error("download failed"));
    const user = userEvent.setup();
    render(<ShareDialog {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: "Download as HTML" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Eco could not create the HTML export",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Export as JSON button calls export + download functions", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<ShareDialog {...defaultProps} />);

    const btn = screen.getByRole("button", { name: "Export as JSON" });
    await user.click(btn);

    expect(exportConversationAsJSON).toHaveBeenCalledWith("conv-123");
    expect(downloadFile).toHaveBeenCalledWith(
      '{"test": true}',
      "Test Conversation.json",
      "application/json"
    );
  });

  it("surfaces a recoverable error when JSON export fails", async () => {
    vi.useRealTimers();
    vi.mocked(exportConversationAsJSON).mockRejectedValueOnce(new Error("export failed"));
    const user = userEvent.setup();
    render(<ShareDialog {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: "Export as JSON" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Eco could not create the JSON export",
    );
  });

  it("Escape key calls onClose", () => {
    const onClose = vi.fn();
    render(<ShareDialog {...defaultProps} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop click calls onClose", async () => {
    vi.useRealTimers();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ShareDialog {...defaultProps} onClose={onClose} />);

    const backdrop = screen.getByTestId("share-backdrop");
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has correct ARIA attributes", () => {
    render(<ShareDialog {...defaultProps} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-label", "Share conversation");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("renders privacy note text", () => {
    render(<ShareDialog {...defaultProps} />);
    expect(
      screen.getByText("This export is created locally. Eco does not upload this conversation to make the file.")
    ).toBeInTheDocument();
  });
});
