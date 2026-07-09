// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { closeDbConnections, createDb, isLocalDatabaseUrl } from '../index.js'

describe('createDb', () => {
  it('throws when no DATABASE_URL is provided and env is unset', () => {
    const original = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    expect(() => createDb()).toThrow('DATABASE_URL environment variable is required')
    process.env.DATABASE_URL = original
  })

  it('treats localhost postgres URLs as local database connections', () => {
    expect(isLocalDatabaseUrl('postgresql://eco@127.0.0.1:5432/eco')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://eco@localhost:5432/eco')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://eco@[::1]:5432/eco')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://eco@[0:0:0:0:0:0:0:1]:5432/eco')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://eco@[::ffff:127.0.0.1]:5432/eco')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://eco@db.internal:5432/eco')).toBe(false)
  })

  it('reuses the same database instance for repeated local URLs', () => {
    const databaseUrl = 'postgresql://eco@127.0.0.1:5432/eco'

    expect(createDb(databaseUrl)).toBe(createDb(databaseUrl))
  })

  it('clears cached local connections for one-off scripts', async () => {
    const databaseUrl = 'postgresql://eco@127.0.0.1:5432/eco'
    const firstDb = createDb(databaseUrl)

    await closeDbConnections()

    expect(createDb(databaseUrl)).not.toBe(firstDb)
  })
})
