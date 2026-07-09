// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React, { useEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage.js";

export interface ChatWindowMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatWindowProps {
  messages: ChatWindowMessage[];
  isStreaming?: boolean;
  emptyState?: React.ReactNode;
}

export function ChatWindow({
  messages,
  isStreaming = false,
  emptyState,
}: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        className="chat-window__scroll flex flex-1 flex-col gap-1 overflow-y-auto py-4"
      >
        {messages.length === 0 && emptyState ? (
          <div className="flex flex-1 items-center justify-center text-gray-400">
            {emptyState}
          </div>
        ) : (
          messages.map((msg, idx) => {
            const isLast = idx === messages.length - 1;
            const isLastAssistant = isLast && msg.role === "assistant";
            return (
              <ChatMessage
                key={msg.id}
                role={msg.role}
                content={msg.content}
                isStreaming={isLastAssistant && isStreaming}
              />
            );
          })
        )}
        <div ref={bottomRef} aria-hidden="true" />
      </div>
    </div>
  );
}
