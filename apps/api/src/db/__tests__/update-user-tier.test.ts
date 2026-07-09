// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createUpdateUserTier } from '../update-user-tier.js'

describe('createUpdateUserTier', () => {
  const mockWhere = vi.fn().mockResolvedValue(undefined)
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere })
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet })
  const mockDb = { update: mockUpdate } as unknown as Parameters<typeof createUpdateUserTier>[0]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a function', () => {
    const updateUserTier = createUpdateUserTier(mockDb)
    expect(typeof updateUserTier).toBe('function')
  })

  it('calls db.update with the users table', async () => {
    const updateUserTier = createUpdateUserTier(mockDb)
    await updateUserTier('user-123', 'supporter')
    expect(mockUpdate).toHaveBeenCalledOnce()
  })

  it('sets subscriptionTier and updatedAt', async () => {
    const updateUserTier = createUpdateUserTier(mockDb)
    await updateUserTier('user-123', 'supporter')

    expect(mockSet).toHaveBeenCalledOnce()
    const setArg = mockSet.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg.subscriptionTier).toBe('supporter')
    expect(setArg.updatedAt).toBeInstanceOf(Date)
  })

  it('includes stripeCustomerId when provided', async () => {
    const updateUserTier = createUpdateUserTier(mockDb)
    await updateUserTier('user-123', 'supporter', 'cus_stripe_abc')

    const setArg = mockSet.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg.subscriptionTier).toBe('supporter')
    expect(setArg.stripeCustomerId).toBe('cus_stripe_abc')
  })

  it('does not include stripeCustomerId when not provided', async () => {
    const updateUserTier = createUpdateUserTier(mockDb)
    await updateUserTier('user-456', 'free')

    const setArg = mockSet.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg.subscriptionTier).toBe('free')
    expect(setArg).not.toHaveProperty('stripeCustomerId')
  })

  it('calls where with the user ID', async () => {
    const updateUserTier = createUpdateUserTier(mockDb)
    await updateUserTier('user-789', 'enterprise')

    expect(mockWhere).toHaveBeenCalledOnce()
  })

  it('handles enterprise tier', async () => {
    const updateUserTier = createUpdateUserTier(mockDb)
    await updateUserTier('user-ent', 'enterprise', 'cus_ent_123')

    const setArg = mockSet.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg.subscriptionTier).toBe('enterprise')
    expect(setArg.stripeCustomerId).toBe('cus_ent_123')
  })
})
