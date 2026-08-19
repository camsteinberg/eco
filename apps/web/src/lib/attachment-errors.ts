// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

function trimTerminalPunctuation(message: string): string {
  return message.replace(/[.!?]+$/u, "");
}

export function attachLimitError(filename: string, maxFiles: number): string {
  return `Eco can attach up to ${String(maxFiles)} files per message. Remove one to add ${filename}.`;
}

export function attachValidationError(filename: string, reason: string): string {
  return `Eco can't use ${filename} — ${trimTerminalPunctuation(reason)}. Try a different file.`;
}

export function attachReadError(filename: string, _rawCause: string): string {
  return `Eco couldn't read ${filename}. Remove it or try a different file.`;
}
