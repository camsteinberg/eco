// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * File validation, text extraction, and content injection for chat file uploads.
 * All processing is client-side -- no server interaction required.
 * Supports all privacy tiers by design.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
  "py", "js", "ts", "tsx", "jsx", "rs", "go", "java", "c", "cpp", "h", "hpp",
  "rb", "swift", "kt", "kts", "scala", "php", "sh", "bash", "zsh", "fish",
  "sql", "r", "lua", "dart", "zig", "nim", "ex", "exs", "erl", "hs",
  "css", "scss", "less", "html", "vue", "svelte",
]);

export const ALLOWED_EXTENSIONS = new Set([
  // Text / data
  "txt", "md", "csv", "json", "xml", "yaml", "yml", "toml", "ini", "log",
  // Code
  ...CODE_EXTENSIONS,
  // PDF
  "pdf",
]);

/** Maximum file size: 10 MB */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum files per message */
export const MAX_FILES_PER_MESSAGE = 5;

/** Maximum extracted characters (truncated beyond this) */
export const MAX_EXTRACTED_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileExtractionResult = {
  filename: string;
  size: number;
  content: string;
  type: "text" | "code" | "csv" | "pdf";
  truncated: boolean;
};

export type FileValidationError = {
  filename: string;
  error: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Returns true if the file extension belongs to a recognized code language.
 */
export function isCodeFile(ext: string): boolean {
  return CODE_EXTENSIONS.has(ext.toLowerCase());
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a file for upload.
 * Returns null if valid, or a FileValidationError with a descriptive message.
 */
export function validateFile(file: File): FileValidationError | null {
  const ext = getExtension(file.name);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return {
      filename: file.name,
      error: `Unsupported file type (.${ext || "unknown"})`,
    };
  }
  if (file.size > MAX_FILE_SIZE) {
    return {
      filename: file.name,
      error: "Too large (max 10MB)",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Extract text content from a file.
 * - For PDFs: dynamically imports unpdf to extract text.
 * - For all others: reads via file.text().
 * Content is truncated to MAX_EXTRACTED_CHARS if it exceeds that limit.
 */
export async function extractText(file: File): Promise<FileExtractionResult> {
  const ext = getExtension(file.name);
  let content: string;
  let type: FileExtractionResult["type"];

  if (ext === "pdf") {
    const { getDocumentProxy, extractText: pdfExtract } = await import("unpdf");
    const buf = await file.arrayBuffer();
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const extracted = await pdfExtract(doc, { mergePages: true });
    content = extracted.text;
    type = "pdf";
  } else {
    // Use File.text() when available (browsers), fall back to FileReader-style
    // for environments where .text() is missing (e.g., jsdom in tests).
    content = typeof file.text === "function"
      ? await file.text()
      : await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsText(file);
        });
    if (ext === "csv") {
      type = "csv";
    } else if (isCodeFile(ext)) {
      type = "code";
    } else {
      type = "text";
    }
  }

  const truncated = content.length > MAX_EXTRACTED_CHARS;
  if (truncated) {
    content = content.slice(0, MAX_EXTRACTED_CHARS);
  }

  return {
    filename: file.name,
    size: file.size,
    content,
    type,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Content injection
// ---------------------------------------------------------------------------

/**
 * Build the final message content with file blocks prepended.
 *
 * Format per file:
 *   <file name="filename.ext" size="1234">
 *   ```lang
 *   file content here
 *   ```
 *   </file>
 *
 * For code files, the lang tag is the file extension.
 * For non-code files, the lang tag is omitted.
 */
export function buildMessageWithFiles(
  userText: string,
  files: FileExtractionResult[]
): string {
  if (files.length === 0) return userText;

  const blocks = files.map((f) => {
    const ext = getExtension(f.filename);
    const lang = f.type === "code" ? ext : "";
    return `<file name="${f.filename}" size="${String(f.size)}">\n\`\`\`${lang}\n${f.content}\n\`\`\`\n</file>`;
  });

  const fileSection = blocks.join("\n\n");

  if (!userText) return fileSection;
  return `${fileSection}\n\n${userText}`;
}
