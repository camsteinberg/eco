// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EmptyState } from "../EmptyState";

describe("EmptyState", () => {
  it("renders illustration slot", () => {
    render(
      <EmptyState
        illustration={<svg data-testid="illustration" />}
        title="No items"
        description="Get started by creating one."
      />
    );
    expect(screen.getByTestId("illustration")).toBeInTheDocument();
  });

  it("renders title and description text", () => {
    render(
      <EmptyState
        illustration={<span>icon</span>}
        title="No conversations"
        description="Start a new chat to begin."
      />
    );
    expect(screen.getByText("No conversations")).toBeInTheDocument();
    expect(screen.getByText("Start a new chat to begin.")).toBeInTheDocument();
  });

  it("renders action button when action prop provided", () => {
    render(
      <EmptyState
        illustration={<span>icon</span>}
        title="Empty"
        description="Nothing here."
        action={{ label: "Create New", onClick: vi.fn() }}
      />
    );
    expect(screen.getByRole("button", { name: "Create New" })).toBeInTheDocument();
  });

  it("calls action onClick when action button clicked", async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        illustration={<span>icon</span>}
        title="Empty"
        description="Nothing here."
        action={{ label: "Create", onClick }}
      />
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders action as link when href provided", () => {
    render(
      <EmptyState
        illustration={<span>icon</span>}
        title="Empty"
        description="Nothing here."
        action={{ label: "Learn More", href: "/docs" }}
      />
    );
    const link = screen.getByRole("link", { name: "Learn More" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/docs");
  });

  it("does not render action when no action prop", () => {
    render(
      <EmptyState
        illustration={<span>icon</span>}
        title="Empty"
        description="Nothing here."
      />
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
