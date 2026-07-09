// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

describe("useMediaQuery", () => {
  let listeners: Array<(e: { matches: boolean }) => void>;
  let currentMatches: boolean;

  beforeEach(() => {
    listeners = [];
    currentMatches = false;

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn((query: string) => ({
        matches: currentMatches,
        media: query,
        addEventListener: vi.fn(
          (_event: string, cb: (e: { matches: boolean }) => void) => {
            listeners.push(cb);
          }
        ),
        removeEventListener: vi.fn(
          (_event: string, cb: (e: { matches: boolean }) => void) => {
            listeners = listeners.filter((l) => l !== cb);
          }
        ),
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false initially (SSR-safe)", async () => {
    const { useMediaQuery } = await import("../useMediaQuery");
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    // Before useEffect runs, value is false
    expect(result.current).toBe(false);
  });

  it("returns true when matchMedia matches", async () => {
    currentMatches = true;
    const { useMediaQuery } = await import("../useMediaQuery");
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    // After useEffect runs, picks up matchMedia value
    expect(result.current).toBe(true);
  });

  it("updates when media query changes", async () => {
    currentMatches = false;
    const { useMediaQuery } = await import("../useMediaQuery");
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);

    // Simulate media query change
    act(() => {
      for (const listener of listeners) {
        listener({ matches: true });
      }
    });

    expect(result.current).toBe(true);
  });

  it("cleans up listener on unmount", async () => {
    const { useMediaQuery } = await import("../useMediaQuery");
    const { unmount } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    const listenerCountBefore = listeners.length;
    unmount();
    // removeEventListener should have been called, reducing listeners
    expect(listeners.length).toBeLessThan(listenerCountBefore);
  });
});
