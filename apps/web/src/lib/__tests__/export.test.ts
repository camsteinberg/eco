// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbConversation, DbMessage } from "../db";

// Mock the db module before importing export functions
vi.mock("../db", () => ({
  openEcoDB: vi.fn(),
  getActiveBranch: vi.fn(),
}));

import {
  ConversationNotFoundError,
  exportConversationAsJSON,
  exportConversationAsMarkdown,
  downloadFile,
} from "../export";
import { openEcoDB, getActiveBranch } from "../db";

const mockConversation: DbConversation = {
  id: "conv-1",
  title: "Test Conversation",
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  activeLeafId: "msg-3",
};

const mockMessages: DbMessage[] = [
  {
    id: "msg-1",
    conversationId: "conv-1",
    parentId: null,
    role: "user",
    content: "Hello",
    createdAt: 1700000000100,
  },
  {
    id: "msg-2",
    conversationId: "conv-1",
    parentId: "msg-1",
    role: "assistant",
    content: "Hi there",
    createdAt: 1700000000200,
  },
  {
    id: "msg-3",
    conversationId: "conv-1",
    parentId: "msg-2",
    role: "user",
    content: "How are you?",
    createdAt: 1700000000300,
  },
];

const branchMessages: DbMessage[] = [
  mockMessages[0]!,
  mockMessages[1]!,
  mockMessages[2]!,
];

function createMockDb() {
  return {
    get: vi.fn(),
    getAllFromIndex: vi.fn(),
  };
}

describe("exportConversationAsJSON", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    vi.mocked(openEcoDB).mockResolvedValue(mockDb as never);
  });

  it("returns JSON with version, exportedAt, conversation object, and all messages array", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    mockDb.getAllFromIndex.mockResolvedValue(mockMessages);

    const result = await exportConversationAsJSON("conv-1");
    const parsed = JSON.parse(result);

    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBeTypeOf("number");
    expect(parsed.conversation).toEqual(mockConversation);
    expect(parsed.messages).toEqual(mockMessages);
  });

  it("includes messages from all branches (not just active branch)", async () => {
    // Add a sibling branch message not in the active branch
    const allMessages: DbMessage[] = [
      ...mockMessages,
      {
        id: "msg-2b",
        conversationId: "conv-1",
        parentId: "msg-1",
        role: "assistant",
        content: "Alternative response",
        createdAt: 1700000000250,
      },
    ];
    mockDb.get.mockResolvedValue(mockConversation);
    mockDb.getAllFromIndex.mockResolvedValue(allMessages);

    const result = await exportConversationAsJSON("conv-1");
    const parsed = JSON.parse(result);

    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages.map((m: DbMessage) => m.id)).toContain("msg-2b");
  });

  it("throws a typed ConversationNotFoundError for a non-existent ID", async () => {
    mockDb.get.mockResolvedValue(undefined);

    // Typed, not string-matched: the share dialog narrows on the class to tell
    // "this conversation is gone" apart from "the clipboard refused".
    await expect(exportConversationAsJSON("nonexistent")).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
    await expect(exportConversationAsJSON("nonexistent")).rejects.toMatchObject({
      conversationId: "nonexistent",
    });
  });
});

describe("exportConversationAsMarkdown", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    vi.mocked(openEcoDB).mockResolvedValue(mockDb as never);
  });

  it("returns markdown with title heading, export date, and flattened active branch messages with role labels and timestamps", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(branchMessages);

    const result = await exportConversationAsMarkdown("conv-1");

    expect(result).toContain("# Test Conversation");
    expect(result).toContain("*Exported from Eco on ");
    expect(result).toContain("**You**");
    expect(result).toContain("**Eco**");
    expect(result).toContain("Hello");
    expect(result).toContain("Hi there");
    expect(result).toContain("How are you?");
    expect(result).toContain("---");
  });

  it("states that the file holds the active branch only", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(branchMessages);

    const result = await exportConversationAsMarkdown("conv-1");

    expect(result).toContain(
      "*This file contains the active branch of the conversation only.*"
    );
  });

  it("lists the sources under an assistant message that has citations", async () => {
    const grounded: DbMessage[] = [
      mockMessages[0]!,
      {
        ...mockMessages[1]!,
        citations: [
          { id: 1, title: "Photosynthesis", url: "https://example.org/photosynthesis" },
          { id: 2, title: "", url: "https://example.org/untitled" },
        ],
      },
    ];
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(grounded);

    const result = await exportConversationAsMarkdown("conv-1");

    expect(result).toContain("Sources:");
    expect(result).toContain("- [Photosynthesis](https://example.org/photosynthesis)");
    // No title to show, so the URL is the link text rather than an empty label.
    expect(result).toContain("- [https://example.org/untitled](https://example.org/untitled)");
  });

  it("adds no Sources line to a message without citations", async () => {
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(branchMessages);

    const result = await exportConversationAsMarkdown("conv-1");

    expect(result).not.toContain("Sources:");
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
      ...branchMessages,
    ];
    mockDb.get.mockResolvedValue(mockConversation);
    vi.mocked(getActiveBranch).mockResolvedValue(messagesWithSystem);

    const result = await exportConversationAsMarkdown("conv-1");

    expect(result).not.toContain("You are a helpful assistant");
    expect(result).toContain("Hello");
  });
});

describe("downloadFile", () => {
  it("creates blob, anchor element, triggers click, and revokes URL", () => {
    const createObjectURLMock = vi.fn().mockReturnValue("blob:test-url");
    const revokeObjectURLMock = vi.fn();
    global.URL.createObjectURL = createObjectURLMock;
    global.URL.revokeObjectURL = revokeObjectURLMock;

    const clickMock = vi.fn();
    const mockAnchor = {
      href: "",
      download: "",
      click: clickMock,
    };
    vi.spyOn(document, "createElement").mockReturnValue(
      mockAnchor as unknown as HTMLAnchorElement
    );

    downloadFile("test content", "test.json", "application/json");

    expect(document.createElement).toHaveBeenCalledWith("a");
    expect(createObjectURLMock).toHaveBeenCalled();
    expect(mockAnchor.href).toBe("blob:test-url");
    expect(mockAnchor.download).toBe("test.json");
    expect(clickMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:test-url");
  });
});
