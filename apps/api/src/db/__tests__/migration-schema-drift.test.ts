// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Column } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { apiKeys } from '../schema/api-keys.js'
import { feedback } from '../schema/feedback.js'
import { sessions } from '../schema/sessions.js'
import { users } from '../schema/users.js'

// Guards against the class of bug that broke production signup (Wave D):
// the drizzle meta snapshot claimed `users.id` was `text`, but no SQL migration
// ever altered it from the `uuid` that 0000 created — so the real database stayed
// `uuid` while the code (and Better Auth) used `text` ids. The existing unit tests
// mock the DB, so they can never catch this. This test reconstructs the *effective*
// column type from the actual migration DDL and asserts it matches the code schema.

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

function loadMigrationStatements(): string[] {
  const files = readdirSync(drizzleDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  return files
    .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
    .join('\n')
    .split('--> statement-breakpoint')
}

// Effective SQL type of a column after applying every migration in order:
// the CREATE TABLE declaration, any `ADD COLUMN`, then any
// `ALTER COLUMN ... SET DATA TYPE`.
function effectiveColumnType(table: string, column: string): string | null {
  let type: string | null = null
  for (const statement of loadMigrationStatements()) {
    if (statement.includes(`CREATE TABLE "${table}"`)) {
      const decl = new RegExp(`"${column}"\\s+(\\w+)`).exec(statement)
      if (decl) type = decl[1].toLowerCase()
    }
    const added = new RegExp(
      `ALTER TABLE "${table}" ADD COLUMN "${column}"\\s+(\\w+)`,
    ).exec(statement)
    if (added) type = added[1].toLowerCase()
    const altered = new RegExp(
      `ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DATA TYPE (\\w+)`,
    ).exec(statement)
    if (altered) type = altered[1].toLowerCase()
  }
  return type
}

// Better Auth issues string ids; every column on the app-user join path must be text.
const TEXT_ID_COLUMNS: readonly {
  table: string
  column: string
  schemaColumn: Column
}[] = [
  { table: 'users', column: 'id', schemaColumn: users.id },
  { table: 'api_keys', column: 'user_id', schemaColumn: apiKeys.userId },
  { table: 'sessions', column: 'user_id', schemaColumn: sessions.userId },
]

describe('migration / code schema drift for Better Auth id columns', () => {
  for (const { table, column, schemaColumn } of TEXT_ID_COLUMNS) {
    it(`${table}.${column}: migrations and code schema both resolve to text`, () => {
      const sqlType = effectiveColumnType(table, column)
      const codeType = schemaColumn.getSQLType().toLowerCase()

      // The column must actually appear in the migration DDL.
      expect(sqlType, `${table}.${column} not found in migration SQL`).not.toBeNull()
      // The code schema intends text (Better Auth ids are strings).
      expect(codeType).toBe('text')
      // The migrations must realize that intent — this is the line that fails if
      // a uuid->text ALTER is ever dropped again like it was in 0002.
      expect(sqlType).toBe('text')
    })
  }
})

// The feedback migrations (0004, 0005) were authored by hand (drizzle-kit generate
// cannot load the schema in this environment), so hold it to the same
// DDL-matches-code standard: every code-schema column must appear in the
// migration DDL with the same base SQL type.
describe('migration / code schema drift for the feedback table', () => {
  for (const [name, column] of Object.entries(getTableColumns(feedback))) {
    it(`feedback.${column.name}: migration DDL matches the code schema`, () => {
      const sqlType = effectiveColumnType('feedback', column.name)
      // Compare base types only ("timestamp with time zone" → "timestamp"),
      // matching the single-word capture in effectiveColumnType.
      const codeBaseType = column.getSQLType().toLowerCase().split(' ')[0].replace(/\(.*/, '')

      expect(sqlType, `feedback.${column.name} (${name}) not found in migration SQL`).not.toBeNull()
      expect(sqlType).toBe(codeBaseType)
    })
  }
})
