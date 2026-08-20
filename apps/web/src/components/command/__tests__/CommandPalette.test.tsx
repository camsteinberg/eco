// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
}));

// Mock conversation store
const mockSetActive = vi.fn();
const mockConversations = [
  {
    id: "conv-1",
    title: "First conversation",
    createdAt: Date.now() - 3000,
    updatedAt: Date.now() - 1000,
    activeLeafId: null,
    pinnedAt: null,
  },
  {
    id: "conv-2",
    title: "Second conversation",
    createdAt: Date.now() - 2000,
    updatedAt: Date.now() - 500,
    activeLeafId: null,
    pinnedAt: null,
  },
  {
    id: "conv-3",
    title: "Third conversation",
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    activeLeafId: null,
    pinnedAt: null,
  },
];

vi.mock("../../../stores/conversationStore", () => ({
  useConversationStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        conversations: mockConversations,
        activeConversationId: "conv-1",
      }),
    {
      getState: () => ({
        conversations: mockConversations,
        activeConversationId: "conv-1",
        setActive: mockSetActive,
      }),
    }
  ),
}));

import { CommandPalette } from "../CommandPalette";

describe("CommandPalette", () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onAction: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders when open=true", () => {
    render(<CommandPalette {...defaultProps} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("dialog")
    ).toHaveAttribute("aria-label", "Command palette");
  });

  it("is hidden when open=false", () => {
    render(<CommandPalette {...defaultProps} open={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("search input is autofocused when opened", async () => {
    render(<CommandPalette {...defaultProps} />);
    // requestAnimationFrame is used for focus, advance it
    await vi.waitFor(() => {
      expect(screen.getByLabelText("Search commands")).toHaveFocus();
    });
  });

  it("displays all actions when query is empty", () => {
    render(<CommandPalette {...defaultProps} />);
    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
    expect(screen.getByText("Toggle theme")).toBeInTheDocument();
    expect(screen.getByText("Search in conversation")).toBeInTheDocument();
    expect(screen.getByText("Export as Markdown")).toBeInTheDocument();
    expect(screen.getByText("Export as JSON")).toBeInTheDocument();
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
  });

  it("filters actions by query substring", async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...defaultProps} />);
    const input = screen.getByLabelText("Search commands");
    await user.type(input, "toggle");
    expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
    expect(screen.getByText("Toggle theme")).toBeInTheDocument();
    expect(screen.queryByText("New chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Export as Markdown")).not.toBeInTheDocument();
  });

  it("displays conversations from store", () => {
    render(<CommandPalette {...defaultProps} />);
    expect(screen.getByText("First conversation")).toBeInTheDocument();
    expect(screen.getByText("Second conversation")).toBeInTheDocument();
    expect(screen.getByText("Third conversation")).toBeInTheDocument();
  });

  it("filters conversations by title", async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...defaultProps} />);
    const input = screen.getByLabelText("Search commands");
    await user.type(input, "first");
    expect(screen.getByText("First conversation")).toBeInTheDocument();
    expect(
      screen.queryByText("Second conversation")
    ).not.toBeInTheDocument();
  });

  it("Arrow Down moves selection to next item", () => {
    render(<CommandPalette {...defaultProps} />);

    // First item should be selected initially
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    // Press arrow down on the dialog container
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    const updatedOptions = screen.getAllByRole("option");
    expect(updatedOptions[0]).toHaveAttribute("aria-selected", "false");
    expect(updatedOptions[1]).toHaveAttribute("aria-selected", "true");
  });

  it("Arrow Up moves selection to previous item", () => {
    render(<CommandPalette {...defaultProps} />);

    const dialog = screen.getByRole("dialog");
    // Move down twice then up once
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowUp" });

    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter executes selected item", () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette open={true} onClose={onClose} onAction={onAction} />
    );

    // First item is "New chat" — press Enter to execute
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith("newChat");
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <CommandPalette open={true} onClose={onClose} onAction={vi.fn()} />
    );

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("click on item executes action", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette open={true} onClose={onClose} onAction={onAction} />
    );

    const toggleTheme = screen.getByText("Toggle theme");
    await user.click(toggleTheme);
    expect(onAction).toHaveBeenCalledWith("toggleTheme");
    expect(onClose).toHaveBeenCalled();
  });

  it("executes search current conversation from the action list", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <CommandPalette open={true} onClose={vi.fn()} onAction={onAction} />
    );

    await user.click(screen.getByText("Search in conversation"));
    expect(onAction).toHaveBeenCalledWith("searchConversation");
  });

  it("click on backdrop calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <CommandPalette open={true} onClose={onClose} onAction={vi.fn()} />
    );

    const backdrop = screen.getByTestId("command-palette-backdrop");
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("has correct ARIA attributes", () => {
    render(<CommandPalette {...defaultProps} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-label", "Command palette");
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();

    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);

    // Exactly one item should be selected
    const selectedOptions = options.filter(
      (opt) => opt.getAttribute("aria-selected") === "true"
    );
    expect(selectedOptions).toHaveLength(1);
  });

  it("shows section headers", () => {
    render(<CommandPalette {...defaultProps} />);
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Conversations")).toBeInTheDocument();
  });

  it("shows footer hint with keyboard instructions", () => {
    render(<CommandPalette {...defaultProps} />);
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("Select")).toBeInTheDocument();
    expect(screen.getByText("Close")).toBeInTheDocument();
  });

  it("shows 'No results found' when filter matches nothing", async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...defaultProps} />);
    const input = screen.getByLabelText("Search commands");
    await user.type(input, "xyznonexistent");
    expect(screen.getByText("No results found")).toBeInTheDocument();
  });

  it("clicking a conversation sets it active and navigates", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <CommandPalette open={true} onClose={onClose} onAction={vi.fn()} />
    );

    const convItem = screen.getByText("First conversation");
    await user.click(convItem);
    expect(mockSetActive).toHaveBeenCalledWith("conv-1");
    expect(mockPush).toHaveBeenCalledWith("/chat");
    expect(onClose).toHaveBeenCalled();
  });
});
