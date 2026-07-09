// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterAll, describe, expect, it } from 'vitest'
import { closeDbConnections, createDb, isLocalDatabaseUrl } from '../index.js'

// Guards against regressing the production driver back to `neon-http`, which
// throws "No transactions support in neon-http driver" and 500s every route
// using db.transaction() (account deletion, profile updates) in production while
// passing locally on postgres-js. Production must use a transaction-capable
// driver. These checks only construct drivers — the Neon Pool and postgres-js
// client both connect lazily, so no database connection is opened.

const REMOTE_URL = 'postgresql://user:pass@ep-driver-guard-fake.us-east-1.aws.neon.tech/db'
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/eco_driver_guard_fake'

describe('runtime database driver selection', () => {
  afterAll(async () => {
    await closeDbConnections()
  })

  it('classifies a Neon (remote) URL as non-local', () => {
    expect(isLocalDatabaseUrl(REMOTE_URL)).toBe(false)
  })

  it('uses a transaction-capable driver for remote (production) URLs, not neon-http', () => {
    const db = createDb(REMOTE_URL)
    const driverName = db.constructor.name

    // neon-serverless => "NeonDatabase"; the broken neon-http => "NeonHttpDatabase".
    expect(driverName).toContain('Neon')
    expect(driverName).not.toContain('Http')
    // The transaction primitive the broken driver lacks must be present.
    expect(typeof (db as unknown as { transaction?: unknown }).transaction).toBe('function')
  })

  it('uses postgres-js (transaction-capable) for local URLs', () => {
    const db = createDb(LOCAL_URL)
    expect(db.constructor.name).toContain('PostgresJs')
  })
})
