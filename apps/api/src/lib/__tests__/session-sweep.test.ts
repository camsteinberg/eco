// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { session, verification } from '../../db/schema/auth.js'
import { sweepAuthRows, SESSION_ABSOLUTE_MAX_AGE_MS } from '../session-sweep.js'

const dialect = new PgDialect()

/** Render a captured `where` condition so the predicate itself can be asserted. */
function render(condition: SQL) {
  return dialect.sqlToQuery(condition)
}

type DeleteCall = { table: unknown; condition: SQL }

function createMockDb(rows: { sessions: number; verifications: number }) {
  const calls: DeleteCall[] = []

  const db = {
    delete: vi.fn((table: unknown) => ({
      where: (condition: SQL) => {
        calls.push({ table, condition })
        const count = table === session ? rows.sessions : rows.verifications
        return {
          returning: () =>
            Promise.resolve(Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }))),
        }
      },
    })),
  }

  return { db, calls }
}

describe('sweepAuthRows', () => {
  const now = new Date('2026-09-13T12:00:00.000Z')

  it('issues exactly one delete per table', async () => {
    const { db, calls } = createMockDb({ sessions: 0, verifications: 0 })

    await sweepAuthRows(db as never, { now, absoluteMaxAgeMs: SESSION_ABSOLUTE_MAX_AGE_MS })

    expect(db.delete).toHaveBeenCalledTimes(2)
    expect(calls[0]?.table).toBe(session)
    expect(calls[1]?.table).toBe(verification)
  })

  it('deletes sessions past expiry OR past the absolute lifetime, both measured from `now`', async () => {
    const { db, calls } = createMockDb({ sessions: 0, verifications: 0 })

    await sweepAuthRows(db as never, { now, absoluteMaxAgeMs: SESSION_ABSOLUTE_MAX_AGE_MS })

    const query = render(calls[0]!.condition)
    expect(query.sql).toContain('"expires_at" <')
    expect(query.sql).toContain('"created_at" <')
    expect(query.sql).toContain(' or ')
    expect(query.params).toEqual([
      now.toISOString(),
      new Date(now.getTime() - SESSION_ABSOLUTE_MAX_AGE_MS).toISOString(),
    ])
  })

  it('deletes only expired verification rows', async () => {
    const { db, calls } = createMockDb({ sessions: 0, verifications: 0 })

    await sweepAuthRows(db as never, { now, absoluteMaxAgeMs: SESSION_ABSOLUTE_MAX_AGE_MS })

    const query = render(calls[1]!.condition)
    expect(query.sql).toContain('"expires_at" <')
    expect(query.sql).not.toContain(' or ')
    expect(query.params).toEqual([now.toISOString()])
  })

  it('returns the number of rows each statement removed', async () => {
    const { db } = createMockDb({ sessions: 3, verifications: 7 })

    const result = await sweepAuthRows(db as never, {
      now,
      absoluteMaxAgeMs: SESSION_ABSOLUTE_MAX_AGE_MS,
    })

    expect(result).toEqual({ sessions: 3, verifications: 7 })
  })

  it('honours a caller-supplied absolute max age', async () => {
    const { db, calls } = createMockDb({ sessions: 0, verifications: 0 })
    const oneDayMs = 24 * 60 * 60 * 1000

    await sweepAuthRows(db as never, { now, absoluteMaxAgeMs: oneDayMs })

    const query = render(calls[0]!.condition)
    expect(query.params).toEqual([
      now.toISOString(),
      new Date(now.getTime() - oneDayMs).toISOString(),
    ])
  })

  it('pins the absolute session lifetime at 90 days', () => {
    expect(SESSION_ABSOLUTE_MAX_AGE_MS).toBe(90 * 24 * 60 * 60 * 1000)
  })
})
