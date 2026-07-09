// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { syncUserToAppTableMock } = vi.hoisted(() => ({
  syncUserToAppTableMock: vi.fn(),
}))

vi.mock('../../db/sync-user.js', () => ({
  syncUserToAppTable: syncUserToAppTableMock,
}))

import { finalizeNewUser } from '../finalize-new-user.js'

function createMockDb() {
  const deleteWhere = vi.fn().mockResolvedValue(undefined)
  const deleteFn = vi.fn().mockReturnValue({
    where: deleteWhere,
  })

  return {
    db: {
      delete: deleteFn,
    },
    deleteFn,
    deleteWhere,
  }
}

describe('finalizeNewUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('syncs the new auth user into the app users table', async () => {
    const { db, deleteFn } = createMockDb()
    syncUserToAppTableMock.mockResolvedValueOnce({
      appUserId: 'app-user-1',
      createdNewAppUser: true,
    })

    await expect(
      finalizeNewUser({
        db: db as never,
        user: {
          id: 'auth-user-1',
          email: 'person@example.com',
          name: 'Person Example',
        },
        context: null,
      }),
    ).resolves.toBeUndefined()

    expect(syncUserToAppTableMock).toHaveBeenCalledWith(
      db,
      'auth-user-1',
      'person@example.com',
      'Person Example',
    )
    expect(deleteFn).not.toHaveBeenCalled()
  })

  it('surfaces sync failures and deletes the freshly created auth user', async () => {
    const { db, deleteFn } = createMockDb()
    syncUserToAppTableMock.mockRejectedValueOnce(new Error('sync failed'))

    await expect(
      finalizeNewUser({
        db: db as never,
        user: {
          id: 'auth-user-2',
          email: 'new@example.com',
          name: 'New User',
        },
        context: null,
      }),
    ).rejects.toThrow('sync failed')

    expect(deleteFn).toHaveBeenCalledTimes(1)
  })
})
