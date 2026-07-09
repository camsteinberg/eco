// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { MiddlewareHandler } from 'hono'

// Methods that cannot change state — CSRF is irrelevant for them, and skipping
// them keeps `GET /v1/auth/profile` and CORS `OPTIONS` preflight unaffected.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Explicit Origin allowlist check for the custom mutating routes
 * (`PATCH /v1/auth/profile`, `DELETE /v1/auth/account`, `POST /v1/billing/{checkout,portal}`).
 *
 * Defense-in-depth on top of the session cookie's `SameSite=Lax`: the Better
 * Auth `/api/auth/*` routes enforce Origin; these custom ones should too. This
 * is a layered control, not the sole one.
 *
 * - Non-state-changing methods (GET/HEAD/OPTIONS) skip the check.
 * - A present Origin header NOT in `allowedOrigins` → 403.
 * - An absent Origin header → pass (don't break non-browser clients;
 *   SameSite=Lax covers the absent-Origin cross-site case). Referer is not
 *   checked — Origin is the robust modern signal.
 */
export function createOriginCheck(allowedOrigins: string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins)
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      return next()
    }

    const origin = c.req.header('Origin')
    if (origin !== undefined && !allowed.has(origin)) {
      return c.json(
        { error: { code: 'forbidden', message: 'Cross-origin request rejected' } },
        403,
      )
    }

    return next()
  }
}
