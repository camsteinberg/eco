// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BottomSheet } from "../BottomSheet";

describe("BottomSheet", () => {
  it("renders nothing when open is false", () => {
    const { container } = render(
      <BottomSheet open={false} onClose={vi.fn()}>
        <p>Content</p>
      </BottomSheet>
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders backdrop and sheet content when open is true", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()}>
        <p>Sheet content</p>
      </BottomSheet>
    );
    expect(screen.getByText("Sheet content")).toBeInTheDocument();
    // Backdrop should exist (aria-hidden div)
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("has role=dialog and aria-modal=true", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()} title="Test Sheet">
        <p>Content</p>
      </BottomSheet>
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("uses the title as the accessible dialog name", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()} title="Conversations">
        <p>Content</p>
      </BottomSheet>
    );
    const dialog = screen.getByRole("dialog", { name: "Conversations" });
    expect(dialog).toHaveAttribute("aria-labelledby");
  });

  it("renders an accessible close button and calls onClose when clicked", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} onClose={onClose} title="Navigation">
        <p>Content</p>
      </BottomSheet>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Navigation" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and restores focus to the trigger", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">Open navigation</button>
        <BottomSheet open={false} onClose={onClose} title="Navigation">
          <p>Content</p>
        </BottomSheet>
      </>
    );
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    trigger.focus();

    rerender(
      <>
        <button type="button">Open navigation</button>
        <BottomSheet open={true} onClose={onClose} title="Navigation">
          <p>Content</p>
        </BottomSheet>
      </>
    );

    expect(screen.getByRole("button", { name: "Close Navigation" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <>
        <button type="button">Open navigation</button>
        <BottomSheet open={false} onClose={onClose} title="Navigation">
          <p>Content</p>
        </BottomSheet>
      </>
    );
    expect(trigger).toHaveFocus();
  });

  it("contains keyboard focus inside the open sheet", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()} title="Navigation">
        <a href="/chat">Chat</a>
        <button type="button">Open models</button>
      </BottomSheet>
    );

    const closeButton = screen.getByRole("button", { name: "Close Navigation" });
    const lastAction = screen.getByRole("button", { name: "Open models" });

    expect(closeButton).toHaveFocus();

    lastAction.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(lastAction).toHaveFocus();
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} onClose={onClose}>
        <p>Content</p>
      </BottomSheet>
    );
    // The backdrop is the aria-hidden div
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a drag handle bar at the top", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()}>
        <p>Content</p>
      </BottomSheet>
    );
    const dialog = screen.getByRole("dialog");
    // Drag handle: a small rounded bar element
    const handle = dialog.querySelector('[data-testid="drag-handle"]');
    expect(handle).toBeInTheDocument();
  });

  it("renders title when provided", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()} title="My Title">
        <p>Content</p>
      </BottomSheet>
    );
    expect(screen.getByText("My Title")).toBeInTheDocument();
  });

  it("does not render title when not provided", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()}>
        <p>Content</p>
      </BottomSheet>
    );
    // No title element rendered
    const dialog = screen.getByRole("dialog");
    const titleEl = dialog.querySelector('[data-testid="sheet-title"]');
    expect(titleEl).toBeNull();
  });

  it("renders children content", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()}>
        <div data-testid="child">Hello</div>
      </BottomSheet>
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("hides from md up by default", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()}>
        <p>Content</p>
      </BottomSheet>
    );
    const host = screen.getByRole("dialog").parentElement;
    expect(host).toHaveClass("md:hidden");
    expect(host).not.toHaveClass("lg:hidden");
  });

  it("hides from lg up when hiddenFrom is lg, so the sheet survives tablet widths", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()} hiddenFrom="lg">
        <p>Content</p>
      </BottomSheet>
    );
    const host = screen.getByRole("dialog").parentElement;
    expect(host).toHaveClass("lg:hidden");
    expect(host).not.toHaveClass("md:hidden");
  });

  it("renders into document.body rather than its parent, so ancestor stacking contexts cannot trap it", () => {
    const { container } = render(
      <div style={{ transform: "translateZ(0)", zIndex: 1 }}>
        <BottomSheet open={true} onClose={vi.fn()} title="Navigation">
          <p>Sheet content</p>
        </BottomSheet>
      </div>
    );

    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog).toBeInTheDocument();
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("constrains long content to an internal scroll body", () => {
    render(
      <BottomSheet open={true} onClose={vi.fn()} title="Long navigation">
        <div data-testid="long-content">
          {Array.from({ length: 40 }, (_, index) => (
            <a href={`/item-${String(index)}`} key={index}>
              Item {index + 1}
            </a>
          ))}
        </div>
      </BottomSheet>
    );

    const dialog = screen.getByRole("dialog", { name: "Long navigation" });
    expect(dialog).toHaveClass(
      "flex",
      "max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom)_-_0.75rem)]",
      "sm:max-h-[85dvh]",
      "flex-col",
      "overflow-hidden",
    );

    const body = screen.getByTestId("bottom-sheet-body");
    expect(body).toHaveClass("min-h-0", "flex-1", "overflow-x-hidden", "overflow-y-auto", "overscroll-contain");
    expect(body).toContainElement(screen.getByTestId("long-content"));
  });

  it("keeps swipe gestures from dismissing while the internal body is scrolled", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} onClose={onClose}>
        <p>Content</p>
      </BottomSheet>
    );
    const dialog = screen.getByRole("dialog");
    const body = screen.getByTestId("bottom-sheet-body");

    Object.defineProperty(body, "scrollTop", {
      value: 24,
      configurable: true,
    });

    fireEvent.touchStart(dialog, {
      touches: [{ clientY: 100 }],
    });
    fireEvent.touchMove(dialog, {
      touches: [{ clientY: 250 }],
    });
    fireEvent.touchEnd(dialog);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on swipe-down past threshold", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} onClose={onClose}>
        <p>Content</p>
      </BottomSheet>
    );
    const dialog = screen.getByRole("dialog");

    // Simulate touch swipe down > 100px
    fireEvent.touchStart(dialog, {
      touches: [{ clientY: 100 }],
    });
    fireEvent.touchMove(dialog, {
      touches: [{ clientY: 250 }],
    });
    fireEvent.touchEnd(dialog);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose on small swipe", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} onClose={onClose}>
        <p>Content</p>
      </BottomSheet>
    );
    const dialog = screen.getByRole("dialog");

    // Simulate small swipe (< 100px)
    fireEvent.touchStart(dialog, {
      touches: [{ clientY: 100 }],
    });
    fireEvent.touchMove(dialog, {
      touches: [{ clientY: 150 }],
    });
    fireEvent.touchEnd(dialog);

    expect(onClose).not.toHaveBeenCalled();
  });
});
