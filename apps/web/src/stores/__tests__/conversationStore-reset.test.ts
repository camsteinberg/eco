// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('conversationStore reset hydration', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.doUnmock('../conversationStore')
    vi.doUnmock('../../lib/db')
    vi.doUnmock('../../lib/db-migration')
  })

  it('skips opening IndexedDB on the first load after client reset', async () => {
    const openEcoDB = vi.fn()
    const migrateFromLocalStorage = vi.fn()

    vi.doMock('../../lib/db', () => ({
      openEcoDB,
      getActiveBranch: vi.fn(),
    }))

    vi.doMock('../../lib/db-migration', () => ({
      migrateFromLocalStorage,
    }))

    sessionStorage.setItem('eco-skip-conversation-persistence-once', 'true')

    const { useConversationStore } = await import('../conversationStore')
    await Promise.resolve()

    expect(openEcoDB).not.toHaveBeenCalled()
    expect(migrateFromLocalStorage).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('eco-skip-conversation-persistence-once')).toBeNull()
    expect(useConversationStore.getState().hasHydrated).toBe(true)
    expect(useConversationStore.getState().conversations).toEqual([])
    expect(useConversationStore.getState().activeConversationId).toBeNull()
  })
})
