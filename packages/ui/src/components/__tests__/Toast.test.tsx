// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen, renderHook } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ToastProvider, useToast } from "../Toast";

// Mock motion/react to avoid animation complexities in tests
vi.mock("motion/react", () => ({
  motion: {
    div: "div",
    li: "li",
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  useReducedMotion: () => false,
}));

describe("Toast", () => {
  it("renders ToastProvider without error", () => {
    render(
      <ToastProvider>
        <div data-testid="child">content</div>
      </ToastProvider>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("useToast returns a toast function", () => {
    const { result } = renderHook(() => useToast(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ToastProvider>{children}</ToastProvider>
      ),
    });
    expect(typeof result.current.toast).toBe("function");
  });

  it("useToast returns default noop outside provider", () => {
    const { result } = renderHook(() => useToast());
    expect(typeof result.current.toast).toBe("function");
    // Should not throw when called outside provider
    expect(() => result.current.toast("test")).not.toThrow();
  });
});
