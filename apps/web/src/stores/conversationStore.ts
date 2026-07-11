// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { create } from 'zustand'
import type { Conversation } from '../lib/types/conversation'
import { openEcoDB, getActiveBranch } from '../lib/db'
import { migrateFromLocalStorage } from '../lib/db-migration'
import { resolveBranchLeafId } from '../lib/conversation-navigation'
import { markRestoredInterruptions } from '../lib/chat-recovery'
import {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_KEY,
} from '../lib/chat-workspace-storage'
import { safeStorage } from '../lib/local-storage'
import { logger } from '../lib/logger'
import type { EcoDB, DbConversation, DbMessage } from '../lib/db'
import type { IDBPDatabase } from 'idb'
import type { ChatMessage } from './chatStore'
export { ACTIVE_CONVERSATION_STORAGE_KEY }

const SUPPRESS_CONVERSATION_PERSISTENCE_KEY = 'eco-skip-conversation-persistence-once'

type ConversationState = {
  conversations: Conversation[]
  activeConversationId: string | null
  hasHydrated: boolean
  persistenceError: string | null
}

type ConversationActions = {
  addConversation: (conv: Conversation) => void
  removeConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  setActive: (id: string | null) => void
  restorePersistedActiveConversation: () => void
  setConversations: (convs: Conversation[]) => void
  updateConversation: (id: string, updates: Partial<Conversation>) => void
  /** Load the active branch of messages for a conversation from IndexedDB. */
  loadConversationMessages: (conversationId: string) => Promise<ChatMessage[]>
  /** Save a single message to IndexedDB. */
  saveMessage: (message: DbMessage) => Promise<void>
  clearAll: () => void
  /** Pin a conversation by setting its pinnedAt timestamp. */
  pinConversation: (id: string) => void
  /** Unpin a conversation by clearing its pinnedAt timestamp. */
  unpinConversation: (id: string) => void
  /** Remove multiple conversations and their messages at once. */
  removeMultiple: (ids: string[]) => void
  /** Activate the branch that contains a searched message. */
  activateSearchResult: (conversationId: string, messageId: string) => Promise<void>
  clearPersistenceError: () => void
}

/** Lazily-opened DB handle; null until initConversationStore() runs. */
let dbPromise: Promise<IDBPDatabase<EcoDB>> | null = null

function getDb(): Promise<IDBPDatabase<EcoDB>> {
  if (!dbPromise) {
    dbPromise = openEcoDB().catch((error) => {
      dbPromise = null
      throw error
    })
  }
  return dbPromise
}

function shouldSkipConversationPersistenceHydration(): boolean {
  if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
    return false
  }

  try {
    if (window.sessionStorage.getItem(SUPPRESS_CONVERSATION_PERSISTENCE_KEY) !== 'true') {
      return false
    }

    window.sessionStorage.removeItem(SUPPRESS_CONVERSATION_PERSISTENCE_KEY)
    return true
  } catch {
    return false
  }
}

export function suppressNextConversationPersistenceHydration(): void {
  if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
    return
  }

  try {
    window.sessionStorage.setItem(SUPPRESS_CONVERSATION_PERSISTENCE_KEY, 'true')
  } catch {
    // sessionStorage can be unavailable in restricted contexts.
  }
}

export async function closeConversationPersistenceDb(): Promise<void> {
  const currentDbPromise = dbPromise
  dbPromise = null

  if (!currentDbPromise) {
    return
  }

  try {
    const db = await currentDbPromise
    db.close()
  } catch {
    // Ignore close failures — clearClientState still retries DB deletion below.
  }
}

function logConversationPersistenceError(action: string, error: unknown): void {
  logger.warn(`Conversation persistence failed while trying to ${action}.`, error)
  useConversationStore.setState({
    persistenceError:
      `Eco updated this conversation in memory, but browser storage could not ${action}. Try again or export a copy before closing this tab.`,
  })
}

function runConversationPersistenceTask(
  action: string,
  task: (db: IDBPDatabase<EcoDB>) => Promise<void>
): void {
  void getDb()
    .then((db) => task(db))
    .catch((error) => {
      logConversationPersistenceError(action, error)
    })
}

function loadPersistedActiveConversationId(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  const storedId = safeStorage.get(ACTIVE_CONVERSATION_STORAGE_KEY)
  return storedId && storedId.length > 0 ? storedId : null
}

function persistActiveConversationId(id: string | null): void {
  if (typeof window === 'undefined') {
    return
  }

  if (id) {
    safeStorage.set(ACTIVE_CONVERSATION_STORAGE_KEY, id)
    return
  }

  safeStorage.remove(ACTIVE_CONVERSATION_STORAGE_KEY)
}

function hasPersistedComposerDraft(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  const storedDraft = safeStorage.get(COMPOSER_DRAFT_STORAGE_KEY)
  return Boolean(storedDraft && storedDraft.trim().length > 0)
}

function resolveRestoredActiveConversationId(conversations: Conversation[]): string | null {
  const persistedActiveConversationId = loadPersistedActiveConversationId()

  if (
    persistedActiveConversationId
    && conversations.some((conversation) => conversation.id === persistedActiveConversationId)
  ) {
    return persistedActiveConversationId
  }

  if (hasPersistedComposerDraft()) {
    return null
  }

  return conversations[0]?.id ?? null
}

export const useConversationStore = create<ConversationState & ConversationActions>()(
  (set) => ({
    conversations: [],
    activeConversationId: null,
    hasHydrated: false,
    persistenceError: null,

    addConversation(conv) {
      set((state) => ({
        conversations: [...state.conversations, conv],
        activeConversationId: conv.id,
      }))
      persistActiveConversationId(conv.id)
      runConversationPersistenceTask('save a conversation', async (db) => {
        const dbConv: DbConversation = {
          id: conv.id,
          title: conv.title,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          activeLeafId: conv.activeLeafId,
          preview: conv.preview,
          pinnedAt: conv.pinnedAt ?? null,
        }
        await db.put('conversations', dbConv)
      })
    },

    removeConversation(id) {
      const currentActiveConversationId = useConversationStore.getState().activeConversationId
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== id),
        activeConversationId:
          state.activeConversationId === id ? null : state.activeConversationId,
      }))
      if (currentActiveConversationId === id) {
        persistActiveConversationId(null)
      }
      runConversationPersistenceTask('remove a conversation', async (db) => {
        // Delete conversation
        await db.delete('conversations', id)
        // Delete all messages for this conversation
        const msgs = await db.getAllFromIndex('messages', 'by-conversation', id)
        const tx = db.transaction('messages', 'readwrite')
        for (const msg of msgs) {
          tx.store.delete(msg.id)
        }
        await tx.done
      })
    },

    renameConversation(id, title) {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, title, updatedAt: Date.now() } : c
        ),
      }))
      runConversationPersistenceTask('rename a conversation', async (db) => {
        const existing = await db.get('conversations', id)
        if (existing) {
          await db.put('conversations', { ...existing, title, updatedAt: Date.now() })
        }
      })
    },

    setActive(id) {
      persistActiveConversationId(id)
      set({ activeConversationId: id })
    },

    restorePersistedActiveConversation() {
      const conversations = useConversationStore.getState().conversations
      const restoredActiveConversationId = resolveRestoredActiveConversationId(conversations)
      persistActiveConversationId(restoredActiveConversationId)
      set({ activeConversationId: restoredActiveConversationId })
    },

    setConversations(convs) {
      set({ conversations: convs })
    },

    updateConversation(id, updates) {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, ...updates, updatedAt: Date.now() } : c
        ),
      }))
      runConversationPersistenceTask('update a conversation', async (db) => {
        const existing = await db.get('conversations', id)
        if (existing) {
          const { activeLeafId, title, preview, pinnedAt } = updates
          const merged: DbConversation = {
            ...existing,
            updatedAt: Date.now(),
            ...(title !== undefined && { title }),
            ...(activeLeafId !== undefined && { activeLeafId }),
            ...(preview !== undefined && { preview }),
            ...(pinnedAt !== undefined && { pinnedAt }),
          }
          await db.put('conversations', merged)
        }
      })
    },

    async loadConversationMessages(conversationId) {
      try {
        const db = await getDb()
        const persistedConversation = await db.get('conversations', conversationId)
        const inMemoryConversation = useConversationStore
          .getState()
          .conversations.find((conversation) => conversation.id === conversationId)
        const activeLeafId =
          inMemoryConversation?.activeLeafId
          ?? persistedConversation?.activeLeafId
          ?? null
        const branch = await getActiveBranch(db, conversationId, activeLeafId)

        const restored: ChatMessage[] = branch.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          parentId: m.parentId,
          status: m.status,
          errorMessage: m.errorMessage,
          tokenCount: m.tokenCount,
          streamStartTime: m.streamStartTime,
          streamInterrupted: m.streamInterrupted,
          interruptedReason: m.interruptedReason,
          resolvedModel: m.resolvedModel,
          inferenceMethod: m.inferenceMethod,
          confidence: m.confidence,
          offlineDivider: m.offlineDivider,
          citations: m.citations,
          verification: m.verification,
          canonicalToolAnswer: m.canonicalToolAnswer,
        }))

        // Catch replies a crash/reload left mid-stream: they persist with a
        // non-terminal status and would otherwise restore as a bare, actionless
        // (often empty) bubble. Mark them interrupted so the honest marker +
        // Try again render.
        return markRestoredInterruptions(restored)
      } catch (error) {
        logConversationPersistenceError(
          `load messages for conversation ${conversationId}`,
          error,
        )
        return []
      }
    },

    async saveMessage(message) {
      try {
        const db = await getDb()
        await db.put('messages', message)
      } catch (error) {
        logConversationPersistenceError(`save message ${message.id}`, error)
      }
    },

    clearAll() {
      persistActiveConversationId(null)
      set({ conversations: [], activeConversationId: null })
      runConversationPersistenceTask('clear all conversations', async (db) => {
        const convTx = db.transaction('conversations', 'readwrite')
        await convTx.store.clear()
        await convTx.done
        const msgTx = db.transaction('messages', 'readwrite')
        await msgTx.store.clear()
        await msgTx.done
      })
    },

    pinConversation(id) {
      const pinnedAt = Date.now()
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, pinnedAt, updatedAt: Date.now() } : c
        ),
      }))
      runConversationPersistenceTask('pin a conversation', async (db) => {
        const existing = await db.get('conversations', id)
        if (existing) {
          await db.put('conversations', { ...existing, pinnedAt, updatedAt: Date.now() })
        }
      })
    },

    unpinConversation(id) {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, pinnedAt: null, updatedAt: Date.now() } : c
        ),
      }))
      runConversationPersistenceTask('unpin a conversation', async (db) => {
        const existing = await db.get('conversations', id)
        if (existing) {
          await db.put('conversations', { ...existing, pinnedAt: null, updatedAt: Date.now() })
        }
      })
    },

    removeMultiple(ids) {
      const idSet = new Set(ids)
      const currentActiveConversationId = useConversationStore.getState().activeConversationId
      set((state) => ({
        conversations: state.conversations.filter((c) => !idSet.has(c.id)),
        activeConversationId:
          state.activeConversationId && idSet.has(state.activeConversationId)
            ? null
            : state.activeConversationId,
      }))
      if (currentActiveConversationId && idSet.has(currentActiveConversationId)) {
        persistActiveConversationId(null)
      }
      runConversationPersistenceTask('remove multiple conversations', async (db) => {
        for (const id of ids) {
          await db.delete('conversations', id)
          const msgs = await db.getAllFromIndex('messages', 'by-conversation', id)
          const tx = db.transaction('messages', 'readwrite')
          for (const msg of msgs) {
            tx.store.delete(msg.id)
          }
          await tx.done
        }
      })
    },

    async activateSearchResult(conversationId, messageId) {
      let nextLeafId: string | null = messageId

      try {
        const db = await getDb()
        const allMessages = await db.getAllFromIndex(
          'messages',
          'by-conversation',
          conversationId,
        )
        nextLeafId = resolveBranchLeafId(allMessages, messageId) ?? messageId

        const existingConversation = await db.get('conversations', conversationId)
        if (existingConversation) {
          await db.put('conversations', {
            ...existingConversation,
            activeLeafId: nextLeafId,
          })
        }
      } catch (error) {
        logConversationPersistenceError(
          `activate searched message ${messageId} in conversation ${conversationId}`,
          error,
        )
      }

      persistActiveConversationId(conversationId)
      set((state) => ({
        activeConversationId: conversationId,
        conversations: state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, activeLeafId: nextLeafId }
            : conversation,
        ),
      }))
    },

    clearPersistenceError() {
      set({ persistenceError: null })
    },
  })
)

/**
 * Initialize the conversation store from IndexedDB.
 * Called once on module load (client-side only).
 *
 * Includes a safety timeout: if IndexedDB is blocked (e.g., a pending
 * deleteDatabase from logout), we force hasHydrated after 3 seconds
 * so the UI never gets stuck on a spinner.
 */
async function initConversationStore() {
  if (shouldSkipConversationPersistenceHydration()) {
    useConversationStore.setState({
      conversations: [],
      activeConversationId: null,
      hasHydrated: true,
      persistenceError: null,
    })
    return
  }

  const timeout = setTimeout(() => {
    if (!useConversationStore.getState().hasHydrated) {
      logger.warn('Conversation store hydration timed out; continuing without IndexedDB hydration.')
      useConversationStore.setState({ hasHydrated: true })
    }
  }, 3000)

  try {
    const db = await getDb()
    await migrateFromLocalStorage(db)

    // Load all conversations sorted by updatedAt
    const allConvs = await db.getAllFromIndex('conversations', 'by-updated')
    // getAllFromIndex returns ascending order; we want most-recent-first for Zustand state
    const conversations: Conversation[] = allConvs.reverse().map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      activeLeafId: c.activeLeafId,
      preview: c.preview,
      pinnedAt: c.pinnedAt ?? null,
    }))

    const restoredActiveConversationId = resolveRestoredActiveConversationId(conversations)
    persistActiveConversationId(restoredActiveConversationId)

    useConversationStore.setState({
      conversations,
      activeConversationId: restoredActiveConversationId,
      hasHydrated: true,
      persistenceError: null,
    })
  } catch (error) {
    logConversationPersistenceError('hydrate conversations from IndexedDB', error)
    useConversationStore.setState({ hasHydrated: true })
  } finally {
    clearTimeout(timeout)
  }
}

// Initialize on module load in the browser
if (typeof window !== 'undefined') {
  initConversationStore()
}
