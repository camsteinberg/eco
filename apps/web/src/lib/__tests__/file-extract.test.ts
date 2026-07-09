// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";

// Mock unpdf before importing the module under test
vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn().mockResolvedValue({ numPages: 1 }),
  extractText: vi.fn().mockResolvedValue({ text: "Extracted PDF content here." }),
}));

// jsdom File lacks .text() and .arrayBuffer(). Patch them for tests.
const OriginalFile = globalThis.File;
class PatchedFile extends OriginalFile {
  override async text(): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(this);
    });
  }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(this);
    });
  }
}
Object.defineProperty(globalThis, "File", { value: PatchedFile, writable: true, configurable: true });

import {
  validateFile,
  extractText,
  buildMessageWithFiles,
  isCodeFile,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_FILES_PER_MESSAGE,
  MAX_EXTRACTED_CHARS,
} from "../file-extract";
import type { FileExtractionResult } from "../file-extract";

function makeFile(name: string, content: string, type = "text/plain"): File {
  return new File([content], name, { type });
}

function makeLargeFile(name: string, sizeBytes: number): File {
  const buf = new Uint8Array(sizeBytes);
  return new File([buf], name, { type: "application/octet-stream" });
}

describe("file-extract", () => {
  describe("constants", () => {
    it("exports expected constants", () => {
      expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
      expect(MAX_FILES_PER_MESSAGE).toBe(5);
      expect(MAX_EXTRACTED_CHARS).toBe(50_000);
      expect(ALLOWED_EXTENSIONS.has("txt")).toBe(true);
      expect(ALLOWED_EXTENSIONS.has("pdf")).toBe(true);
      expect(ALLOWED_EXTENSIONS.has("py")).toBe(true);
    });
  });

  describe("validateFile", () => {
    it("rejects files with unsupported extensions", () => {
      const file = makeFile("malware.exe", "bad stuff");
      const result = validateFile(file);
      expect(result).not.toBeNull();
      expect(result!.error).toMatch(/unsupported/i);
      expect(result!.filename).toBe("malware.exe");
    });

    it("rejects .dll files", () => {
      const file = makeFile("lib.dll", "binary");
      const result = validateFile(file);
      expect(result).not.toBeNull();
      expect(result!.error).toMatch(/unsupported/i);
    });

    it("rejects files larger than 10MB", () => {
      const file = makeLargeFile("huge.txt", 11 * 1024 * 1024);
      const result = validateFile(file);
      expect(result).not.toBeNull();
      expect(result!.error).toMatch(/too large/i);
    });

    it("accepts .txt files", () => {
      const file = makeFile("readme.txt", "hello");
      expect(validateFile(file)).toBeNull();
    });

    it("accepts .csv files", () => {
      const file = makeFile("data.csv", "a,b,c");
      expect(validateFile(file)).toBeNull();
    });

    it("accepts code files (.py, .js, .ts, .rs, .go, .java)", () => {
      for (const ext of ["py", "js", "ts", "rs", "go", "java"]) {
        const file = makeFile(`main.${ext}`, "code");
        expect(validateFile(file)).toBeNull();
      }
    });

    it("accepts .pdf files", () => {
      const file = makeFile("doc.pdf", "pdf-content");
      expect(validateFile(file)).toBeNull();
    });

    it("returns null for valid files", () => {
      const file = makeFile("notes.md", "# notes");
      expect(validateFile(file)).toBeNull();
    });
  });

  describe("isCodeFile", () => {
    it("identifies code file extensions", () => {
      expect(isCodeFile("py")).toBe(true);
      expect(isCodeFile("js")).toBe(true);
      expect(isCodeFile("ts")).toBe(true);
      expect(isCodeFile("rs")).toBe(true);
      expect(isCodeFile("go")).toBe(true);
    });

    it("returns false for non-code extensions", () => {
      expect(isCodeFile("txt")).toBe(false);
      expect(isCodeFile("csv")).toBe(false);
      expect(isCodeFile("pdf")).toBe(false);
      expect(isCodeFile("json")).toBe(false);
    });
  });

  describe("extractText", () => {
    it("reads .txt files and returns type text", async () => {
      const file = makeFile("readme.txt", "Hello world");
      const result = await extractText(file);
      expect(result.filename).toBe("readme.txt");
      expect(result.content).toBe("Hello world");
      expect(result.type).toBe("text");
      expect(result.truncated).toBe(false);
      expect(result.size).toBe(file.size);
    });

    it("reads .csv files and returns type csv", async () => {
      const file = makeFile("data.csv", "a,b,c\n1,2,3");
      const result = await extractText(file);
      expect(result.type).toBe("csv");
    });

    it("reads code files and returns type code", async () => {
      const file = makeFile("app.py", "print('hello')");
      const result = await extractText(file);
      expect(result.type).toBe("code");
    });

    it("reads .pdf files using unpdf and returns type pdf", async () => {
      const file = makeFile("doc.pdf", "fake-pdf-bytes");
      const result = await extractText(file);
      expect(result.type).toBe("pdf");
      expect(result.content).toBe("Extracted PDF content here.");
      expect(result.filename).toBe("doc.pdf");
    });

    it("truncates content exceeding MAX_EXTRACTED_CHARS and sets truncated", async () => {
      const longContent = "x".repeat(60_000);
      const file = makeFile("big.txt", longContent);
      const result = await extractText(file);
      expect(result.content.length).toBe(MAX_EXTRACTED_CHARS);
      expect(result.truncated).toBe(true);
    });

    it("does not truncate content within limit", async () => {
      const content = "y".repeat(1000);
      const file = makeFile("small.txt", content);
      const result = await extractText(file);
      expect(result.content).toBe(content);
      expect(result.truncated).toBe(false);
    });
  });

  describe("buildMessageWithFiles", () => {
    it("returns unmodified text when no files", () => {
      expect(buildMessageWithFiles("hello", [])).toBe("hello");
    });

    it("prepends file content as XML-tagged fenced blocks", () => {
      const files: FileExtractionResult[] = [
        { filename: "data.txt", size: 11, content: "Hello world", type: "text", truncated: false },
      ];
      const result = buildMessageWithFiles("analyze this", files);
      expect(result).toContain('<file name="data.txt" size="11">');
      expect(result).toContain("```\nHello world\n```");
      expect(result).toContain("</file>");
      expect(result).toContain("analyze this");
      // File block should come before user text
      const fileIdx = result.indexOf("<file");
      const textIdx = result.indexOf("analyze this");
      expect(fileIdx).toBeLessThan(textIdx);
    });

    it("handles multiple files with correct lang tags for code", () => {
      const files: FileExtractionResult[] = [
        { filename: "app.py", size: 14, content: "print('hello')", type: "code", truncated: false },
        { filename: "data.csv", size: 7, content: "a,b,c", type: "csv", truncated: false },
      ];
      const result = buildMessageWithFiles("check these", files);
      expect(result).toContain("```py\nprint('hello')\n```");
      expect(result).toContain("```\na,b,c\n```");
      expect(result).toContain("check these");
    });

    it("returns only file blocks when user text is empty", () => {
      const files: FileExtractionResult[] = [
        { filename: "note.txt", size: 5, content: "hello", type: "text", truncated: false },
      ];
      const result = buildMessageWithFiles("", files);
      expect(result).toContain('<file name="note.txt"');
      // Should not have trailing empty text
      expect(result.trim().endsWith("</file>")).toBe(true);
    });
  });
});
