// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React from "react";

export interface ChatMessageProps {
  role: "user" | "assistant" | "system";
  content: string;
  isStreaming?: boolean;
}

function renderMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const fenceRegex = /```[\w]*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(...renderInline(text.slice(lastIndex, match.index), nodes.length));
    }
    nodes.push(
      <pre key={`fence-${match.index}`} className="my-2 overflow-x-auto rounded-lg bg-gray-900 px-4 py-3 text-sm text-gray-100">
        <code>{(match[1] ?? "").trimEnd()}</code>
      </pre>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(...renderInline(text.slice(lastIndex), nodes.length));
  }

  return nodes;
}

function renderInline(text: string, keyOffset: number): React.ReactNode[] {
  return text.split(/\n{2,}/).map((para, pIdx) => {
    const key = `para-${keyOffset}-${pIdx}`;
    const spans = parseInlineMarkup(para);
    return (
      <p key={key} className="my-1 leading-relaxed">
        {spans}
      </p>
    );
  });
}

function parseInlineMarkup(text: string): React.ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|_[^_]+_)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      parts.push(<code key={m.index} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-sm text-green-800">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      parts.push(<strong key={m.index} className="font-semibold">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("_")) {
      parts.push(<em key={m.index}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }

  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function ChatMessage({ role, content, isStreaming = false }: ChatMessageProps) {
  const isUser = role === "user";

  return (
    <div
      className={[
        "chat-message flex w-full gap-3 px-4 py-3",
        isUser ? "chat-message--user justify-end" : "chat-message--assistant justify-start",
      ].join(" ")}
    >
      {!isUser && (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-700 text-xs font-bold text-white">
          E
        </div>
      )}

      <div
        className={[
          "max-w-prose rounded-2xl px-4 py-2.5 text-sm",
          isUser
            ? "rounded-br-sm bg-green-700 text-white"
            : "rounded-bl-sm bg-gray-50 text-gray-900",
        ].join(" ")}
      >
        {isUser ? (
          <p className="leading-relaxed whitespace-pre-wrap">{content}</p>
        ) : (
          <div>{renderMarkdown(content)}</div>
        )}

        {isStreaming && (
          <span
            data-testid="streaming-cursor"
            className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-current align-middle opacity-70"
            aria-hidden="true"
          />
        )}
      </div>

      {isUser && (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-bold text-gray-600">
          U
        </div>
      )}
    </div>
  );
}
