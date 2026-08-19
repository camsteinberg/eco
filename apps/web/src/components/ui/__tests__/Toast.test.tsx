// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { useEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "../Toast";

function Fire({ durationMs }: { durationMs?: number }) {
  const { toast } = useToast();
  useEffect(() => {
    toast("hello", "info", durationMs);
  }, [toast, durationMs]);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Toast durationMs", () => {
  it("auto-dismisses at the 3s default when no duration is given", () => {
    render(
      <ToastProvider>
        <Fire />
      </ToastProvider>,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
    // 3s dismiss + 200ms exit transition.
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("outlives the 3s default when a longer duration is passed", () => {
    render(
      <ToastProvider>
        <Fire durationMs={8000} />
      </ToastProvider>,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
    // Still visible well past the default window…
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(screen.getByText("hello")).toBeInTheDocument();
    // …and gone after its own longer window elapses.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });
});

describe("Toast container", () => {
  it("caps its width and keeps clear of the chat surface's help button", () => {
    const { container } = render(
      <ToastProvider>
        <Fire />
      </ToastProvider>,
    );
    const stack = container.querySelector("div.fixed");

    // Without a cap a long notice (the retired-model one) becomes a single
    // ~980px line; the right offset clears the 68px lane the help button owns.
    expect(stack?.className).toContain("w-80");
    expect(stack?.className).toContain("max-w-[calc(100vw-6rem)]");
    expect(stack?.className).toContain("right-[4.75rem]");
  });
});
