// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { openEcoDB, getActiveBranch } from "./db";
import { ConversationNotFoundError, exportConversationAsMarkdown, downloadFile } from "./export";
import { copyTextWithFallback } from "./clipboard";
import { normalizeStreamMarkdown } from "./stream-markdown-normalizer";

const CLIPBOARD_WRITE_TIMEOUT_MS = 1500;

/**
 * Copy a conversation as formatted markdown to the clipboard.
 * Uses Safari-compatible ClipboardItem pattern (synchronous blob creation).
 */
export async function copyConversationAsMarkdown(
  conversationId: string
): Promise<void> {
  const markdown = await exportConversationAsMarkdown(conversationId);

  try {
    if (
      typeof ClipboardItem !== "undefined"
      && typeof navigator !== "undefined"
      && navigator.clipboard?.write
    ) {
      const blob = new Blob([markdown], { type: "text/plain" });
      await Promise.race([
        navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Clipboard write timed out")),
            CLIPBOARD_WRITE_TIMEOUT_MS,
          );
        }),
      ]);
      return;
    }
  } catch {
    // Fall through to writeText / execCommand fallback.
  }

  await copyTextWithFallback(markdown);
}

/**
 * Generate a self-contained shareable HTML document for a conversation.
 * Includes inline CSS with Eco branding and automatic dark mode support.
 * Fully client-side — no external dependencies or server storage.
 */
export async function generateShareableHTML(
  conversationId: string
): Promise<string> {
  const db = await openEcoDB();
  const conversation = await db.get("conversations", conversationId);
  if (!conversation) {
    throw new ConversationNotFoundError(conversationId);
  }

  const branch = await getActiveBranch(
    db,
    conversationId,
    conversation.activeLeafId
  );

  const title = escapeHtml(conversation.title);
  const messageBlocks = branch
    .filter((msg) => msg.role !== "system")
    .map((msg) => {
      const roleLabel = msg.role === "user" ? "You" : "Eco";
      const roleClass = msg.role === "user" ? "user" : "assistant";
      const timestamp = new Date(msg.createdAt).toLocaleString();
      const content = escapeHtml(
        msg.role === "assistant" ? normalizeStreamMarkdown(msg.content, { complete: true }) : msg.content,
      );

      return `      <div class="message ${roleClass}">
        <div class="message-header">
          <span class="role">${roleLabel}</span>
          <span class="timestamp">${timestamp}</span>
        </div>
        <div class="message-content">${content}</div>
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Shared from Eco</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      background: #f5f0e8;
      color: #2c2418;
    }

    .header {
      background: #2d5a3d;
      color: #f5f0e8;
      padding: 16px 24px;
    }

    .header h1 {
      font-size: 1.25rem;
      font-weight: 600;
      max-width: 720px;
      margin: 0 auto;
    }

    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 24px;
    }

    .message {
      margin-bottom: 20px;
      padding: 16px;
      border-radius: 12px;
      background: #ffffff;
      border: 1px solid #e0dbd3;
    }

    .message.assistant {
      background: #eaf2ec;
      border-color: #c5d9ca;
    }

    .message-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .role {
      font-weight: 600;
      font-size: 0.875rem;
      color: #2d5a3d;
    }

    .timestamp {
      font-size: 0.75rem;
      color: #8a8278;
    }

    .message-content {
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .footer {
      text-align: center;
      padding: 24px;
      font-size: 0.8rem;
      color: #8a8278;
      border-top: 1px solid #e0dbd3;
      margin-top: 24px;
    }

    .empty-notice {
      text-align: center;
      padding: 48px 24px;
      color: #8a8278;
      font-style: italic;
    }

    @media (prefers-color-scheme: dark) {
      body {
        background: #1a1a1a;
        color: #ede8e0;
      }

      .header {
        background: #234a30;
        color: #ede8e0;
      }

      .message {
        background: #252525;
        border-color: #3a3a3a;
      }

      .message.assistant {
        background: #1e3028;
        border-color: #2d5a3d;
      }

      .role {
        color: #7bc08e;
      }

      .timestamp {
        color: #8a8278;
      }

      .footer {
        border-color: #3a3a3a;
        color: #8a8278;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${title}</h1>
  </div>
  <div class="container">
${messageBlocks || '    <div class="empty-notice">No messages in this conversation.</div>'}
    <div class="footer">Shared from Eco</div>
  </div>
</body>
</html>`;
}

/**
 * Download a conversation as a self-contained HTML file.
 */
export async function downloadShareableHTML(
  conversationId: string,
  title: string
): Promise<void> {
  const html = await generateShareableHTML(conversationId);
  downloadFile(html, `${title}.html`, "text/html");
}

/** Escape HTML special characters to prevent XSS in generated HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
