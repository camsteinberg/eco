// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTextWithFallback } from "../clipboard";

describe("copyTextWithFallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    await copyTextWithFallback("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when clipboard.writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    const execCommandSpy = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      value: execCommandSpy,
      configurable: true,
      writable: true,
    });

    await copyTextWithFallback("hello");

    expect(execCommandSpy).toHaveBeenCalledWith("copy");
  });

  it("throws when browser fallback cannot copy", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => false),
      configurable: true,
      writable: true,
    });

    await expect(copyTextWithFallback("hello")).rejects.toThrow(
      "Clipboard copy failed",
    );
  });

  it("falls back when clipboard.writeText hangs", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(() => new Promise(() => undefined)) },
      configurable: true,
      writable: true,
    });
    const execCommandSpy = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      value: execCommandSpy,
      configurable: true,
      writable: true,
    });

    const copyPromise = copyTextWithFallback("hello");
    await vi.advanceTimersByTimeAsync(1500);
    await copyPromise;

    expect(execCommandSpy).toHaveBeenCalledWith("copy");
  });
});
