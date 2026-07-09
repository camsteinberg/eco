// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Pool } from '@neondatabase/serverless'
import { sql } from 'drizzle-orm'
import { drizzle as drizzleNeonServerless } from 'drizzle-orm/neon-serverless'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'

// Runtime driver selection.
//
// The API runs as an always-on Node process on Fly, so the production database
// connection uses the Neon *serverless* driver (a pooled WebSocket connection),
// NOT the stateless `neon-http` driver. neon-http is built for serverless/edge
// one-shot queries and — critically — throws "No transactions support in
// neon-http driver" on `db.transaction(...)`. Account deletion and profile
// updates rely on transactions, so on neon-http they 500 in production while
// passing locally (local uses postgres-js, which supports transactions). The
// serverless driver supports real transactions, matching local semantics, so
// "works locally" once again means "works in production". On Node 22+ the
// serverless driver auto-uses the global `WebSocket`, so no extra dependency or
// `neonConfig.webSocketConstructor` wiring is required.

const LOCAL_DATABASE_HOSTS = new Set([
  '127.0.0.1',
  '::1',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  'localhost',
])
const dbCache = new Map<string, ReturnType<typeof buildDb>>()
const postgresClientCache = new Map<string, ReturnType<typeof postgres>>()
const neonPoolCache = new Map<string, Pool>()

type NormalizedExecuteResult<TResult> =
  TResult extends Array<unknown>
    ? TResult & { rows: TResult; rowCount: number }
    : TResult extends { rows: infer TRows extends unknown[] }
      ? TResult & { rows: TRows; rowCount: number }
      : TResult

type NormalizedDb<T extends { execute: (...args: any[]) => Promise<any> }> = Omit<T, 'execute'> & {
  execute: (
    ...args: Parameters<T['execute']>
  ) => Promise<NormalizedExecuteResult<Awaited<ReturnType<T['execute']>>>>
}

function normalizeExecuteResult<T>(result: T): NormalizedExecuteResult<T> {
  if (Array.isArray(result)) {
    const arrayResult = result as Array<unknown> & { count?: number }
    const rowCount =
      typeof arrayResult.count === 'number'
        ? arrayResult.count
        : arrayResult.length

    return Object.assign(arrayResult, {
      rows: arrayResult,
      rowCount,
    }) as NormalizedExecuteResult<T>
  }

  if (
    result &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows?: unknown[] }).rows) &&
    !('rowCount' in result)
  ) {
    return Object.assign(result as object, {
      rowCount: (result as { rows: unknown[] }).rows.length,
    }) as NormalizedExecuteResult<T>
  }

  return result as NormalizedExecuteResult<T>
}

function withNormalizedExecute<T extends { execute: (...args: any[]) => Promise<any> }>(
  db: T,
): NormalizedDb<T> {
  const execute = db.execute.bind(db)

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async (...args: Parameters<T['execute']>) =>
          normalizeExecuteResult(await execute(...args))
      }

      return Reflect.get(target, prop, receiver)
    },
  }) as NormalizedDb<T>
}

function resolveDatabaseUrl(databaseUrl?: string): string {
  const url = databaseUrl ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL environment variable is required')
  }

  return url
}

export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl)
    const normalizedHostname = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
    return LOCAL_DATABASE_HOSTS.has(normalizedHostname)
  } catch {
    return false
  }
}

function getPostgresClient(databaseUrl: string) {
  let client = postgresClientCache.get(databaseUrl)
  if (!client) {
    client = postgres(databaseUrl, {
      prepare: false,
    })
    postgresClientCache.set(databaseUrl, client)
  }

  return client
}

function getNeonPool(databaseUrl: string): Pool {
  let pool = neonPoolCache.get(databaseUrl)
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl })
    neonPoolCache.set(databaseUrl, pool)
  }

  return pool
}

function buildDb(databaseUrl: string) {
  if (isLocalDatabaseUrl(databaseUrl)) {
    return withNormalizedExecute(
      drizzlePostgres(getPostgresClient(databaseUrl), { schema }),
    )
  }

  return withNormalizedExecute(drizzleNeonServerless(getNeonPool(databaseUrl), { schema }))
}

export function createDb(databaseUrl?: string) {
  const url = resolveDatabaseUrl(databaseUrl)

  let db = dbCache.get(url)
  if (!db) {
    db = buildDb(url)
    dbCache.set(url, db)
  }

  return db
}

export async function closeDbConnections(): Promise<void> {
  const postgresClients = Array.from(postgresClientCache.values())
  const neonPools = Array.from(neonPoolCache.values())

  dbCache.clear()
  postgresClientCache.clear()
  neonPoolCache.clear()

  await Promise.all([
    ...postgresClients.map(async (client) => {
      try {
        await client.end({ timeout: 5 })
      } catch {
        // Best effort for one-off scripts and tests. Long-running services
        // should avoid calling this helper while requests are in flight.
      }
    }),
    ...neonPools.map(async (pool) => {
      try {
        await pool.end()
      } catch {
        // Best effort — see note above.
      }
    }),
  ])
}

export async function probeDatabase(databaseUrl?: string): Promise<void> {
  const url = resolveDatabaseUrl(databaseUrl)
  // Exercise the actual runtime driver (postgres-js locally, the Neon serverless
  // WebSocket pool in production) so startup and readiness probes fail when the
  // real query transport is broken — not merely when a separate HTTP request to
  // the database succeeds.
  await createDb(url).execute(sql`select 1`)
}

export type Db = ReturnType<typeof buildDb>

export { schema }
