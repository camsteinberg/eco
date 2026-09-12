// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Same-origin proxy for `/v1/*` → the API gateway.
 *
 * This replaces the `next.config.ts` `/v1/:path*` rewrite. The rewrite was
 * functionally fine but it made the API's view of the caller useless: on
 * production (web on Vercel, api on Fly) the rewrite is a server-side fetch, so
 * the api's TCP peer and its `Fly-Client-IP` header are Vercel's egress
 * address. Every real user in a region therefore shared ONE per-IP rate-limit
 * bucket, while anyone calling the api domain directly got a private one — the
 * limiter protected the wrong thing in both directions.
 *
 * A route handler can fix that because it can see the real client. Verified
 * against vercel.com/docs/headers/request-headers (2026-09-11): on Vercel,
 * `x-forwarded-for` / `x-real-ip` carry the public IP of the client, and Vercel
 * OVERWRITES any externally supplied value rather than appending to it. So the
 * value is trustworthy here even though the api must never trust it when it
 * arrives from an arbitrary peer. We hand it on in `X-Eco-Client-IP` alongside
 * `X-Eco-Proxy-Key`, a shared secret that tells the api the header came from us
 * (the same shape as Cloudflare's `CF-Connecting-IP` with authenticated origin
 * pulls). With no secret configured neither header is sent and the api keeps its
 * previous `Fly-Client-IP` → TCP-peer behaviour, so local dev is unchanged.
 *
 * The request body is streamed straight through and never read, buffered or
 * logged: chat never routes through the api, but `/v1/search` carries the user's
 * question verbatim and `/v1/feedback` carries free text, and neither belongs in
 * a Vercel function log.
 */

/**
 * The only request headers that reach the api. An allowlist, not a denylist:
 * anything a client could use to impersonate the proxy (`x-eco-*`), to claim a
 * different origin IP (`x-forwarded-*`, `x-real-ip`, `fly-client-ip`), or to
 * confuse the upstream about its own identity (`host`) must be dropped, and new
 * headers should have to be added deliberately. Hop-by-hop headers
 * (`connection`, `transfer-encoding`, `upgrade`, …) are excluded for the same
 * reason — `fetch` owns the transport.
 */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'cookie',
  'origin',
  'authorization',
  'accept-language',
  'user-agent',
] as const

/**
 * Response headers copied back to the browser. `set-cookie` is handled
 * separately (it can legitimately repeat, so it needs `getSetCookie()`), and
 * `x-ratelimit-*` is matched by prefix because the limiter emits three of them.
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'retry-after',
  'content-disposition',
  // `redirect: 'manual'` below means a 3xx is handed back rather than followed
  // server-side; without `location` the browser would get an un-actionable 3xx.
  'location',
] as const

const RATE_LIMIT_HEADER_PREFIX = 'x-ratelimit-'

const DEFAULT_UPSTREAM = 'http://localhost:3001'

/** Methods that carry no request body, so `fetch` must not be handed one. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

/**
 * The upstream base URL. `API_URL` is the server-only override (so the browser
 * bundle's `NEXT_PUBLIC_API_URL` can keep pointing at the public api domain
 * while this proxy talks to a private address); `NEXT_PUBLIC_API_URL` is the
 * existing variable the removed rewrite used, kept as the fallback so no
 * deployment has to change to keep working.
 */
function resolveUpstreamBase(env: NodeJS.ProcessEnv): string {
  const raw = (env.API_URL ?? env.NEXT_PUBLIC_API_URL ?? DEFAULT_UPSTREAM).trim()
  return raw.replace(/\/+$/, '')
}

/**
 * The client's public IP as seen by the edge. `x-real-ip` is a single address;
 * `x-forwarded-for` may be a list, in which case the FIRST entry is the client
 * (Vercel overwrites the header, so there is no untrusted prefix to skip).
 * Returns `null` when neither is present — then we send no trusted-IP header at
 * all rather than a guess.
 */
function resolveClientIp(headers: Headers): string | null {
  const realIp = headers.get('x-real-ip')?.trim()
  if (realIp) return realIp

  const forwarded = headers.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (!first) return null
  return first
}

function buildUpstreamUrl(request: Request, base: string): string {
  const { pathname, search } = new URL(request.url)
  return `${base}${pathname}${search}`
}

function buildUpstreamHeaders(request: Request, env: NodeJS.ProcessEnv): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }

  // Both or neither: a client IP without the key is unusable to the api, and the
  // key without an IP tells it nothing. Unset secret = the api's old behaviour.
  const proxySecret = env.API_PROXY_SECRET
  const clientIp = resolveClientIp(request.headers)
  if (proxySecret && clientIp) {
    headers.set('X-Eco-Client-IP', clientIp)
    headers.set('X-Eco-Proxy-Key', proxySecret)
  }

  return headers
}

function buildDownstreamHeaders(upstream: Response): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  for (const [name, value] of upstream.headers) {
    if (name.toLowerCase().startsWith(RATE_LIMIT_HEADER_PREFIX)) headers.set(name, value)
  }
  for (const cookie of upstream.headers.getSetCookie()) {
    headers.append('set-cookie', cookie)
  }
  return headers
}

/**
 * Forward one `/v1/*` request to the api and return its response unchanged.
 *
 * An upstream failure becomes a 502 with a fixed body: the cause (DNS, refused
 * connection, the upstream's own hostname) is operator information, not
 * something to hand an anonymous caller, and the client paths already render
 * any non-2xx as their own degraded state.
 */
export async function proxyToApi(request: Request): Promise<Response> {
  const env = process.env
  const url = buildUpstreamUrl(request, resolveUpstreamBase(env))
  const method = request.method.toUpperCase()
  const hasBody = !BODYLESS_METHODS.has(method) && request.body !== null

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method,
      headers: buildUpstreamHeaders(request, env),
      // Streamed, never read here. `duplex: 'half'` is required by the Fetch
      // spec for a stream body and is not yet in the lib.dom types.
      ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
      redirect: 'manual',
      cache: 'no-store',
    } as RequestInit)
  } catch {
    return Response.json(
      { error: { code: 'upstream_unreachable', message: 'API unreachable' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    )
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildDownstreamHeaders(upstream),
  })
}
