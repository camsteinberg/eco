// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Same-origin `/v1/*` proxy to the API gateway, replacing the `next.config.ts`
 * rewrite of the same path. It exists so the api can see the real client IP and
 * key its per-IP rate limiter on the person rather than on Vercel's egress
 * address — the reasoning, the header contract and the Vercel behaviour it rests
 * on are all documented in `src/lib/api-proxy.ts`.
 *
 * Clients keep calling the relative path, so this stays same-origin and the CSP
 * needs no new `connect-src` entry.
 */

import { proxyToApi } from '../../../src/lib/api-proxy'

// Every request is forwarded live: nothing here may be prerendered or cached,
// and the handler must read per-request headers (cookie, client IP).
export const dynamic = 'force-dynamic'
// Node, not Edge: the body is streamed through `fetch` with `duplex: 'half'`.
export const runtime = 'nodejs'

export const GET = proxyToApi
export const POST = proxyToApi
export const PUT = proxyToApi
export const PATCH = proxyToApi
export const DELETE = proxyToApi
export const OPTIONS = proxyToApi
