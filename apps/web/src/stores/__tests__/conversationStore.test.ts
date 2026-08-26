// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useConversationStore } from '../conversationStore'
import type { Conversation } from '../../lib/types/conversation'

const requestPersistentStorage = vi.fn(async () => 'persistent' as const)
vi.mock('../../local-ai/download/persistent-storage', () => ({
  requestPersistentStorage: () => requestPersistentStorage(),
}))

const makeConversation = (id: string, title = 'Test', pinnedAt?: number | null): Conversation => ({
  id,
  title,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  activeLeafId: null,
  pinnedAt: pinnedAt ?? null,
})

beforeEach(() => {
  localStorage.clear()
  useConversationStore.setState({
    conversations: [],
    activeConversationId: null,
  })
})

describe('useConversationStore', () => {
  it('starts with empty conversations and no active id', () => {
    const state = useConversationStore.getState()
    expect(state.conversations).toEqual([])
    expect(state.activeConversationId).toBeNull()
  })

  it('addConversation appends and sets active', () => {
    const conv = makeConversation('conv-1', 'First Chat')
    useConversationStore.getState().addConversation(conv)
    const state = useConversationStore.getState()
    expect(state.conversations).toHaveLength(1)
    expect(state.conversations[0]?.id).toBe('conv-1')
    expect(state.activeConversationId).toBe('conv-1')
  })

  it('addConversation asks the browser for persistent storage (chats must not be evictable)', () => {
    requestPersistentStorage.mockClear()
    useConversationStore.getState().addConversation(makeConversation('conv-1'))
    expect(requestPersistentStorage).toHaveBeenCalledTimes(1)
  })

  it('removeConversation deletes by id', () => {
    useConversationStore.getState().addConversation(makeConversation('conv-1'))
    useConversationStore.getState().addConversation(makeConversation('conv-2'))
    useConversationStore.getState().removeConversation('conv-1')
    expect(useConversationStore.getState().conversations).toHaveLength(1)
    expect(useConversationStore.getState().conversations[0]?.id).toBe('conv-2')
  })

  it('renameConversation updates the title', () => {
    useConversationStore.getState().addConversation(makeConversation('conv-1', 'Old'))
    useConversationStore.getState().renameConversation('conv-1', 'New Title')
    expect(useConversationStore.getState().conversations[0]?.title).toBe('New Title')
  })

  it('setActive sets activeConversationId', () => {
    useConversationStore.getState().addConversation(makeConversation('conv-1'))
    useConversationStore.getState().addConversation(makeConversation('conv-2'))
    useConversationStore.getState().setActive('conv-1')
    expect(useConversationStore.getState().activeConversationId).toBe('conv-1')
    expect(localStorage.getItem('eco-active-conversation')).toBe('conv-1')
  })

  it('setActive(null) records the new chat as deliberate, and picking a conversation clears it', () => {
    useConversationStore.getState().addConversation(makeConversation('conv-1'))

    useConversationStore.getState().setActive(null)
    expect(localStorage.getItem('eco-active-conversation')).toBeNull()
    expect(localStorage.getItem('eco-new-chat')).toBe('true')

    useConversationStore.getState().setActive('conv-1')
    expect(localStorage.getItem('eco-new-chat')).toBeNull()
  })

  it('restorePersistedActiveConversation reselects the saved conversation', () => {
    useConversationStore.getState().setConversations([
      makeConversation('conv-1'),
      makeConversation('conv-2'),
    ])
    localStorage.setItem('eco-active-conversation', 'conv-2')

    useConversationStore.getState().restorePersistedActiveConversation()

    expect(useConversationStore.getState().activeConversationId).toBe('conv-2')
  })

  it('clearAll removes all conversations and resets active', () => {
    useConversationStore.getState().addConversation(makeConversation('conv-1'))
    useConversationStore.getState().addConversation(makeConversation('conv-2'))
    useConversationStore.getState().clearAll()
    const state = useConversationStore.getState()
    expect(state.conversations).toHaveLength(0)
    expect(state.activeConversationId).toBeNull()
    expect(localStorage.getItem('eco-active-conversation')).toBeNull()
  })
})

describe('pinConversation', () => {
  it('sets pinnedAt to a timestamp on the target conversation', () => {
    const before = Date.now()
    useConversationStore.getState().addConversation(makeConversation('conv-1'))
    useConversationStore.getState().pinConversation('conv-1')
    const conv = useConversationStore.getState().conversations[0]
    expect(conv?.pinnedAt).toBeTypeOf('number')
    expect(conv!.pinnedAt!).toBeGreaterThanOrEqual(before)
  })
})

describe('unpinConversation', () => {
  it('sets pinnedAt to null on the target conversation', () => {
    useConversationStore.getState().addConversation(makeConversation('conv-1', 'Test', Date.now()))
    useConversationStore.getState().unpinConversation('conv-1')
    const conv = useConversationStore.getState().conversations[0]
    expect(conv?.pinnedAt).toBeNull()
  })
})

describe('removeMultiple', () => {
  it('removes all specified conversations from the store', () => {
    useConversationStore.getState().addConversation(makeConversation('conv-1'))
    useConversationStore.getState().addConversation(makeConversation('conv-2'))
    useConversationStore.getState().addConversation(makeConversation('conv-3'))
    useConversationStore.getState().removeMultiple(['conv-1', 'conv-3'])
    const state = useConversationStore.getState()
    expect(state.conversations).toHaveLength(1)
    expect(state.conversations[0]?.id).toBe('conv-2')
  })

  it('sets activeConversationId to null if the active conversation was in the deleted set', () => {
    useConversationStore.getState().addConversation(makeConversation('conv-1'))
    useConversationStore.getState().addConversation(makeConversation('conv-2'))
    useConversationStore.getState().setActive('conv-2')
    useConversationStore.getState().removeMultiple(['conv-2'])
    expect(useConversationStore.getState().activeConversationId).toBeNull()
  })

  it('does not change activeConversationId if it was not in the deleted set', () => {
    useConversationStore.getState().addConversation(makeConversation('conv-1'))
    useConversationStore.getState().addConversation(makeConversation('conv-2'))
    useConversationStore.getState().addConversation(makeConversation('conv-3'))
    useConversationStore.getState().setActive('conv-3')
    useConversationStore.getState().removeMultiple(['conv-1', 'conv-2'])
    expect(useConversationStore.getState().activeConversationId).toBe('conv-3')
  })
})

describe('initConversationStore hydration', () => {
  it('maps pinnedAt from DbConversation to Conversation on hydration', () => {
    const pinnedTime = 1700000000000
    const conv = makeConversation('conv-1', 'Pinned', pinnedTime)
    useConversationStore.setState({ conversations: [conv] })
    const state = useConversationStore.getState()
    expect(state.conversations[0]?.pinnedAt).toBe(pinnedTime)
  })
})
