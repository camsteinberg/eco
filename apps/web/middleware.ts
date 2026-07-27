// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import {
  isRetiredPublicAuthBouncePath,
  resolveAuthSuccessDestination,
  sanitizeRelativeUrl,
} from './src/lib/auth-continuation'
import {
  isValidSiteGateAccessToken,
  SITE_ACCESS_COOKIE,
} from './src/lib/site-gate-cookie'

const MODEL_CONNECT_SRC = [
  'https://huggingface.co',
  'https://*.huggingface.co',
  'https://cdn-lfs.hf.co',
  'https://*.hf.co',
  'https://*.xethub.hf.co',
  'https://*.r2.cloudflarestorage.com',
  // Model-file CDN (R2 behind a Cloudflare custom domain) for direct,
  // free-egress weight delivery — the data-plane the download resolver targets
  // when NEXT_PUBLIC_ECO_MODEL_CDN_BASE is set. The wildcard above does NOT
  // cover this custom domain, so it is allow-listed explicitly. Allow-listing
  // it unconditionally is safe (CSP permits, it does not force use) and means
  // the CDN flag can flip with no separate CSP redeploy.
  'https://models.econetwork.ai',
  // The GitHub raw-content origin stays out of connect-src: the WebLLM/MLC
  // runtime's model_lib WASM is now served SAME-ORIGIN from /webllm/ (covered by
  // `connect-src 'self'`), and weights come through the same-origin proxy/CDN
  // already listed above — so no model asset needs a third-party fetch origin.
].join(' ')

// Phase 5 grounding talks DIRECTLY from the browser to Wikimedia's public REST
// endpoints (Wikipedia article search/summary + Wikidata statements) — no proxy,
// by design, so Eco's servers never see grounding queries. Without these origins
// the lookups are CSP-blocked and every factual question silently falls back to
// the "couldn't reach reference sources" degraded path. English-only for v1.
const GROUNDING_CONNECT_SRC = [
  'https://en.wikipedia.org',
  'https://www.wikidata.org',
].join(' ')

const PUBLIC_PATHS = new Set(['/', '/archive', '/sign-in', '/sign-up', '/forgot-password', '/reset-password', '/gate', '/privacy', '/terms', '/contributors', '/developers', '/impact', '/try', '/transparency', '/invite' /* legacy: bounces stale /invite links */, '/api/auth', '/api/gate', '/api/deploy-health', '/api/dev-login', '/api/dev-logout', '/api/local-models', '/api/ort', '/api/litert-wasm'])
const AUTH_PATHS = new Set(['/sign-in', '/sign-up'])
// Runtime-asset routes (/api/local-models, /api/ort, /api/litert-wasm) must
// bypass the gate: engine loaders fetch them without page context, and a 307
// to /gate hands WebAssembly.instantiate an HTML body (broke every real-prod
// LiteRT load until 2026-07-03). They serve only allowlisted static assets.
// /webllm holds the WebLLM/MLC model_lib WASM (public/webllm/, build-copied) and
// the same-origin model base its cache keys derive from — same reasoning; the
// matcher below already excludes it from middleware entirely, this is the
// defensive belt for any path that still reaches here.
const SITE_GATE_BYPASS_PATHS = new Set(['/gate', '/api/gate', '/api/deploy-health', '/api/local-models', '/api/ort', '/api/litert-wasm', '/webllm', '/privacy', '/terms', '/transparency', '/impact'])

function isPublicPath(pathname: string): boolean {
  for (const path of PUBLIC_PATHS) {
    if (pathname === path || (path !== '/' && pathname.startsWith(path + '/'))) return true
  }
  return false
}

function isAuthPath(pathname: string): boolean {
  for (const path of AUTH_PATHS) {
    if (pathname === path || pathname.startsWith(path + '/')) return true
  }
  return false
}

function isSiteGateBypassPath(pathname: string): boolean {
  for (const path of SITE_GATE_BYPASS_PATHS) {
    if (pathname === path || pathname.startsWith(path + '/')) return true
  }
  return false
}

/** Build the Content-Security-Policy header value for the current environment. */
function buildCSP(nonce?: string): string {
  const isDev = process.env.NODE_ENV === 'development'
  const scriptSrc = isDev
    ? "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
    : `'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self' ${MODEL_CONNECT_SRC} ${GROUNDING_CONNECT_SRC}`,
    `worker-src 'self' blob:`,
    // No plugin/embedded objects: clickjacking is already covered by
    // frame-ancestors 'none'; object-src 'none' closes the <object>/<embed>/
    // <applet> vector that would otherwise inherit default-src.
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ')
}

// Transport/content-sniffing hardening that belongs on every response the
// middleware controls (redirects included):
//   - HSTS pins the browser to HTTPS for a year, closing the first-visit /
//     SSL-strip downgrade window for a session-auth origin. No `preload` — that
//     is semi-irreversible and requires every subdomain (incl. the Fly API) to
//     be verified HTTPS-only first (owner-provisioned, post-launch). X-Frame-Options is
//     intentionally omitted — it's legacy and frame-ancestors 'none' already
//     covers clickjacking.
//   - nosniff stops content-type sniffing on HTML/JS/JSON responses.
function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  return response
}

/** Apply CSP + transport-security response headers to any response object. */
function applyCSP(response: NextResponse, cspHeader: string): NextResponse {
  response.headers.set('Content-Security-Policy', cspHeader)
  return applySecurityHeaders(response)
}

function applyNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  response.headers.set('Pragma', 'no-cache')
  return response
}

/** Create a NextResponse.next() with CSP on both request and response headers. */
function createNextWithCSP(request: NextRequest, nonce: string | undefined, cspHeader: string): NextResponse {
  const requestHeaders = new Headers(request.headers)
  if (nonce) {
    requestHeaders.set('x-nonce', nonce)
  } else {
    requestHeaders.delete('x-nonce')
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', cspHeader)
  return applySecurityHeaders(response)
}

function getRequestedDestination(request: NextRequest): string {
  const { pathname, search } = request.nextUrl
  return `${pathname}${search}`
}

function buildCanonicalChatUrl(request: NextRequest): URL {
  const chatUrl = request.nextUrl.clone()
  chatUrl.pathname = '/chat'
  chatUrl.searchParams.delete('preview')
  return chatUrl
}

function getCanonicalRequestedDestination(request: NextRequest): string {
  const { pathname } = request.nextUrl
  if (pathname === '/' || pathname === '/try' || (pathname === '/chat' && request.nextUrl.searchParams.has('preview'))) {
    const chatUrl = buildCanonicalChatUrl(request)
    return `${chatUrl.pathname}${chatUrl.search}`
  }

  return getRequestedDestination(request)
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ── CSP nonce generation ────────────────────────────────────────────
  const nonce = process.env.NODE_ENV === 'development'
    ? undefined
    : Buffer.from(crypto.randomUUID()).toString('base64')
  const cspHeader = buildCSP(nonce)

  // ── Site-wide password gate ──────────────────────────────────────────
  // When SITE_PASSWORD is set, require a password before any page loads.
  // Set this env var on Vercel to keep the site private until launch.
  const sitePassword = process.env.SITE_PASSWORD
  if (sitePassword) {
    if (!isSiteGateBypassPath(pathname)) {
      const accessCookie = request.cookies.get(SITE_ACCESS_COOKIE)
      if (!(await isValidSiteGateAccessToken(accessCookie?.value, sitePassword))) {
        const gateUrl = new URL('/gate', request.url)
        gateUrl.searchParams.set('returnTo', sanitizeRelativeUrl(getCanonicalRequestedDestination(request), '/chat'))
        return applyCSP(applyNoStore(NextResponse.redirect(gateUrl)), cspHeader)
      }
    }
  }

  // ── Auth middleware ──────────────────────────────────────────────────
  // Note: In the cross-origin setup (web on Vercel, API on Fly.io), the
  // Better Auth session cookie is set on api.econetwork.ai and is NOT
  // visible to this middleware (which sees econetwork.ai cookies only).
  // Client-side auth protection is handled by AppShell's useSession() guard.
  // The cookie check below is a best-effort optimization that works when
  // COOKIE_DOMAIN is set to share cookies across subdomains.
  const sessionCookie =
    request.cookies.get('__Secure-better-auth.session_token') ??
    request.cookies.get('better-auth.session_token')

  // Canonical launch entry: avoid rendering retired/demo surfaces before chat.
  if (pathname === '/' || pathname === '/try') {
    return applyCSP(NextResponse.redirect(buildCanonicalChatUrl(request)), cspHeader)
  }

  if (pathname === '/chat' && request.nextUrl.searchParams.has('preview')) {
    return applyCSP(NextResponse.redirect(buildCanonicalChatUrl(request)), cspHeader)
  }

  // Authenticated users visiting sign-in/sign-up get redirected to chat
  if (sessionCookie && isAuthPath(pathname)) {
    const destination = resolveAuthSuccessDestination(
      request.nextUrl.searchParams.get('callbackUrl'),
      request.nextUrl.searchParams.get('prompt'),
    )
    return applyCSP(NextResponse.redirect(new URL(destination, request.url)), cspHeader)
  }

  if (sessionCookie && isRetiredPublicAuthBouncePath(pathname)) {
    return applyCSP(NextResponse.redirect(new URL('/chat', request.url)), cspHeader)
  }

  // For protected (non-public) routes, prevent back-button bypass by
  // telling the browser not to cache the page from bfcache/disk cache.
  if (!isPublicPath(pathname)) {
    const response = createNextWithCSP(request, nonce, cspHeader)
    return applyNoStore(response)
  }

  return createNextWithCSP(request, nonce, cspHeader)
}

export const config = {
  matcher: [
    // Static assets must bypass middleware entirely — when SITE_PASSWORD is set,
    // the site-gate would otherwise 307 these to /gate with a text/plain body,
    // causing Chromium's PWA validator to fail parsing manifest.webmanifest as JSON.
    // litert-wasm/, ort/, and webllm/ are the build-copied runtime engine assets
    // (public/…, see scripts/copy-runtime-assets.mjs) — engine loaders fetch
    // them cookie-less, so the site-gate 307 would poison WebAssembly
    // instantiation just like it did the manifest.
    '/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|icons/|litert-wasm/|ort/|webllm/|api/auth).*)',
  ],
}
