// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/chat",
}));

// Mock search
vi.mock("../../../lib/search", () => ({
  searchMessages: vi.fn().mockResolvedValue([]),
}));

// Mock export functions
vi.mock("../../../lib/export", () => ({
  exportConversationAsJSON: vi.fn().mockResolvedValue('{"test": true}'),
  exportConversationAsMarkdown: vi.fn().mockResolvedValue("# Test"),
  downloadFile: vi.fn(),
}));

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

afterEach(() => {
  vi.useRealTimers();
});

const now = Date.now();
const ONE_DAY = 86400000;

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: `conv-${Math.random().toString(36).slice(2)}`,
    title: "Test Conversation",
    createdAt: now - ONE_DAY,
    updatedAt: now - ONE_DAY,
    activeLeafId: null,
    preview: "Preview text",
    pinnedAt: null as number | null,
    ...overrides,
  };
}

// Create test conversations at specific date offsets
const todayConv = makeConversation({
  id: "conv-today",
  title: "Today Chat",
  updatedAt: now - 1000,
});
const yesterdayConv = makeConversation({
  id: "conv-yesterday",
  title: "Yesterday Chat",
  updatedAt: now - ONE_DAY - 1000,
});
const weekConv = makeConversation({
  id: "conv-week",
  title: "This Week Chat",
  updatedAt: now - 3 * ONE_DAY,
});
const olderConv = makeConversation({
  id: "conv-older",
  title: "Older Chat",
  updatedAt: now - 14 * ONE_DAY,
});
const pinnedConv = makeConversation({
  id: "conv-pinned",
  title: "Pinned Chat",
  updatedAt: now - 2000,
  pinnedAt: now - 500,
});

// Mock conversation store
const mockStoreState = {
  conversations: [todayConv, yesterdayConv, weekConv, olderConv],
  activeConversationId: null,
  hasHydrated: true,
  persistenceError: null as string | null,
  addConversation: vi.fn(),
  removeConversation: vi.fn(),
  renameConversation: vi.fn(),
  setActive: vi.fn(),
  setConversations: vi.fn(),
  updateConversation: vi.fn(),
  loadConversationMessages: vi.fn(),
  saveMessage: vi.fn(),
  clearAll: vi.fn(),
  pinConversation: vi.fn(),
  unpinConversation: vi.fn(),
  removeMultiple: vi.fn(),
  activateSearchResult: vi.fn().mockResolvedValue(undefined),
  clearPersistenceError: vi.fn(),
};

vi.mock("../../../stores/conversationStore", () => ({
  useConversationStore: Object.assign(
    (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
    {
      getState: () => mockStoreState,
    }
  ),
}));

// Import after mocks
import { ConversationList } from "../ConversationList";

describe("ConversationList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.conversations = [todayConv, yesterdayConv, weekConv, olderConv];
    mockStoreState.persistenceError = null;
  });

  describe("date grouping", () => {
    it('uses "Previous 7 Days" label instead of "This Week"', () => {
      render(<ConversationList />);
      expect(screen.getByText("Previous 7 Days")).toBeInTheDocument();
      expect(screen.queryByText("This Week")).not.toBeInTheDocument();
    });

    it("groups conversations by Today, Yesterday, Previous 7 Days, Older", () => {
      render(<ConversationList />);
      expect(screen.getByText("Today")).toBeInTheDocument();
      expect(screen.getByText("Yesterday")).toBeInTheDocument();
      expect(screen.getByText("Previous 7 Days")).toBeInTheDocument();
      expect(screen.getByText("Older")).toBeInTheDocument();
    });

    it("keeps month-boundary conversations in Yesterday and Previous 7 Days buckets", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

      mockStoreState.conversations = [
        makeConversation({
          id: "conv-month-yesterday",
          title: "Month Boundary Yesterday",
          updatedAt: new Date("2026-02-28T23:30:00.000Z").getTime(),
        }),
        makeConversation({
          id: "conv-month-week",
          title: "Month Boundary Week",
          updatedAt: new Date("2026-02-24T09:00:00.000Z").getTime(),
        }),
      ];

      render(<ConversationList />);

      expect(screen.getByText("Yesterday")).toBeInTheDocument();
      expect(screen.getByText("Month Boundary Yesterday")).toBeInTheDocument();
      expect(screen.getByText("Previous 7 Days")).toBeInTheDocument();
      expect(screen.getByText("Month Boundary Week")).toBeInTheDocument();
      expect(screen.queryByText("Older")).not.toBeInTheDocument();
    });

    it("keeps year-boundary conversations in Yesterday and Previous 7 Days buckets", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

      mockStoreState.conversations = [
        makeConversation({
          id: "conv-year-yesterday",
          title: "Year Boundary Yesterday",
          updatedAt: new Date("2025-12-31T23:30:00.000Z").getTime(),
        }),
        makeConversation({
          id: "conv-year-week",
          title: "Year Boundary Week",
          updatedAt: new Date("2025-12-28T09:00:00.000Z").getTime(),
        }),
      ];

      render(<ConversationList />);

      expect(screen.getByText("Yesterday")).toBeInTheDocument();
      expect(screen.getByText("Year Boundary Yesterday")).toBeInTheDocument();
      expect(screen.getByText("Previous 7 Days")).toBeInTheDocument();
      expect(screen.getByText("Year Boundary Week")).toBeInTheDocument();
      expect(screen.queryByText("Older")).not.toBeInTheDocument();
    });
  });

  describe("pinned section", () => {
    it("renders pinned conversations in a Pinned section above date groups", () => {
      mockStoreState.conversations = [todayConv, pinnedConv, olderConv];
      render(<ConversationList />);

      expect(screen.getByText("Pinned")).toBeInTheDocument();
      expect(screen.getByText("Pinned Chat")).toBeInTheDocument();

      // Pinned should appear before other groups
      const headings = screen.getAllByRole("heading");
      const pinnedIdx = headings.findIndex((h) => h.textContent === "Pinned");
      const todayIdx = headings.findIndex((h) => h.textContent === "Today");
      expect(pinnedIdx).toBeLessThan(todayIdx);
    });

    it("does not show Pinned section when no conversations are pinned", () => {
      mockStoreState.conversations = [todayConv, olderConv];
      render(<ConversationList />);
      expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    });
  });

  describe("multi-select mode", () => {
    it("shows Select button to enter multi-select mode", () => {
      render(<ConversationList />);
      expect(screen.getByRole("button", { name: /select/i })).toBeInTheDocument();
    });

    it("shows checkboxes on each conversation in multi-select mode", async () => {
      const user = userEvent.setup();
      render(<ConversationList />);

      const selectBtn = screen.getByRole("button", { name: /select/i });
      await user.click(selectBtn);

      const checkboxes = screen.getAllByRole("checkbox");
      expect(checkboxes.length).toBeGreaterThan(0);
    });

    it("canceling multi-select clears selections", async () => {
      const user = userEvent.setup();
      render(<ConversationList />);

      // Enter multi-select
      const selectBtn = screen.getByRole("button", { name: /select/i });
      await user.click(selectBtn);

      // Click a checkbox to select
      const checkboxes = screen.getAllByRole("checkbox");
      await user.click(checkboxes[0]!);

      // Cancel multi-select using the toggle button near search (has specific aria-label)
      const cancelBtn = screen.getByLabelText("Cancel selection");
      await user.click(cancelBtn);

      // Checkboxes should be gone
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });
  });

  describe("BulkActionsBar", () => {
    // The bar used to mount only once something was selected, while its first
    // button reads "Select all" only at a count of zero — so that label shipped
    // unreachable. The bar now stands for the whole of multi-select.
    it("offers Select all the moment multi-select is armed, and it selects everything", async () => {
      const user = userEvent.setup();
      render(<ConversationList />);

      await user.click(screen.getByLabelText("Select conversations"));

      expect(screen.getByText(/0 selected/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /delete selected/i })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Select all" }));

      expect(screen.getByText(/4 selected/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Deselect" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /delete selected/i })).toBeEnabled();
    });

    // The list is taller than the sidebar's scrollport long before it is worth
    // bulk-editing, so a bar that only joins the end of the flow arrives below
    // the fold with none of its controls readable.
    it("brings itself into view when multi-select is armed", async () => {
      const user = userEvent.setup();
      const scrollIntoView = vi.fn();
      // jsdom does not implement scrollIntoView, so there is nothing to spy on.
      const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        value: scrollIntoView,
        configurable: true,
        writable: true,
      });

      try {
        render(<ConversationList />);
        await user.click(screen.getByLabelText("Select conversations"));

        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      } finally {
        if (original) {
          Object.defineProperty(Element.prototype, "scrollIntoView", original);
        } else {
          delete (Element.prototype as Partial<Element>).scrollIntoView;
        }
      }
    });

    it("shows selected count and Delete button when items are selected", async () => {
      const user = userEvent.setup();
      render(<ConversationList />);

      // Enter multi-select
      const selectBtn = screen.getByRole("button", { name: /select/i });
      await user.click(selectBtn);

      // Select a conversation
      const checkboxes = screen.getAllByRole("checkbox");
      await user.click(checkboxes[0]!);

      // BulkActionsBar should show
      expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /delete selected/i })).toBeInTheDocument();
    });

    it("clicking Delete triggers confirmation dialog", async () => {
      const user = userEvent.setup();
      render(<ConversationList />);

      // Enter multi-select
      const selectBtn = screen.getByRole("button", { name: /select/i });
      await user.click(selectBtn);

      // Select a conversation
      const checkboxes = screen.getAllByRole("checkbox");
      await user.click(checkboxes[0]!);

      // Click Delete in BulkActionsBar
      const deleteBtn = screen.getByRole("button", { name: /delete selected/i });
      await user.click(deleteBtn);

      // Confirmation dialog should appear
      expect(screen.getByText(/delete 1 conversation/i)).toBeInTheDocument();
    });

    it("confirming bulk delete calls removeMultiple with selected IDs", async () => {
      const user = userEvent.setup();
      render(<ConversationList />);

      // Enter multi-select
      const selectBtn = screen.getByRole("button", { name: /select/i });
      await user.click(selectBtn);

      // Select first conversation
      const checkboxes = screen.getAllByRole("checkbox");
      await user.click(checkboxes[0]!);

      // Click Delete in BulkActionsBar
      const deleteBtn = screen.getByRole("button", { name: /delete selected/i });
      await user.click(deleteBtn);

      // Confirm in dialog -- find the Delete button inside the dialog element
      const dialogs = document.querySelectorAll("dialog");
      const dialog = Array.from(dialogs).find((d) => d.hasAttribute("open")) ?? dialogs[0];
      expect(dialog).toBeTruthy();
      const confirmBtn = Array.from(dialog!.querySelectorAll("button")).find(
        (btn) => btn.textContent === "Delete"
      )!;
      expect(confirmBtn).toBeTruthy();
      await user.click(confirmBtn);

      expect(mockStoreState.removeMultiple).toHaveBeenCalledTimes(1);
      expect(mockStoreState.removeMultiple).toHaveBeenCalledWith(
        expect.arrayContaining([expect.any(String)])
      );
    });
  });

  describe("empty history", () => {
    // Inside the sidebar the empty state shares one scroller with the whole
    // nav, and a heading that repeats what the line below it already says costs
    // the Trust links their place on a 900px-tall screen.
    it("says it once in the nested sidebar", () => {
      mockStoreState.conversations = [];
      render(<ConversationList variant="nested" />);

      expect(screen.getByText("Your conversations will gather here.")).toBeInTheDocument();
      expect(screen.queryByText("No conversations yet")).not.toBeInTheDocument();
    });
  });

  describe("search results", () => {
    it("activates the matching branch and remembers message focus", async () => {
      const user = userEvent.setup();
      const { searchMessages } = await import("../../../lib/search");
      vi.mocked(searchMessages).mockResolvedValue([
        {
          conversationId: "conv-yesterday",
          conversationTitle: "Yesterday Chat",
          messageId: "msg-match",
          snippet: "A matching snippet",
          matchIndex: 2,
          highlightStart: 2,
          highlightEnd: 9,
        },
      ]);

      render(<ConversationList />);

      await user.type(
        screen.getByRole("textbox", { name: /search conversations/i }),
        "match",
      );

      await screen.findByRole("option", { name: /yesterday chat/i });
      await user.click(screen.getByRole("option", { name: /yesterday chat/i }));

      expect(mockStoreState.activateSearchResult).toHaveBeenCalledWith(
        "conv-yesterday",
        "msg-match",
      );
      expect(
        window.sessionStorage.getItem("eco-pending-message-focus"),
      ).toContain("\"messageId\":\"msg-match\"");
    });
  });

  describe("recoverable failures", () => {
    it("surfaces browser storage failures when history is empty and keeps empty-history copy", async () => {
      const user = userEvent.setup();
      mockStoreState.conversations = [];
      mockStoreState.persistenceError =
        "Eco updated this conversation in memory, but browser storage could not save conversation history.";

      render(<ConversationList />);

      expect(screen.getByRole("alert")).toHaveTextContent(
        "browser storage could not save conversation history",
      );
      expect(screen.getByText(/Your conversations will gather here/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Dismiss" }));

      expect(mockStoreState.clearPersistenceError).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Your conversations will gather here/)).toBeInTheDocument();
    });

    it("surfaces export failures with a recoverable message", async () => {
      const user = userEvent.setup();
      const { exportConversationAsJSON } = await import("../../../lib/export");
      vi.mocked(exportConversationAsJSON).mockRejectedValueOnce(new Error("IDB unavailable"));

      render(<ConversationList />);

      const menuButtons = screen.getAllByRole("button", { name: "Conversation menu" });
      await user.click(menuButtons[0]!);
      await user.click(screen.getByRole("menuitem", { name: "Export as JSON" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Eco could not export that conversation as JSON",
      );
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    });

    it("surfaces browser storage failures and lets users dismiss them", async () => {
      const user = userEvent.setup();
      mockStoreState.persistenceError =
        "Eco updated this conversation in memory, but browser storage could not rename a conversation.";

      render(<ConversationList />);

      expect(screen.getByRole("alert")).toHaveTextContent("browser storage could not rename");
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(mockStoreState.clearPersistenceError).toHaveBeenCalledTimes(1);
    });
  });
});
