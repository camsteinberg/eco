// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SearchResults } from "../SearchResults";
import type { SearchResult } from "../../../lib/search";

const mockResults: SearchResult[] = [
  {
    conversationId: "conv-1",
    conversationTitle: "Chat about Rust",
    messageId: "msg-1",
    snippet: "...about Rust programming language...",
    matchIndex: 9,
    highlightStart: 9,
    highlightEnd: 13,
  },
  {
    conversationId: "conv-2",
    conversationTitle: "Python tutorial",
    messageId: "msg-2",
    snippet: "How to learn Python quickly...",
    matchIndex: 14,
    highlightStart: 14,
    highlightEnd: 20,
  },
];

describe("SearchResults", () => {
  it("renders result items with title and highlighted snippet", () => {
    render(
      <SearchResults
        results={mockResults}
        query="Rust"
        onSelectResult={() => {}}
      />
    );

    expect(screen.getByText("Chat about Rust")).toBeInTheDocument();
    expect(screen.getByText("Python tutorial")).toBeInTheDocument();
  });

  it("calls onSelectResult with correct ids on click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SearchResults results={mockResults} query="Rust" onSelectResult={onSelect} />
    );

    const options = screen.getAllByRole("option");
    await user.click(options[0]!);

    expect(onSelect).toHaveBeenCalledWith("conv-1", "msg-1");
  });

  it("shows empty state with leaf illustration when results is empty and query is non-empty", () => {
    render(
      <SearchResults results={[]} query="zzz" onSelectResult={() => {}} />
    );

    expect(screen.getByText("No conversations found")).toBeInTheDocument();
    expect(
      screen.getByText("Try different words, or start a new conversation.")
    ).toBeInTheDocument();
  });

  it("highlights keyword in snippet with mark element", () => {
    render(
      <SearchResults
        results={mockResults}
        query="Rust"
        onSelectResult={() => {}}
      />
    );

    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(0);
  });
});
