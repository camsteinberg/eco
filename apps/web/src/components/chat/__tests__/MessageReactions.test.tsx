// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MessageReactions } from "../MessageReactions";
import type { MessageReaction } from "../../../lib/db";

describe("MessageReactions", () => {
  const defaultProps = {
    reactions: [] as MessageReaction[],
    onReact: vi.fn(),
    onRemoveReaction: vi.fn(),
  };

  it("renders reaction buttons for thumbs-up, thumbs-down, heart, leaf", () => {
    render(<MessageReactions {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Helpful" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not helpful" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Love it" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eco!" })).toBeInTheDocument();
  });

  it("clicking a reaction button calls onReact with the emoji string", async () => {
    const onReact = vi.fn();
    const user = userEvent.setup();
    render(<MessageReactions {...defaultProps} onReact={onReact} />);

    await user.click(screen.getByRole("button", { name: "Helpful" }));
    expect(onReact).toHaveBeenCalledWith("thumbs-up");
  });

  it("active reactions are visually highlighted", () => {
    const reactions: MessageReaction[] = [
      { emoji: "heart", timestamp: Date.now() },
    ];
    render(<MessageReactions {...defaultProps} reactions={reactions} />);

    const heartButton = screen.getByRole("button", { name: "Love it" });
    expect(heartButton.className).toContain("active");
  });

  it("clicking an active reaction calls onRemoveReaction", async () => {
    const onRemoveReaction = vi.fn();
    const user = userEvent.setup();
    const reactions: MessageReaction[] = [
      { emoji: "thumbs-up", timestamp: Date.now() },
    ];
    render(
      <MessageReactions
        {...defaultProps}
        reactions={reactions}
        onRemoveReaction={onRemoveReaction}
      />
    );

    await user.click(screen.getByRole("button", { name: "Helpful" }));
    expect(onRemoveReaction).toHaveBeenCalledWith("thumbs-up");
  });

  it("leaf button has the leaf-flutter animation class when active", () => {
    const reactions: MessageReaction[] = [
      { emoji: "leaf", timestamp: Date.now() },
    ];
    render(<MessageReactions {...defaultProps} reactions={reactions} />);

    const leafButton = screen.getByRole("button", { name: "Eco!" });
    expect(leafButton.className).toContain("leaf-flutter");
  });

  it("each button has an aria-label", () => {
    render(<MessageReactions {...defaultProps} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(4);
    buttons.forEach((button) => {
      expect(button).toHaveAttribute("aria-label");
    });
  });

  it("shows reactions row at full opacity when reactions are active", () => {
    const reactions: MessageReaction[] = [
      { emoji: "heart", timestamp: Date.now() },
    ];
    const { container } = render(
      <MessageReactions {...defaultProps} reactions={reactions} />
    );
    // When there are active reactions, the row should NOT have opacity-0
    const row = container.firstElementChild;
    expect(row?.className).not.toContain("opacity-0");
  });

  it("clicking inactive reaction calls onReact not onRemoveReaction", async () => {
    const onReact = vi.fn();
    const onRemoveReaction = vi.fn();
    const user = userEvent.setup();
    const reactions: MessageReaction[] = [
      { emoji: "heart", timestamp: Date.now() },
    ];
    render(
      <MessageReactions
        {...defaultProps}
        reactions={reactions}
        onReact={onReact}
        onRemoveReaction={onRemoveReaction}
      />
    );

    // Click an inactive reaction (thumbs-up)
    await user.click(screen.getByRole("button", { name: "Helpful" }));
    expect(onReact).toHaveBeenCalledWith("thumbs-up");
    expect(onRemoveReaction).not.toHaveBeenCalled();
  });
});
