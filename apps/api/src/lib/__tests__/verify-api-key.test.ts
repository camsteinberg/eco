// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSessionCookieVerifier } from '../verify-api-key.js'

// ── Mock DB builder ──────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>

function createMockDb(options: {
  selectResults?: MockRow[][]
  updateError?: Error | null
} = {}) {
  const { selectResults = [[]], updateError = null } = options
  let selectCallIndex = 0
  const limitSpy = vi.fn()

  // Drizzle's `.where(...)` returns a builder that is itself thenable AND
  // chainable with `.limit(n)` — mirror that so the code under test can do
  // either.
  function whereResult(rows: MockRow[]) {
    const resolved = Promise.resolve(rows)
    return Object.assign(resolved, {
      limit: limitSpy.mockImplementation(() => Promise.resolve(rows)),
    })
  }

  const mockUpdate = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() =>
        updateError ? Promise.reject(updateError) : Promise.resolve(),
      ),
    }),
  })

  const mockDb = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            const result = selectResults[selectCallIndex] ?? []
            selectCallIndex++
            return Promise.resolve(result)
          }),
        }),
        where: vi.fn().mockImplementation(() => {
          const result = selectResults[selectCallIndex] ?? []
          selectCallIndex++
          return whereResult(result)
        }),
      }),
    })),
    update: mockUpdate,
  }

  return { mockDb, mockUpdate, limitSpy }
}

// ── Session Cookie Verifier ──────────────────────────────────────────────────
// Note: the bearer-token verifier (`createApiKeyVerifier`) was removed pre-launch
// (security-review 2026-07-03, M4); the session-cookie verifier is now the only
// authn mechanism, and the only export under test here.

describe('createSessionCookieVerifier', () => {
  const sessionToken = 'sess-token-abc-123'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns AuthUser for a valid, unexpired session', async () => {
    const { mockDb } = createMockDb({
      selectResults: [
        // First select: session + user join
        [{
          userId: 'ba-user-001',
          email: 'frank@eco.network',
          name: 'Frank',
        }],
        // Second select: app users table for the stable legacy app id
        [{ id: 'legacy-user-001' }],
      ],
    })

    const verify = createSessionCookieVerifier(mockDb as never)
    const result = await verify(sessionToken)

    expect(result).toEqual({
      id: 'legacy-user-001',
      email: 'frank@eco.network',
      name: 'Frank',
    })
  })

  it('returns null for empty cookie value', async () => {
    const { mockDb } = createMockDb()
    const verify = createSessionCookieVerifier(mockDb as never)
    const result = await verify('')
    expect(result).toBeNull()
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('returns null when session not found', async () => {
    const { mockDb } = createMockDb({ selectResults: [[]] })
    const verify = createSessionCookieVerifier(mockDb as never)
    const result = await verify(sessionToken)
    expect(result).toBeNull()
  })

  it('treats malformed URL-encoded session cookies as invalid', async () => {
    const { mockDb } = createMockDb()
    const verify = createSessionCookieVerifier(mockDb as never)
    const result = await verify('%')

    expect(result).toBeNull()
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('falls back to the Better Auth id when app users table has no matching user', async () => {
    const { mockDb } = createMockDb({
      selectResults: [
        [{
          userId: 'ba-user-002',
          email: 'grace@eco.network',
          name: 'Grace',
        }],
        // Empty app users result
        [],
      ],
    })

    const verify = createSessionCookieVerifier(mockDb as never)
    const result = await verify(sessionToken)

    expect(result).toEqual({
      id: 'ba-user-002',
      email: 'grace@eco.network',
      name: 'Grace',
    })
  })

  it('prefers the stable app-user profile name when a legacy row already exists', async () => {
    const { mockDb } = createMockDb({
      selectResults: [
        [{
          userId: 'ba-user-004',
          email: 'ivy@eco.network',
          name: 'Old Auth Name',
        }],
        [{ id: 'legacy-user-004', name: 'Fresh App Name' }],
      ],
    })

    const verify = createSessionCookieVerifier(mockDb as never)
    const result = await verify(sessionToken)

    expect(result).toEqual({
      id: 'legacy-user-004',
      email: 'ivy@eco.network',
      name: 'Fresh App Name',
    })
  })

  it('caps the app-user lookup at one row (limit 1)', async () => {
    const { mockDb, limitSpy } = createMockDb({
      selectResults: [
        [{
          userId: 'ba-user-005',
          email: 'judy@eco.network',
          name: 'Judy',
        }],
        [{ id: 'legacy-user-005' }],
      ],
    })

    const verify = createSessionCookieVerifier(mockDb as never)
    const result = await verify(sessionToken)

    expect(result?.id).toBe('legacy-user-005')
    expect(limitSpy).toHaveBeenCalledWith(1)
  })

  it('falls back to the Better Auth row when the app users lookup throws', async () => {
    const mockDb = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              return Promise.resolve([{
                userId: 'ba-user-003',
                email: 'hank@eco.network',
                name: null,
              }])
            }),
          }),
          where: vi.fn().mockImplementation(() => {
            throw new Error('table not found')
          }),
        }),
      })),
    }

    const verify = createSessionCookieVerifier(mockDb as never)
    const result = await verify(sessionToken)

    expect(result).toEqual({
      id: 'ba-user-003',
      email: 'hank@eco.network',
      name: null,
    })
  })
})
