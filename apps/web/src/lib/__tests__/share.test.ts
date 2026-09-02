// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DbConversation, DbMessage } from "../db";

// Polyfill ClipboardItem for jsdom (not available in test env)
class MockClipboardItem {
  readonly types: string[];
  private _data: Record<string, Blob>;
  constructor(data: Record<string, Blob>) {
    this._data = data;
    this.types = Object.keys(data);
  }
  async getType(type: string): Promise<Blob> {
    return this._data[type]!;
  }
}
(globalThis as Record<string, unknown>).ClipboardItem = MockClipboardItem;

// Mock the db module
vi.mock("../db", () => ({
  openEcoDB: vi.fn(),
  getActiveBranch: vi.fn(),
}));

// Mock the export module
vi.mock("../export", () => ({
  exportConversationAsMarkdown: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("../clipboard", () => ({
  copyTextWithFallback: vi.fn(() => Promise.resolve()),
}));

import {
  copyConversationAsMarkdown,
  generateShareableHTML,
  downloadShareableHTML,
} from "../share";
import { openEcoDB, getActiveBranch } from "../db";
import { exportConversationAsMarkdown, downloadFile } from "../export";
import { copyTextWithFallback } from "../clipboard";

const mockConversation: DbConversation = {
  id: "conv-1",
  title: "Test Conversation",
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  activeLeafId: "msg-2",
};

const mockMessages: DbMessage[] = [
  {
    id: "msg-1",
    conversationId: "conv-1",
    parentId: null,
    role: "user",
    content: "Hello there",
    createdAt: 1700000000100,
  },
  {
    id: "msg-2",
    conversationId: "conv-1",
    parentId: "msg-1",
    role: "assistant",
    content: "Hi, how can I help?",
    createdAt: 1700000000200,
  },
];

function createMockDb() {
  return {
    get: vi.fn(),
    getAllFromIndex: vi.fn(),
  };
}

describe("copyConversationAsMarkdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls exportConversationAsMarkdown and writes to clipboard", async () => {
    const mockMarkdown = "# Test\n\nHello there";
    vi.mocked(exportConversationAsMarkdown).mockResolvedValue(mockMarkdown);

    const writeMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { write: writeMock },
      writable: true,
      configurable: true,
    });

    await copyConversationAsMarkdown("conv-1");

    expect(exportConversationAsMarkdown).toHaveBeenCalledWith("conv-1");
    expect(writeMock).toHaveBeenCalledTimes(1);

    const clipboardItems = writeMock.mock.calls[0]![0] as unknown[];
    expect(clipboardItems).toHaveLength(1);
    expect(clipboardItems[0]).toBeInstanceOf(MockClipboardItem);
  });

  it("falls back to text copy when ClipboardItem write fails", async () => {
    const mockMarkdown = "# Test\n\nHello there";
    vi.mocked(exportConversationAsMarkdown).mockResolvedValue(mockMarkdown);

    const writeMock = vi.fn().mockRejectedValue(new Error("write failed"));
    Object.defineProperty(navigator, "clipboard", {
      value: { write: writeMock, writeText: vi.fn() },
      writable: true,
      configurable: true,
    });

    await copyConversationAsMarkdown("conv-1");

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(copyTextWithFallback).toHaveBeenCalledWith(mockMarkdown);
  });

  it("falls back to text copy when ClipboardItem write hangs", async () => {
    vi.useFakeTimers();
    const mockMarkdown = "# Test\n\nHello there";
    vi.mocked(exportConversationAsMarkdown).mockResolvedValue(mockMarkdown);

    const writeMock = vi.fn(() => new Promise(() => undefined));
    Object.defineProperty(navigator, "clipboard", {
      value: { write: writeMock, writeText: vi.fn() },
      writable: true,
      configurable: true,
    });

    const copyPromise = copyConversationAsMarkdown("conv-1");
    await vi.advanceTimersByTimeAsync(1500);
    await copyPromise;

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(copyTextWithFallback).toHaveBeenCalledWith(mockMarkdown);
  });
});

describe("generateShareableHTML", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    vi.mocked(openEcoDB).mockResolvedValue(mockDb as never);
  });

  it("returns string containing <!DOCTYPE html>", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(mockMessages);

    const result = await generateShareableHTML("conv-1");

    expect(result).toContain("<!DOCTYPE html>");
  });

  it("normalizes an assistant body's markdown artifacts on read", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue([
      { ...mockMessages[0]!, role: "user", content: "hi" },
      { ...mockMessages[1]!, role: "assistant", content: "*   Track income\n*   Track spend" },
    ]);

    const html = await generateShareableHTML("conv-1");

    expect(html).toContain("* Track income");
    expect(html).not.toContain("*   Track");
  });

  it("includes conversation title", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(mockMessages);

    const result = await generateShareableHTML("conv-1");

    expect(result).toContain("Test Conversation");
  });

  it("includes message content from active branch", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(mockMessages);

    const result = await generateShareableHTML("conv-1");

    expect(result).toContain("Hello there");
    expect(result).toContain("Hi, how can I help?");
    expect(result).toContain("You");
    expect(result).toContain("Eco");
  });

  it("skips system messages", async () => {
    const messagesWithSystem: DbMessage[] = [
      {
        id: "sys-1",
        conversationId: "conv-1",
        parentId: null,
        role: "system",
        content: "You are a helpful assistant",
        createdAt: 1700000000050,
      },
      ...mockMessages,
    ];
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(messagesWithSystem);

    const result = await generateShareableHTML("conv-1");

    expect(result).not.toContain("You are a helpful assistant");
    expect(result).toContain("Hello there");
  });

  it("includes Eco branding text", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(mockMessages);

    const result = await generateShareableHTML("conv-1");

    expect(result).toContain("Shared from Eco");
  });

  it("handles conversation with no messages gracefully", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue([]);

    const result = await generateShareableHTML("conv-1");

    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("No messages in this conversation");
  });
});

describe("downloadShareableHTML", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    vi.mocked(openEcoDB).mockResolvedValue(mockDb as never);
  });

  it("calls downloadFile with HTML content and .html extension", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(mockMessages);

    await downloadShareableHTML("conv-1", "My Chat");

    expect(downloadFile).toHaveBeenCalledTimes(1);
    const [html, filename, mimeType] = vi.mocked(downloadFile).mock.calls[0]!;
    expect(html).toContain("<!DOCTYPE html>");
    expect(filename).toBe("My Chat.html");
    expect(mimeType).toBe("text/html");
  });
});
