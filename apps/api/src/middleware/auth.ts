// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { MiddlewareHandler } from 'hono'
import type { AuthUser } from '../lib/types/auth.js'
import { authFailuresTotal } from '../lib/metrics.js'

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  const match = cookieHeader.split(';').find(c => c.trim().startsWith(`${name}=`))
  return match ? match.split('=').slice(1).join('=').trim() : undefined
}

// Session-cookie-only authn. The v1.0 web app's sole client is the browser,
// which authenticates via the Better Auth session cookie. The former
// bearer-token (API-key) branch was removed pre-launch (security-review
// 2026-07-03, M4) — programmatic API keys belonged to the retired network SDK,
// so keeping a second mounted auth path only widened the attack surface.
export function createAuthMiddleware(
  verifySessionCookie: (cookieValue: string) => Promise<AuthUser | null>
): MiddlewareHandler {
  return async (c, next) => {
    let failureReason: 'expired_session' | 'missing' = 'missing'

    // Session cookie — Better Auth prefixes the name with __Secure- when secure=true.
    const cookie = c.req.header('Cookie')
    const sessionToken =
      parseCookie(cookie, '__Secure-better-auth.session_token') ??
      parseCookie(cookie, 'better-auth.session_token')
    if (sessionToken) {
      const user = await verifySessionCookie(sessionToken)
      if (user) {
        c.set('user', user)
        return next()
      }
      failureReason = 'expired_session'
    }

    authFailuresTotal.inc({ reason: failureReason })
    return c.json(
      { error: { code: 'unauthorized', message: 'Missing or invalid authentication' } },
      401
    )
  }
}
