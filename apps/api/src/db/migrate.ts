// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { neon } from '@neondatabase/serverless'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http'
import { migrate as migrateNeon } from 'drizzle-orm/neon-http/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { isLocalDatabaseUrl } from './index.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL environment variable is required')
  process.exit(1)
}

console.log('Running database migrations...')

try {
  const migrationsFolder = new URL('../../drizzle', import.meta.url).pathname

  if (isLocalDatabaseUrl(databaseUrl)) {
    const sql = postgres(databaseUrl, { max: 1, prepare: false })
    const db = drizzlePostgres(sql)
    try {
      await migratePostgres(db, { migrationsFolder })
    } finally {
      await sql.end({ timeout: 5 })
    }
  } else {
    const db = drizzleNeon(neon(databaseUrl))
    await migrateNeon(db, { migrationsFolder })
  }

  console.log('Migrations complete')
} catch (err) {
  console.error('Migration failed:', err)
  process.exit(1)
}
