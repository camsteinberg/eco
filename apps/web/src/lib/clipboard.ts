// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

const CLIPBOARD_WRITE_TIMEOUT_MS = 1500;

async function writeTextWithTimeout(text: string): Promise<void> {
  await Promise.race([
    navigator.clipboard.writeText(text),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Clipboard write timed out")), CLIPBOARD_WRITE_TIMEOUT_MS);
    }),
  ]);
}

export async function copyTextWithFallback(text: string): Promise<void> {
  try {
    await writeTextWithTimeout(text);
    return;
  } catch {
    if (typeof document === "undefined") {
      throw new Error("Clipboard copy unavailable");
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      const succeeded =
        typeof document.execCommand === "function" && document.execCommand("copy");
      if (!succeeded) {
        throw new Error("Clipboard copy failed");
      }
    } finally {
      document.body.removeChild(textarea);
    }
  }
}
