// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import {
  resolveDependencyPolicy,
  ProductionDependencyError,
  type DependencyEnv,
} from '../production-guards.js'

// A fully-configured production env. Tests clone + delete to model each gap so a
// single missing var is the only variable under test.
function prodEnv(overrides: Partial<DependencyEnv> = {}): DependencyEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@db.example.com/eco',
    REDIS_URL: 'redis://default:pass@redis.example.com:6379',
    ...overrides,
  }
}

describe('resolveDependencyPolicy', () => {
  describe('non-production', () => {
    it('never throws and expects no backing services when everything is unset', () => {
      const policy = resolveDependencyPolicy({ NODE_ENV: 'development' })
      expect(policy.isProduction).toBe(false)
      expect(policy.expectDatabase).toBe(false)
      expect(policy.expectRedis).toBe(false)
      expect(policy.databaseConfigured).toBe(false)
      expect(policy.redisConfigured).toBe(false)
      expect(policy.warnings).toEqual([])
    })

    it('treats an absent NODE_ENV as non-production (test/dev ergonomics)', () => {
      expect(() => resolveDependencyPolicy({})).not.toThrow()
    })
  })

  describe('production database gate (3.1)', () => {
    it('expects the database and reports it configured when DATABASE_URL is set', () => {
      const policy = resolveDependencyPolicy(prodEnv())
      expect(policy.expectDatabase).toBe(true)
      expect(policy.databaseConfigured).toBe(true)
    })

    it('throws a ProductionDependencyError naming DATABASE_URL when missing without break-glass', () => {
      const env = prodEnv()
      delete env.DATABASE_URL
      expect(() => resolveDependencyPolicy(env)).toThrow(ProductionDependencyError)
      expect(() => resolveDependencyPolicy(env)).toThrow(/DATABASE_URL/)
    })

    it('allows boot under explicit break-glass but still expects the database (so readiness degrades) and warns loudly', () => {
      const env = prodEnv({ ECO_ALLOW_PROD_WITHOUT_DATABASE: 'true' })
      delete env.DATABASE_URL
      const policy = resolveDependencyPolicy(env)
      expect(policy.databaseConfigured).toBe(false)
      expect(policy.expectDatabase).toBe(true)
      const warning = policy.warnings.find((w) => /ECO_ALLOW_PROD_WITHOUT_DATABASE/.test(w.msg))
      expect(warning).toBeDefined()
      expect(warning?.level).toBe('error')
    })

    it('does not accept a non-"true" break-glass value as a bypass', () => {
      const env = prodEnv({ ECO_ALLOW_PROD_WITHOUT_DATABASE: 'false' })
      delete env.DATABASE_URL
      expect(() => resolveDependencyPolicy(env)).toThrow(ProductionDependencyError)
    })
  })

  describe('production redis gate (3.2)', () => {
    it('expects redis and reports it configured when REDIS_URL is set', () => {
      const policy = resolveDependencyPolicy(prodEnv())
      expect(policy.expectRedis).toBe(true)
      expect(policy.redisConfigured).toBe(true)
    })

    it('throws a ProductionDependencyError naming REDIS_URL when missing without break-glass', () => {
      const env = prodEnv()
      delete env.REDIS_URL
      expect(() => resolveDependencyPolicy(env)).toThrow(ProductionDependencyError)
      expect(() => resolveDependencyPolicy(env)).toThrow(/REDIS_URL/)
    })

    it('allows boot under explicit break-glass but still expects redis and warns loudly', () => {
      const env = prodEnv({ ECO_ALLOW_UNLIMITED_RATE_LIMITING: 'true' })
      delete env.REDIS_URL
      const policy = resolveDependencyPolicy(env)
      expect(policy.redisConfigured).toBe(false)
      expect(policy.expectRedis).toBe(true)
      const warning = policy.warnings.find((w) =>
        /ECO_ALLOW_UNLIMITED_RATE_LIMITING/.test(w.msg),
      )
      expect(warning).toBeDefined()
      expect(warning?.level).toBe('error')
    })

    it('does not accept a non-"true" break-glass value as a bypass', () => {
      const env = prodEnv({ ECO_ALLOW_UNLIMITED_RATE_LIMITING: '1' })
      delete env.REDIS_URL
      expect(() => resolveDependencyPolicy(env)).toThrow(ProductionDependencyError)
    })
  })

  describe('no billing surface', () => {
    it('emits no warnings for a fully configured production environment', () => {
      const policy = resolveDependencyPolicy(prodEnv())
      expect(policy.warnings).toEqual([])
    })

    it('ignores leftover payment-processor environment variables', () => {
      const policy = resolveDependencyPolicy(
        prodEnv({
          STRIPE_SECRET_KEY: 'sk_live_x',
          STRIPE_WEBHOOK_SECRET: 'whsec_x',
        }),
      )
      expect(policy.warnings).toEqual([])
      expect(policy).not.toHaveProperty('billing')
    })
  })
})
