// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { MiddlewareHandler } from 'hono'

// Methods that cannot change state — CSRF is irrelevant for them, and skipping
// them keeps `GET /v1/auth/profile` and CORS `OPTIONS` preflight unaffected.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Explicit Origin allowlist check for the custom mutating routes
 * (`PATCH /v1/auth/profile`, `DELETE /v1/auth/account`).
 *
 * Defense-in-depth on top of the session cookie's `SameSite=Lax`: the Better
 * Auth `/api/auth/*` routes enforce Origin; these custom ones should too. This
 * is a layered control, not the sole one.
 *
 * - Non-state-changing methods (GET/HEAD/OPTIONS) skip the check.
 * - A present Origin header NOT in `allowedOrigins` → 403.
 * - An absent Origin header → pass by default (don't break non-browser clients;
 *   SameSite=Lax covers the absent-Origin cross-site case), or 403 when the
 *   instance is built with `requireOrigin`. Referer is not checked — Origin is
 *   the robust modern signal.
 */
export type CreateOriginCheckOptions = {
  /**
   * Reject a state-changing request that carries NO Origin header at all.
   *
   * Off by default, because the cookie-authenticated routes (`PATCH
   * /v1/auth/profile`, `DELETE /v1/auth/account`, `POST /v1/feedback`) are
   * already covered for the absent-Origin case by `SameSite=Lax` on the session
   * cookie, and a non-browser client with a valid session should keep working.
   *
   * On for `POST /v1/search`, where that reasoning does not transfer: the route
   * is cookie-less and unauthenticated, so SameSite protects nothing and an
   * absent Origin is simply a script helping itself to a free search relay.
   * Every browser sends Origin on a cross-origin POST, so requiring it costs no
   * real client anything.
   */
  requireOrigin?: boolean
}

export function createOriginCheck(
  allowedOrigins: string[],
  options: CreateOriginCheckOptions = {},
): MiddlewareHandler {
  const allowed = new Set(allowedOrigins)
  const { requireOrigin = false } = options
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      return next()
    }

    const origin = c.req.header('Origin')
    const rejected = origin === undefined ? requireOrigin : !allowed.has(origin)
    if (rejected) {
      return c.json(
        { error: { code: 'forbidden', message: 'Cross-origin request rejected' } },
        403,
      )
    }

    return next()
  }
}
