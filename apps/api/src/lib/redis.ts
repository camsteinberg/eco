// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import Redis from 'ioredis'

// ioredis exports both a namespace and a class with the same name.
// Under ESM + TypeScript strict mode the default import resolves to the
// namespace. Cast to get the constructor.
const RedisClient = Redis as unknown as new (
  url: string,
  opts: {
    maxRetriesPerRequest: number
    retryStrategy: (times: number) => number | null
  },
) => InstanceType<typeof Redis.default>

export function createRedisClient(url?: string) {
  const redisUrl = url ?? process.env.REDIS_URL
  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is required')
  }
  return new RedisClient(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 3) return null
      return Math.min(times * 200, 2000)
    },
  })
}
