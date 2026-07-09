// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncUserToAppTable } from '../sync-user.js'

describe('syncUserToAppTable', () => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined)
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues })
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined)
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere })
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet })
  const mockWhere = vi.fn()
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom })
  const mockDb = {
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
  } as unknown as Parameters<typeof syncUserToAppTable>[0]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a new app user when no legacy row exists', async () => {
    mockWhere.mockResolvedValueOnce([])

    const result = await syncUserToAppTable(
      mockDb,
      'auth-user-123',
      'person@example.com',
      'Person Example',
    )

    expect(result).toEqual({
      appUserId: 'auth-user-123',
      createdNewAppUser: true,
    })
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockInsert).toHaveBeenCalledOnce()
    expect(mockInsertValues).toHaveBeenCalledWith({
      id: 'auth-user-123',
      email: 'person@example.com',
      name: 'Person Example',
      subscriptionTier: 'free',
    })
  })

  it('preserves an existing legacy app user id while refreshing profile fields', async () => {
    mockWhere.mockResolvedValueOnce([{ id: 'legacy-user-456', name: 'Legacy Name' }])

    const result = await syncUserToAppTable(
      mockDb,
      'auth-user-999',
      'person@example.com',
      null,
    )

    expect(result).toEqual({
      appUserId: 'legacy-user-456',
      createdNewAppUser: false,
    })
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledOnce()
    const args = mockUpdateSet.mock.calls[0]![0] as Record<string, unknown>
    expect(args.name).toBe('Legacy Name')
    expect(args.updatedAt).toBeInstanceOf(Date)
    expect(mockUpdateWhere).toHaveBeenCalledOnce()
  })
})
