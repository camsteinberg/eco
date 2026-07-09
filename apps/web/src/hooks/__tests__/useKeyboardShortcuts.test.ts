// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "../useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
  let handlers: {
    newChat: ReturnType<typeof vi.fn>;
    toggleSidebar: ReturnType<typeof vi.fn>;
    showShortcuts: ReturnType<typeof vi.fn>;
    collapseSidebar: ReturnType<typeof vi.fn>;
    exportMarkdown: ReturnType<typeof vi.fn>;
    exportJSON: ReturnType<typeof vi.fn>;
    openCommandPalette: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    handlers = {
      newChat: vi.fn(),
      toggleSidebar: vi.fn(),
      showShortcuts: vi.fn(),
      collapseSidebar: vi.fn(),
      exportMarkdown: vi.fn(),
      exportJSON: vi.fn(),
      openCommandPalette: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fireKey(
    key: string,
    opts: Partial<KeyboardEventInit> = {},
    target?: HTMLElement
  ) {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    (target ?? document).dispatchEvent(event);
    return event;
  }

  it("calls newChat on Ctrl+N", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey("n", { ctrlKey: true });
    expect(handlers.newChat).toHaveBeenCalledTimes(1);
  });

  it("calls newChat on Meta+N (Mac)", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey("n", { metaKey: true });
    expect(handlers.newChat).toHaveBeenCalledTimes(1);
  });

  it("calls toggleSidebar on Ctrl+Shift+S", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey("S", { ctrlKey: true, shiftKey: true });
    expect(handlers.toggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("calls showShortcuts on Ctrl+/", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey("/", { ctrlKey: true });
    expect(handlers.showShortcuts).toHaveBeenCalledTimes(1);
  });

  it("prevents default on handled shortcuts", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    const spy = vi.spyOn(KeyboardEvent.prototype, "preventDefault");
    fireKey("n", { ctrlKey: true });
    expect(spy).toHaveBeenCalled();
  });

  it("does NOT call toggleSidebar when focus is in a textarea", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    fireKey("S", { ctrlKey: true, shiftKey: true }, textarea);
    expect(handlers.toggleSidebar).not.toHaveBeenCalled();
    document.body.removeChild(textarea);
  });

  it("does NOT call showShortcuts when focus is in an input", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireKey("/", { ctrlKey: true }, input);
    expect(handlers.showShortcuts).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("DOES call newChat even when focus is in a textarea (always fires)", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    fireKey("n", { ctrlKey: true }, textarea);
    expect(handlers.newChat).toHaveBeenCalledTimes(1);
    document.body.removeChild(textarea);
  });

  it("does nothing for unhandled key combos", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey("x", { ctrlKey: true });
    expect(handlers.newChat).not.toHaveBeenCalled();
    expect(handlers.toggleSidebar).not.toHaveBeenCalled();
    expect(handlers.showShortcuts).not.toHaveBeenCalled();
  });

  it("cleans up event listener on unmount", () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts(handlers));
    unmount();
    fireKey("n", { ctrlKey: true });
    expect(handlers.newChat).not.toHaveBeenCalled();
  });

  // --- New shortcut tests ---

  it("calls collapseSidebar on Ctrl+B", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey("b", { ctrlKey: true });
    expect(handlers.collapseSidebar).toHaveBeenCalledTimes(1);
  });

  it("does NOT call collapseSidebar when focus is in an input", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireKey("b", { ctrlKey: true }, input);
    expect(handlers.collapseSidebar).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("calls exportMarkdown on Ctrl+Shift+E", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey("E", { ctrlKey: true, shiftKey: true });
    expect(handlers.exportMarkdown).toHaveBeenCalledTimes(1);
  });

  it("does NOT call exportMarkdown when focus is in a textarea", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    fireKey("E", { ctrlKey: true, shiftKey: true }, textarea);
    expect(handlers.exportMarkdown).not.toHaveBeenCalled();
    document.body.removeChild(textarea);
  });

  it("calls exportJSON on Ctrl+Shift+D", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey("D", { ctrlKey: true, shiftKey: true });
    expect(handlers.exportJSON).toHaveBeenCalledTimes(1);
  });

  it("calls openCommandPalette on Ctrl+K", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey("k", { ctrlKey: true });
    expect(handlers.openCommandPalette).toHaveBeenCalledTimes(1);
  });

  it("DOES call openCommandPalette even when focus is in a textarea (global shortcut)", () => {
    renderHook(() => useKeyboardShortcuts(handlers));
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    fireKey("k", { ctrlKey: true }, textarea);
    expect(handlers.openCommandPalette).toHaveBeenCalledTimes(1);
    document.body.removeChild(textarea);
  });

  it("does not fire handlers when handler is not provided", () => {
    // Pass only the original handlers, omitting new ones
    const partialHandlers = {
      newChat: vi.fn(),
    };
    renderHook(() => useKeyboardShortcuts(partialHandlers));
    // Should not throw when firing shortcuts for missing handlers
    fireKey("b", { ctrlKey: true });
    fireKey("E", { ctrlKey: true, shiftKey: true });
    fireKey("D", { ctrlKey: true, shiftKey: true });
    fireKey("k", { ctrlKey: true });
    // No assertion needed — just verifying no throw
  });
});
