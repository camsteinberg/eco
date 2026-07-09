// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest'
import { createSessionVerifier } from '../verify-session.js'

/**
 * Creates a mock Drizzle db that simulates the select → from → innerJoin → where → limit chain.
 * `rows` is what the final query resolves to.
 */
function mockDb(rows: unknown[]) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  }
  // The db itself is callable via db.select(...)
  return chain as unknown as Parameters<typeof createSessionVerifier>[0]
}

describe('createSessionVerifier', () => {
  it('returns AuthUser for a valid, non-expired session', async () => {
    const db = mockDb([
      {
        userId: 'user-42',
        email: 'alice@eco.network',
        name: 'Alice',
        subscriptionTier: 'supporter',
      },
    ])
    const verify = createSessionVerifier(db)
    const user = await verify('valid-session-token')

    expect(user).toEqual({
      id: 'user-42',
      email: 'alice@eco.network',
      name: 'Alice',
      subscriptionTier: 'supporter',
    })
  })

  it('returns null for an expired session (empty result set)', async () => {
    const db = mockDb([])
    const verify = createSessionVerifier(db)
    const user = await verify('expired-session-token')
    expect(user).toBeNull()
  })

  it('returns null for a non-existent session', async () => {
    const db = mockDb([])
    const verify = createSessionVerifier(db)
    const user = await verify('does-not-exist')
    expect(user).toBeNull()
  })

  it('defaults subscriptionTier to free when null', async () => {
    const db = mockDb([
      {
        userId: 'user-99',
        email: 'bob@eco.network',
        name: null,
        subscriptionTier: null,
      },
    ])
    const verify = createSessionVerifier(db)
    const user = await verify('some-token')

    expect(user).toEqual({
      id: 'user-99',
      email: 'bob@eco.network',
      name: null,
      subscriptionTier: 'free',
    })
  })

  it('handles name being null', async () => {
    const db = mockDb([
      {
        userId: 'user-77',
        email: 'anon@eco.network',
        name: null,
        subscriptionTier: 'enterprise',
      },
    ])
    const verify = createSessionVerifier(db)
    const user = await verify('anon-token')

    expect(user).not.toBeNull()
    expect(user!.name).toBeNull()
    expect(user!.subscriptionTier).toBe('enterprise')
  })
})
