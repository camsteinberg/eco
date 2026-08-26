// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The canonical auth base URL. Better Auth builds every transactional-email link
 * (password reset, email verification, magic link) against this origin, so it is
 * also the single source of truth for what a *legitimate* email link looks like.
 * Keep this the exact expression passed to `betterAuth({ baseURL })` — the guard
 * below depends on the two staying identical.
 */
export function getAuthBaseURL(): string {
  return (
    process.env.BETTER_AUTH_BASE_URL ??
    process.env.API_INTERNAL_URL ??
    'http://localhost:3001'
  )
}

/**
 * Defense-in-depth for transactional email: refuse to send a link whose origin is
 * not our own auth origin.
 *
 * Better Auth already scopes generated links to `baseURL` and validates any
 * `callbackURL` against `trustedOrigins`, so in normal operation `url` is always
 * on {@link getAuthBaseURL}. This guard fails closed against a future regression
 * or misconfiguration that could otherwise turn a reset/verify/magic-link email
 * into an open-redirect or phishing vector: an off-origin (or unparseable) link
 * throws instead of being emailed. Returns the URL unchanged when it is trusted.
 */
export function assertSelfOriginEmailLink(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Refusing to send auth email: link URL is not parseable')
  }

  const expectedOrigin = new URL(getAuthBaseURL()).origin
  if (parsed.origin !== expectedOrigin) {
    throw new Error(
      'Refusing to send auth email: link origin is not the auth origin',
    )
  }

  return url
}
