// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Context } from 'hono'
import { safeCompare } from '../lib/auth-utils.js'

/**
 * The slice of the prom-client registry the handler needs. Kept structural so
 * the handler is trivially testable with an injected fake and never reaches for
 * real process metrics in a unit test.
 */
export type MetricsRegister = {
  readonly contentType: string
  metrics: () => Promise<string>
}

export type MetricsHandlerOptions = {
  register: MetricsRegister
  /**
   * The shared scrape secret (`METRICS_TOKEN`). An empty string means
   * "unconfigured" — behavior then depends on `isProduction`.
   */
  token: string
  isProduction: boolean
}

const UNAUTHORIZED = { error: { message: 'Unauthorized', type: 'unauthorized' } } as const
const NOT_FOUND = { error: { message: 'Not found', type: 'not_found_error' } } as const

/** Pull the raw value out of an `Authorization: Bearer <value>` header. */
function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer (.+)$/.exec(header)
  return match?.[1]
}

/**
 * Build the `/metrics` route handler.
 *
 * Security posture (SECURITY.md H2):
 * - token set → require `Authorization: Bearer <token>`, compared timing-safely
 *   with `safeCompare`. Any mismatch/absence → 401, no metrics body.
 * - token unset + production → 404 (disabled/hidden; fail closed — don't expose
 *   the Prometheus surface when unconfigured).
 * - token unset + non-production → open (local-dev / scraping convenience).
 *
 * Never logs the token. The compare is length-guarded + constant-time.
 */
export function createMetricsHandler(opts: MetricsHandlerOptions) {
  const { register, token, isProduction } = opts

  const isConfigured = token.length > 0

  return async (c: Context) => {
    if (!isConfigured) {
      if (isProduction) {
        return c.json(NOT_FOUND, 404)
      }
      // Non-production, unconfigured → open access.
      c.header('Content-Type', register.contentType)
      return c.body(await register.metrics())
    }

    const presented = extractBearer(c.req.header('Authorization'))
    if (presented === undefined || !safeCompare(presented, token)) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json(UNAUTHORIZED, 401)
    }

    c.header('Content-Type', register.contentType)
    return c.body(await register.metrics())
  }
}
