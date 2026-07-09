// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

const DEFAULT_MAX_SAFE_STRING_LENGTH = 180;

const PRIVATE_CONTENT_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]"],
  [/\b((?:token|secret|password|api[_-]?key|private[_-]?key))=([^\s"'&]+)/gi, "$1=[redacted-secret]"],
  [/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|AIza[0-9A-Za-z_-]{12,})\b/g, "[redacted-secret]"],
  [/\bBEGIN [A-Z ]*(?:PRIVATE KEY|SECRET)[\s\S]*?END [A-Z ]*(?:PRIVATE KEY|SECRET)\b/g, "[redacted-secret]"],
  [/\bPRIVATE_(?:PROMPT|GENERATION|FILE|URL|OUTPUT)_SHOULD_NOT_LEAK\b/g, "[redacted-private-content]"],
  [/\b(?:user )?private (?:prompt|generated text|generation|file|output|url)\b/gi, "[redacted-private-content]"],
];

export function redactPrivacyUnsafeString(
  value: unknown,
  maxLength = DEFAULT_MAX_SAFE_STRING_LENGTH,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const redacted = PRIVATE_CONTENT_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    trimmed,
  );

  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}…`;
}

export function redactPrivacyUnsafeStringArray(
  value: unknown,
  maxItems = 12,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      const redacted = redactPrivacyUnsafeString(item);
      return redacted ? [redacted] : [];
    })
    .slice(0, maxItems);
}
