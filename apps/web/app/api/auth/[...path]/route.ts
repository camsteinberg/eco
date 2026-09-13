// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Same-origin `/api/auth/*` proxy to the API gateway (Better Auth), replacing
 * the `next.config.ts` rewrite of the same path.
 *
 * Why: a rewrite is an opaque server-side fetch, so on production (web on
 * Vercel, api on Fly) the api saw Vercel's egress address as the caller. Every
 * sign-in, sign-up and password-reset attempt from one Vercel region therefore
 * shared ONE bucket on the api's `auth` rate-limit tier — the limiter throttled
 * a region instead of an attacker. A route handler can read the edge's real
 * client IP and pass it on under a shared secret; the header contract and the
 * Vercel behaviour it rests on are documented in `src/lib/api-proxy.ts`.
 *
 * Two things make this path safe to move, and both live in `proxyToApi`:
 *   - Better Auth's `Set-Cookie` is load-bearing (session, CSRF state) and it
 *     can legitimately repeat, so the proxy reads every value with
 *     `getSetCookie()` and appends each one back unchanged.
 *   - OAuth is a redirect flow: `redirect: 'manual'` means a 3xx is handed back
 *     to the browser rather than followed server-side, and `location` is on the
 *     forwarded response-header allowlist so the browser can act on it.
 *
 * The browser keeps calling the relative `/api/auth/...` (`src/lib/auth.ts`
 * builds the client with `baseURL: ''`), so this stays same-origin: no client
 * change, no CSP `connect-src` entry, and the cookie keeps the web origin.
 *
 * Note that `middleware.ts`'s matcher excludes `api/auth`, so middleware never
 * ran on this path as a rewrite and does not run on it as a handler either.
 */

import { proxyToApi } from '../../../../src/lib/api-proxy'

// Every request is forwarded live: nothing here may be prerendered or cached,
// and the handler must read per-request headers (cookie, client IP).
export const dynamic = 'force-dynamic'
// Node, not Edge: the handler reads the request body and per-request headers.
export const runtime = 'nodejs'

export const GET = proxyToApi
export const POST = proxyToApi
export const PUT = proxyToApi
export const PATCH = proxyToApi
export const DELETE = proxyToApi
export const OPTIONS = proxyToApi
