// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export type ConversationMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  parentId: string | null
  status?: 'sending' | 'streaming' | 'complete' | 'error'
}

export type Conversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  activeLeafId: string | null
  preview?: string
  pinnedAt?: number | null
}
