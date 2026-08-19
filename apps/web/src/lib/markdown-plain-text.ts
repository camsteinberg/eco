// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Flatten Markdown source to plain text for one-line previews.
 *
 * This is deliberately NOT a parser. It exists because conversation previews
 * are rendered as bare text in the sidebar, where a reply that opens with
 * `## Watering a container garden` reads as "## Watering a contain…". It
 * removes the syntax a preview can trip over — headings, emphasis, links and
 * images, code fences and inline code, blockquotes, list markers, horizontal
 * rules — and collapses the result to a single line.
 *
 * Anything subtler (nested emphasis, reference links, tables, HTML) is left
 * alone rather than half-handled: a 60-character preview does not justify a
 * Markdown dependency, and a wrong strip is worse than an untouched one.
 */
export function stripMarkdown(source: string): string {
  return (
    source
      // Code fences: drop the fence lines (and any info string), keep the code.
      .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm, "")
      // Inline code: drop the backticks, keep the span.
      .replace(/`+([^`\n]*)`+/g, "$1")
      // Images then links: keep the alt text / label, drop the target.
      .replace(/!\[([^\]]*)\]\([^)\s]*(?:\s[^)]*)?\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)\s]*(?:\s[^)]*)?\)/g, "$1")
      // ATX headings: drop the leading hashes.
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      // Horizontal rules and setext heading underlines.
      .replace(/^[ \t]*(?:={2,}|-{2,}|\*{3,}|_{3,})[ \t]*$/gm, "")
      // Blockquote markers, however deeply nested.
      .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
      // List markers, bulleted and ordered.
      .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, "")
      // Emphasis, strongest marker first so `***x***` doesn't leave a stray `*`.
      .replace(/(\*\*\*|___)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
      .replace(/(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
      .replace(/(\*|_)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
      .replace(/~~([\s\S]*?)~~/g, "$1")
      // A preview is one line.
      .replace(/\s+/g, " ")
      .trim()
  );
}
