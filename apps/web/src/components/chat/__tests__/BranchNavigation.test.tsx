// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { BranchNavigation } from "../BranchNavigation";

vi.mock("motion/react", () => ({
  motion: {
    span: ({ children, ...props }: Record<string, unknown>) => {
      const { initial: _i, animate: _a, exit: _e, transition: _t, ...rest } = props;
      return <span {...rest}>{children as React.ReactNode}</span>;
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
}));

describe("BranchNavigation", () => {
  it("renders nothing when totalSiblings <= 1", () => {
    const { container } = render(
      <BranchNavigation
        currentIndex={0}
        totalSiblings={1}
        onPrevious={() => {}}
        onNext={() => {}}
      />
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows '1 / 3' when totalSiblings = 3 and currentIndex = 0", () => {
    render(
      <BranchNavigation
        currentIndex={0}
        totalSiblings={3}
        onPrevious={() => {}}
        onNext={() => {}}
      />
    );
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("shows '2 / 3' when totalSiblings = 3 and currentIndex = 1", () => {
    render(
      <BranchNavigation
        currentIndex={1}
        totalSiblings={3}
        onPrevious={() => {}}
        onNext={() => {}}
      />
    );
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("previous button disabled when currentIndex = 0", () => {
    render(
      <BranchNavigation
        currentIndex={0}
        totalSiblings={3}
        onPrevious={() => {}}
        onNext={() => {}}
      />
    );
    const prevBtn = screen.getByRole("button", { name: "Previous version" });
    expect(prevBtn).toBeDisabled();
  });

  it("next button disabled when currentIndex = totalSiblings - 1", () => {
    render(
      <BranchNavigation
        currentIndex={2}
        totalSiblings={3}
        onPrevious={() => {}}
        onNext={() => {}}
      />
    );
    const nextBtn = screen.getByRole("button", { name: "Next version" });
    expect(nextBtn).toBeDisabled();
  });

  it("clicking next calls onNext", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(
      <BranchNavigation
        currentIndex={0}
        totalSiblings={3}
        onPrevious={() => {}}
        onNext={onNext}
      />
    );
    await user.click(screen.getByRole("button", { name: "Next version" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("clicking previous calls onPrevious", async () => {
    const user = userEvent.setup();
    const onPrevious = vi.fn();
    render(
      <BranchNavigation
        currentIndex={1}
        totalSiblings={3}
        onPrevious={onPrevious}
        onNext={() => {}}
      />
    );
    await user.click(screen.getByRole("button", { name: "Previous version" }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it("has proper aria-labels on buttons", () => {
    render(
      <BranchNavigation
        currentIndex={1}
        totalSiblings={3}
        onPrevious={() => {}}
        onNext={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Previous version" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next version" })).toBeInTheDocument();
  });
});
