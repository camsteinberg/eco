// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ConversationItem } from "../ConversationItem";

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

const mockConversation = {
  id: "conv-1",
  title: "Test Conversation",
  createdAt: Date.now() - 3600000,
  updatedAt: Date.now() - 60000,
  activeLeafId: null,
  preview: "Hello, how can I help?",
};

function renderItem(overrides = {}) {
  const props = {
    conversation: mockConversation,
    isActive: false,
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onExportJSON: vi.fn(),
    onExportMarkdown: vi.fn(),
    onShare: vi.fn(),
    ...overrides,
  };
  const result = render(<ConversationItem {...props} />);
  return { ...result, ...props };
}

/** Helper to open the kebab dropdown menu */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  const menuBtn = screen.getByRole("button", { name: "Conversation menu" });
  await user.click(menuBtn);
}

describe("ConversationItem", () => {
  it("renders conversation title and preview", () => {
    renderItem();
    expect(screen.getByText("Test Conversation")).toBeInTheDocument();
    expect(screen.getByText("Hello, how can I help?")).toBeInTheDocument();
  });

  it("shows kebab menu button on hover area", () => {
    renderItem();
    const menuBtn = screen.getByRole("button", { name: "Conversation menu" });
    expect(menuBtn).toBeInTheDocument();
  });

  it("opens dropdown with menu items when kebab is clicked", async () => {
    const user = userEvent.setup();
    renderItem();
    await openMenu(user);

    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Export as JSON" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Export as Markdown" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("shows Unpin instead of Pin when conversation is pinned", async () => {
    const user = userEvent.setup();
    renderItem({ isPinned: true });
    await openMenu(user);

    expect(screen.getByRole("menuitem", { name: "Unpin" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Pin" })).not.toBeInTheDocument();
  });

  it("shows rename input when Rename menu item is clicked", async () => {
    const user = userEvent.setup();
    renderItem();
    await openMenu(user);

    const renameItem = screen.getByRole("menuitem", { name: "Rename" });
    await user.click(renameItem);

    const input = screen.getByLabelText("Rename conversation");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("Test Conversation");
  });

  it("calls onRename with new title on Enter", async () => {
    const user = userEvent.setup();
    const { onRename } = renderItem();
    await openMenu(user);

    const renameItem = screen.getByRole("menuitem", { name: "Rename" });
    await user.click(renameItem);

    const input = screen.getByLabelText("Rename conversation");
    await user.clear(input);
    await user.type(input, "Renamed Title{Enter}");

    expect(onRename).toHaveBeenCalledWith("Renamed Title");
  });

  it("reverts title on Escape without calling onRename", async () => {
    const user = userEvent.setup();
    const { onRename } = renderItem();
    await openMenu(user);

    const renameItem = screen.getByRole("menuitem", { name: "Rename" });
    await user.click(renameItem);

    const input = screen.getByLabelText("Rename conversation");
    await user.clear(input);
    await user.type(input, "New Title{Escape}");

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Test Conversation")).toBeInTheDocument();
  });

  it("calls onRename on blur", async () => {
    const user = userEvent.setup();
    const { onRename } = renderItem();
    await openMenu(user);

    const renameItem = screen.getByRole("menuitem", { name: "Rename" });
    await user.click(renameItem);

    const input = screen.getByLabelText("Rename conversation");
    await user.clear(input);
    await user.type(input, "Blurred Title");
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith("Blurred Title");
  });

  it("does not call onRename when title unchanged", async () => {
    const user = userEvent.setup();
    const { onRename } = renderItem();
    await openMenu(user);

    const renameItem = screen.getByRole("menuitem", { name: "Rename" });
    await user.click(renameItem);

    const input = screen.getByLabelText("Rename conversation");
    // Press Enter without changing
    await user.type(input, "{Enter}");

    expect(onRename).not.toHaveBeenCalled();
  });

  it("shows confirm dialog when Delete menu item is clicked", async () => {
    const user = userEvent.setup();
    renderItem();
    await openMenu(user);

    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    await user.click(deleteItem);

    expect(screen.getByText("Delete conversation?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("calls onDelete when delete is confirmed", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderItem();
    await openMenu(user);

    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    await user.click(deleteItem);

    // The ConfirmDialog now shows a "Delete" confirm button inside the dialog
    const dialog = document.querySelector("dialog")!;
    const confirmBtn = Array.from(dialog.querySelectorAll("button")).find(
      (btn) => btn.textContent === "Delete"
    )!;
    await user.click(confirmBtn);

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("does not call onDelete when cancel is clicked", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderItem();
    await openMenu(user);

    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    await user.click(deleteItem);

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelBtn);

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("calls onPin when Pin menu item is clicked", async () => {
    const user = userEvent.setup();
    const { onPin } = renderItem();
    await openMenu(user);

    const pinItem = screen.getByRole("menuitem", { name: "Pin" });
    await user.click(pinItem);

    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it("calls onUnpin when Unpin menu item is clicked", async () => {
    const user = userEvent.setup();
    const { onUnpin } = renderItem({ isPinned: true });
    await openMenu(user);

    const unpinItem = screen.getByRole("menuitem", { name: "Unpin" });
    await user.click(unpinItem);

    expect(onUnpin).toHaveBeenCalledTimes(1);
  });

  it("calls onExportJSON when Export as JSON is clicked", async () => {
    const user = userEvent.setup();
    const { onExportJSON } = renderItem();
    await openMenu(user);

    const exportItem = screen.getByRole("menuitem", { name: "Export as JSON" });
    await user.click(exportItem);

    expect(onExportJSON).toHaveBeenCalledTimes(1);
  });

  it("calls onExportMarkdown when Export as Markdown is clicked", async () => {
    const user = userEvent.setup();
    const { onExportMarkdown } = renderItem();
    await openMenu(user);

    const exportItem = screen.getByRole("menuitem", { name: "Export as Markdown" });
    await user.click(exportItem);

    expect(onExportMarkdown).toHaveBeenCalledTimes(1);
  });

  it("calls onShare when Share is clicked", async () => {
    const user = userEvent.setup();
    const { onShare } = renderItem();
    await openMenu(user);

    const shareItem = screen.getByRole("menuitem", { name: "Share" });
    await user.click(shareItem);

    expect(onShare).toHaveBeenCalledTimes(1);
  });

  describe("multi-select mode", () => {
    it("shows checkbox instead of kebab menu", () => {
      renderItem({ isMultiSelect: true, isSelected: false, onToggleSelect: vi.fn() });

      expect(screen.getByRole("checkbox")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Conversation menu" })).not.toBeInTheDocument();
    });

    it("checkbox reflects selected state", () => {
      renderItem({ isMultiSelect: true, isSelected: true, onToggleSelect: vi.fn() });

      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toHaveAttribute("aria-checked", "true");
    });

    it("calls onToggleSelect when checkbox clicked", async () => {
      const user = userEvent.setup();
      const onToggleSelect = vi.fn();
      renderItem({ isMultiSelect: true, isSelected: false, onToggleSelect });

      const checkbox = screen.getByRole("checkbox");
      await user.click(checkbox);

      expect(onToggleSelect).toHaveBeenCalledTimes(1);
    });

    it("calls onToggleSelect when row clicked in multi-select mode", async () => {
      const user = userEvent.setup();
      const onToggleSelect = vi.fn();
      renderItem({ isMultiSelect: true, isSelected: false, onToggleSelect });

      const row = screen.getByRole("button");
      await user.click(row);

      // onToggleSelect is called (possibly multiple times due to event propagation)
      expect(onToggleSelect).toHaveBeenCalled();
    });
  });
});
