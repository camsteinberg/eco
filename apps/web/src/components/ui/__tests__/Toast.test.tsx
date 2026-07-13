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
