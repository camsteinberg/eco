// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState } from "react";

type FileBlockProps = {
  filename: string;
  size: string;
  type: "text" | "code" | "csv" | "pdf";
  content: string;
};

const FILE_TYPE_ICONS: Record<FileBlockProps["type"], string> = {
  text: "T",
  code: "</>",
  csv: "CSV",
  pdf: "PDF",
};

function formatDisplaySize(sizeStr: string): string {
  const bytes = parseInt(sizeStr, 10);
  if (isNaN(bytes)) return sizeStr;
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function FileBlock({ filename, size, type, content }: FileBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="my-1 rounded-lg border text-xs"
      style={{ borderColor: "var(--eco-border)" }}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--eco-border)]/20"
        aria-expanded={expanded}
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-bold"
          style={{
            backgroundColor: "var(--eco-primary-soft)",
            color: "var(--eco-primary)",
          }}
          aria-hidden="true"
        >
          {FILE_TYPE_ICONS[type] || "F"}
        </span>
        <span
          className="flex-1 truncate font-medium"
          style={{ color: "var(--eco-text)" }}
        >
          {filename}
        </span>
        <span style={{ color: "var(--eco-text-secondary)" }}>
          {formatDisplaySize(size)}
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          style={{ color: "var(--eco-text-secondary)" }}
          aria-hidden="true"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {expanded && (
        <div
          className="max-h-[200px] overflow-auto border-t px-3 py-2"
          style={{ borderColor: "var(--eco-border)" }}
        >
          <pre
            className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
            style={{ color: "var(--eco-text)" }}
          >
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parser: extract <file> blocks from message content
// ---------------------------------------------------------------------------

export type ParsedFileBlock = {
  name: string;
  size: string;
  content: string;
};

/**
 * Parse `<file name="..." size="...">...</file>` blocks from message content.
 * Returns the extracted files and the remaining user text.
 */
export function parseFileBlocks(content: string): {
  files: ParsedFileBlock[];
  userText: string;
} {
  const files: ParsedFileBlock[] = [];
  // Match <file name="..." size="...">...</file> blocks (dotAll mode)
  const regex = /<file\s+name="([^"]+)"\s+size="([^"]+)">\s*```[^\n]*\n([\s\S]*?)```\s*<\/file>/g;
  let userText = content;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    files.push({
      name: match[1]!,
      size: match[2]!,
      content: match[3]!,
    });
    userText = userText.replace(match[0], "");
  }

  return { files, userText: userText.trim() };
}
