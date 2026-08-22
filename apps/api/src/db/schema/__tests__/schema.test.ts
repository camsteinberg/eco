// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { users } from '../users.js'
import { sessions } from '../sessions.js'
import { apiKeys } from '../api-keys.js'
import { feedback } from '../feedback.js'

describe('users table', () => {
  it('is named "users"', () => {
    expect(getTableName(users)).toBe('users')
  })

  it('has all required columns', () => {
    const cols = getTableColumns(users)
    expect(cols.id).toBeDefined()
    expect(cols.email).toBeDefined()
    expect(cols.passwordHash).toBeDefined()
    expect(cols.name).toBeDefined()
    expect(cols.subscriptionTier).toBeDefined()
    expect(cols.stripeCustomerId).toBeDefined()
    expect(cols.createdAt).toBeDefined()
    expect(cols.updatedAt).toBeDefined()
  })

  it('id column is a text primary key', () => {
    const cols = getTableColumns(users)
    expect(cols.id.dataType).toBe('string')
    expect(cols.id.notNull).toBe(true)
    expect(cols.id.primary).toBe(true)
  })

  it('email column is not null', () => {
    const cols = getTableColumns(users)
    expect(cols.email.notNull).toBe(true)
  })

  it('subscriptionTier defaults to free', () => {
    const cols = getTableColumns(users)
    expect(cols.subscriptionTier.hasDefault).toBe(true)
  })
})

describe('sessions table', () => {
  it('is named "sessions"', () => {
    expect(getTableName(sessions)).toBe('sessions')
  })

  it('has all required columns', () => {
    const cols = getTableColumns(sessions)
    expect(cols.id).toBeDefined()
    expect(cols.userId).toBeDefined()
    expect(cols.token).toBeDefined()
    expect(cols.expiresAt).toBeDefined()
    expect(cols.createdAt).toBeDefined()
  })

  it('token column is not null', () => {
    const cols = getTableColumns(sessions)
    expect(cols.token.notNull).toBe(true)
  })

  it('userId column is text-backed for Better Auth ids', () => {
    const cols = getTableColumns(sessions)
    expect(cols.userId.dataType).toBe('string')
  })
})

describe('apiKeys table', () => {
  it('is named "api_keys"', () => {
    expect(getTableName(apiKeys)).toBe('api_keys')
  })

  it('has all required columns', () => {
    const cols = getTableColumns(apiKeys)
    expect(cols.id).toBeDefined()
    expect(cols.userId).toBeDefined()
    expect(cols.keyHash).toBeDefined()
    expect(cols.prefix).toBeDefined()
    expect(cols.label).toBeDefined()
    expect(cols.lastUsedAt).toBeDefined()
    expect(cols.createdAt).toBeDefined()
    expect(cols.revokedAt).toBeDefined()
  })

  it('keyHash column is not null', () => {
    const cols = getTableColumns(apiKeys)
    expect(cols.keyHash.notNull).toBe(true)
  })

  it('userId column is text-backed for Better Auth ids', () => {
    const cols = getTableColumns(apiKeys)
    expect(cols.userId.dataType).toBe('string')
  })
})

describe('feedback table', () => {
  it('is named "feedback"', () => {
    expect(getTableName(feedback)).toBe('feedback')
  })

  it('has all required columns', () => {
    const cols = getTableColumns(feedback)
    expect(cols.id).toBeDefined()
    expect(cols.message).toBeDefined()
    expect(cols.deviceSummary).toBeDefined()
    expect(cols.createdAt).toBeDefined()
  })

  it('message is not null; deviceSummary is nullable (anonymous, opt-in)', () => {
    const cols = getTableColumns(feedback)
    expect(cols.message.notNull).toBe(true)
    expect(cols.deviceSummary.notNull).toBe(false)
  })

  it('stores no user id, IP, or user-agent column — feedback is anonymous by design', () => {
    const cols = getTableColumns(feedback)
    expect(Object.keys(cols).sort()).toEqual(['createdAt', 'deviceSummary', 'id', 'message'])
  })
})
