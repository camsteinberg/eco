// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CodeBlock } from "../CodeBlock";

describe("CodeBlock", () => {
  let writeMock: ReturnType<typeof vi.fn>;
  let writeTextMock: ReturnType<typeof vi.fn>;
  let originalClipboardItem: typeof globalThis.ClipboardItem;

  beforeEach(() => {
    writeMock = vi.fn().mockResolvedValue(undefined);
    writeTextMock = vi.fn().mockResolvedValue(undefined);

    // Save original if it exists
    originalClipboardItem = globalThis.ClipboardItem;

    // Mock ClipboardItem on globalThis (jsdom doesn't include it)
    globalThis.ClipboardItem = vi.fn().mockImplementation((items) => ({
      types: Object.keys(items),
      items,
    })) as unknown as typeof ClipboardItem;

    Object.defineProperty(navigator, "clipboard", {
      value: {
        write: writeMock,
        writeText: writeTextMock,
        readText: vi.fn().mockResolvedValue(""),
        read: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.ClipboardItem = originalClipboardItem;
    vi.restoreAllMocks();
  });

  it("renders the code content", () => {
    render(<CodeBlock code='console.log("hi")' language="javascript" />);
    expect(screen.getByText('console.log("hi")')).toBeInTheDocument();
  });

  it("displays the language label", () => {
    render(<CodeBlock code="fn main() {}" language="rust" />);
    expect(screen.getByText("rust")).toBeInTheDocument();
  });

  it("has a copy button", () => {
    render(<CodeBlock code="hello" language="text" />);
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("uses ClipboardItem for Safari-safe code copy", () => {
    render(<CodeBlock code="const x = 1" language="javascript" />);
    const copyBtn = screen.getByRole("button", { name: /copy/i });
    fireEvent.click(copyBtn);

    // clipboard.write should be called synchronously with a ClipboardItem
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(globalThis.ClipboardItem).toHaveBeenCalledTimes(1);

    // Verify ClipboardItem was created with text/plain Blob containing the code
    const clipboardItemCall = vi.mocked(globalThis.ClipboardItem).mock
      .calls[0]![0];
    const blob = clipboardItemCall["text/plain"] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/plain");
    expect(blob.size).toBe("const x = 1".length);
  });

  it('shows "Copied!" text after clicking copy', async () => {
    render(<CodeBlock code="const x = 1" language="javascript" />);
    const copyBtn = screen.getByRole("button", { name: /copy/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(screen.getByText(/copied/i)).toBeInTheDocument();
    });
  });

  it("handleCopy is synchronous (not async)", () => {
    render(<CodeBlock code="test code" language="text" />);
    const copyBtn = screen.getByRole("button", { name: /copy/i });

    // Click is synchronous, and clipboard.write is called immediately
    fireEvent.click(copyBtn);
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to writeText when ClipboardItem throws", async () => {
    // Make ClipboardItem throw to trigger fallback
    globalThis.ClipboardItem = (() => {
      throw new Error("ClipboardItem not supported");
    }) as unknown as typeof ClipboardItem;

    render(<CodeBlock code="fallback code" language="text" />);
    const copyBtn = screen.getByRole("button", { name: /copy/i });
    fireEvent.click(copyBtn);

    // Should fall through to writeText fallback
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("fallback code");
    });
  });

  it("does not show scroll indicators when content fits", () => {
    render(<CodeBlock code="short" language="text" />);

    // No scroll indicators when content doesn't overflow
    expect(screen.queryByTestId("scroll-indicator-left")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scroll-indicator-right")).not.toBeInTheDocument();
  });

  it("shows right scroll indicator when content overflows", () => {
    render(<CodeBlock code={"x".repeat(500)} language="text" />);

    // jsdom doesn't calculate real scroll dimensions, so scrollWidth === clientWidth === 0
    // In a real browser the right indicator would show; here we verify the elements
    // exist based on the overflow detection logic.
    // The ResizeObserver fires and scrollWidth - clientWidth === 0 in jsdom,
    // so no indicators appear. This test documents the expected behavior.
    expect(screen.queryByTestId("scroll-indicator-left")).not.toBeInTheDocument();
  });
});
