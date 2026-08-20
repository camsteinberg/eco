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

/* FileBlock only ever renders inside the user bubble, which sets its own
   foreground (--eco-on-primary) over a primary-tinted background that differs
   per theme. Surface tokens would be near-invisible there, so every colour here
   derives from the bubble's own text colour: `currentColor` for the primary tier
   and a mix for the quiet tier. That keeps the chip legible on whatever the
   bubble happens to be, in both themes, without a second set of tokens. */
const QUIET = "color-mix(in srgb, currentColor 78%, transparent)";
const HAIRLINE = "color-mix(in srgb, currentColor 28%, transparent)";

export function FileBlock({ filename, size, type, content }: FileBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 rounded-lg border text-xs" style={{ borderColor: HAIRLINE }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)]"
        aria-expanded={expanded}
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-bold"
          style={{ backgroundColor: HAIRLINE, color: "currentColor" }}
          aria-hidden="true"
        >
          {FILE_TYPE_ICONS[type] || "F"}
        </span>
        <span className="flex-1 truncate font-medium">{filename}</span>
        <span style={{ color: QUIET }}>{formatDisplaySize(size)}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          style={{ color: QUIET }}
          aria-hidden="true"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {expanded && (
        <div
          className="max-h-[200px] overflow-auto border-t px-3 py-2"
          style={{ borderColor: HAIRLINE }}
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
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
