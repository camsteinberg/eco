// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from "vitest";
import { strFromU8 } from "fflate";

// Mock openEcoDB
const mockGetAllConversations = vi.fn();
const mockGetAllFromIndexMessages = vi.fn();
const mockEcoDbClose = vi.fn();

const mockOpenEcoDB = vi.fn(async () => ({
  getAll: mockGetAllConversations,
  getAllFromIndex: mockGetAllFromIndexMessages,
  close: mockEcoDbClose,
}));

vi.mock("../db", () => ({
  openEcoDB: (...args: unknown[]) => mockOpenEcoDB(...(args as [])),
}));

// Mock openSettingsDB
const mockGetAllSettings = vi.fn();
const mockGetAllMemories = vi.fn();
const mockSettingsDbClose = vi.fn();

const mockOpenSettingsDB = vi.fn(async () => ({
  getAll: (storeName: string) => {
    if (storeName === "settings") return mockGetAllSettings();
    if (storeName === "memories") return mockGetAllMemories();
    return [];
  },
  close: mockSettingsDbClose,
}));

vi.mock("../settings-db", () => ({
  openSettingsDB: (...args: unknown[]) => mockOpenSettingsDB(...(args as [])),
  decryptSetting: vi.fn((ciphertext: string, _nonce: string) => {
    return "decrypted:" + ciphertext;
  }),
  getOrCreateKey: vi.fn(() => new Uint8Array(32)),
}));

// Capture the file map passed to zipSync so we can inspect contents
// without needing to decompress (avoids jsdom Blob.arrayBuffer issues)
let capturedFiles: Record<string, Uint8Array> = {};

vi.mock("fflate", async (importOriginal) => {
  const original = await importOriginal<typeof import("fflate")>();
  return {
    ...original,
    zipSync: (data: Record<string, Uint8Array>) => {
      capturedFiles = data;
      return original.zipSync(data);
    },
  };
});

let capturedFilename: string | null = null;

const mockRevokeObjectURL = vi.fn();

const mockAnchor = {
  href: "",
  download: "",
  click: vi.fn(),
  style: {} as CSSStyleDeclaration,
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedFiles = {};
  capturedFilename = null;

  // Mock URL
  Object.defineProperty(globalThis, "URL", {
    value: {
      createObjectURL: () => "blob:mock-url",
      revokeObjectURL: mockRevokeObjectURL,
    },
    writable: true,
    configurable: true,
  });

  // Mock document.createElement for <a> download
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag === "a") {
      return new Proxy(mockAnchor, {
        set(target, prop, value) {
          if (prop === "download") capturedFilename = value as string;
          (target as Record<string, unknown>)[prop as string] = value;
          return true;
        },
      }) as unknown as HTMLAnchorElement;
    }
    return document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
  });

  // Default mock returns
  mockOpenEcoDB.mockImplementation(async () => ({
    getAll: mockGetAllConversations,
    getAllFromIndex: mockGetAllFromIndexMessages,
    close: mockEcoDbClose,
  }));
  mockOpenSettingsDB.mockImplementation(async () => ({
    getAll: (storeName: string) => {
      if (storeName === "settings") return mockGetAllSettings();
      if (storeName === "memories") return mockGetAllMemories();
      return [];
    },
    close: mockSettingsDbClose,
  }));
  mockGetAllConversations.mockResolvedValue([]);
  mockGetAllFromIndexMessages.mockResolvedValue([]);
  mockGetAllSettings.mockResolvedValue([]);
  mockGetAllMemories.mockResolvedValue([]);
});

import { exportUserData, UserDataExportUnreadableError } from "../data-export";

describe("exportUserData", () => {
  it("creates a ZIP blob containing required files", async () => {
    await exportUserData({ name: "Test User", email: "test@example.com" });

    const files = Object.keys(capturedFiles);

    expect(files).toContain("README.txt");
    expect(files).toContain("profile.json");
    expect(files).toContain("settings.json");
    expect(files).toContain("memories.json");

    // Verify profile content
    const profile = JSON.parse(strFromU8(capturedFiles["profile.json"]!));
    expect(profile.name).toBe("Test User");
    expect(profile.email).toBe("test@example.com");
    expect(profile.exportedAt).toBeDefined();
  });

  it("decrypts settings and memories before including in ZIP", async () => {
    mockGetAllSettings.mockResolvedValue([
      { key: "custom-instructions", ciphertext: "enc-instr", nonce: "nonce-1" },
    ]);
    mockGetAllMemories.mockResolvedValue([
      { id: "mem-1", ciphertext: "enc-mem", nonce: "nonce-2", createdAt: 1000 },
    ]);

    await exportUserData(null);

    const settings = JSON.parse(strFromU8(capturedFiles["settings.json"]!));
    expect(settings).toHaveLength(1);
    expect(settings[0].value).toBe("decrypted:enc-instr");

    const memories = JSON.parse(strFromU8(capturedFiles["memories.json"]!));
    expect(memories).toHaveLength(1);
    expect(memories[0].text).toBe("decrypted:enc-mem");
  });

  it("creates one JSON file per conversation in conversations/ directory", async () => {
    mockGetAllConversations.mockResolvedValue([
      { id: "conv-1", title: "Chat 1", createdAt: 1000, updatedAt: 2000, activeLeafId: null },
      { id: "conv-2", title: "Chat 2", createdAt: 1500, updatedAt: 2500, activeLeafId: null },
    ]);
    mockGetAllFromIndexMessages.mockImplementation(
      (_store: string, _index: string, convId: string) => {
        if (convId === "conv-1") return [{ id: "msg-1", conversationId: "conv-1", role: "user", content: "Hello", createdAt: 1000 }];
        if (convId === "conv-2") return [{ id: "msg-2", conversationId: "conv-2", role: "assistant", content: "Hi", createdAt: 1500 }];
        return [];
      }
    );

    await exportUserData(null);

    expect(capturedFiles["conversations/conv-1.json"]).toBeDefined();
    expect(capturedFiles["conversations/conv-2.json"]).toBeDefined();

    const conv1 = JSON.parse(strFromU8(capturedFiles["conversations/conv-1.json"]!));
    expect(conv1.conversation.id).toBe("conv-1");
    expect(conv1.messages).toHaveLength(1);
    expect(conv1.messages[0].content).toBe("Hello");
  });

  it("includes message tree structure in each conversation file", async () => {
    mockGetAllConversations.mockResolvedValue([
      { id: "conv-1", title: "Test", createdAt: 1000, updatedAt: 2000, activeLeafId: "msg-3" },
    ]);
    mockGetAllFromIndexMessages.mockResolvedValue([
      { id: "msg-1", conversationId: "conv-1", parentId: null, role: "user", content: "Q1", createdAt: 1000 },
      { id: "msg-2", conversationId: "conv-1", parentId: "msg-1", role: "assistant", content: "A1", createdAt: 1001 },
      { id: "msg-3", conversationId: "conv-1", parentId: "msg-2", role: "user", content: "Q2", createdAt: 1002 },
    ]);

    await exportUserData(null);

    const conv = JSON.parse(strFromU8(capturedFiles["conversations/conv-1.json"]!));

    expect(conv.messages).toHaveLength(3);
    expect(conv.messages[0].parentId).toBeNull();
    expect(conv.messages[1].parentId).toBe("msg-1");
    expect(conv.messages[2].parentId).toBe("msg-2");
  });

  it("triggers browser download with correct filename pattern", async () => {
    const today = new Date().toISOString().split("T")[0];

    await exportUserData(null);

    expect(capturedFilename).toBe(`eco-data-export-${today}.zip`);
    expect(mockAnchor.click).toHaveBeenCalled();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("handles empty databases gracefully", async () => {
    await exportUserData(null);

    // Should still have the base files
    expect(capturedFiles["README.txt"]).toBeDefined();
    expect(capturedFiles["profile.json"]).toBeDefined();
    expect(capturedFiles["settings.json"]).toBeDefined();
    expect(capturedFiles["memories.json"]).toBeDefined();

    const settings = JSON.parse(strFromU8(capturedFiles["settings.json"]!));
    expect(settings).toEqual([]);

    const memories = JSON.parse(strFromU8(capturedFiles["memories.json"]!));
    expect(memories).toEqual([]);

    // No conversations directory entries
    const convFiles = Object.keys(capturedFiles).filter((k) => k.startsWith("conversations/"));
    expect(convFiles).toHaveLength(0);
  });
});

describe("exportUserData when a store cannot be read", () => {
  it("names conversations as failed instead of shipping an archive with none", async () => {
    mockOpenEcoDB.mockRejectedValue(new Error("IDB unavailable"));
    mockGetAllSettings.mockResolvedValue([
      { key: "custom-instructions", ciphertext: "enc-instr", nonce: "nonce-1" },
    ]);

    const result = await exportUserData(null);

    expect(result.failed).toEqual(["conversations"]);
    expect(result.included).toEqual(["settings"]);

    const readme = strFromU8(capturedFiles["README.txt"]!);
    expect(readme).toContain("Not included:");
    expect(readme).toContain("your conversations");
    expect(readme).not.toContain("- conversations/:");
  });

  it("names settings and memories as failed and omits their files entirely", async () => {
    mockOpenSettingsDB.mockRejectedValue(new Error("IDB unavailable"));
    mockGetAllConversations.mockResolvedValue([
      { id: "conv-1", title: "Chat 1", createdAt: 1000, updatedAt: 2000, activeLeafId: null },
    ]);

    const result = await exportUserData(null);

    expect(result.failed).toEqual(["settings"]);
    expect(result.included).toEqual(["conversations"]);
    // An empty settings.json would read as "you had no settings" — it must be absent.
    expect(capturedFiles["settings.json"]).toBeUndefined();
    expect(capturedFiles["memories.json"]).toBeUndefined();

    const readme = strFromU8(capturedFiles["README.txt"]!);
    expect(readme).toContain("Not included:");
    expect(readme).toContain("your settings and memories");
  });

  it("fails outright rather than downloading a profile-only archive", async () => {
    mockOpenEcoDB.mockRejectedValue(new Error("IDB unavailable"));
    mockOpenSettingsDB.mockRejectedValue(new Error("IDB unavailable"));

    await expect(exportUserData(null)).rejects.toBeInstanceOf(UserDataExportUnreadableError);
    expect(mockAnchor.click).not.toHaveBeenCalled();
  });

  it("reports both stores as included when both read cleanly", async () => {
    const result = await exportUserData(null);

    expect(result.failed).toEqual([]);
    expect(result.included).toEqual(["conversations", "settings"]);
    expect(strFromU8(capturedFiles["README.txt"]!)).not.toContain("Not included:");
  });
});
