// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { createRedisClient } from '../redis.js'

describe('createRedisClient', () => {
  it('throws when no REDIS_URL is provided and env is unset', () => {
    const original = process.env.REDIS_URL
    delete process.env.REDIS_URL
    expect(() => createRedisClient()).toThrow('REDIS_URL environment variable is required')
    process.env.REDIS_URL = original
  })
})
