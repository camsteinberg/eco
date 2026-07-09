// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import * as Sentry from '@sentry/node'
import type { ErrorEvent } from '@sentry/node'

/**
 * Defence-in-depth scrubbing applied to every event before it leaves the
 * process. `sendDefaultPii` is false (the @sentry/node default), so request
 * bodies, IPs, and cookies are not attached automatically; we strip them
 * explicitly too, in case a future integration starts attaching them, and we
 * remove the single-use credentials that ride in request URLs.
 *
 * Why the URL matters: the email-verification link is a GET with the token in
 * the query string (`/api/auth/verify-email?token=…`), and the magic-link /
 * password-reset callbacks carry their token the same way. Those tokens are
 * bearer credentials — they must never be persisted in error tracking. We keep
 * only the path (enough for grouping and debugging) and drop the parsed query
 * params. (Reset POSTs carry the token in the body, which `data` removal below
 * already covers.)
 *
 * Exported for unit testing; wired as `beforeSend` in `initSentry`.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data
    if (typeof event.request.url === 'string') {
      const queryStart = event.request.url.indexOf('?')
      if (queryStart !== -1) {
        event.request.url = event.request.url.slice(0, queryStart)
      }
    }
    delete event.request.query_string
    if (event.request.headers) {
      delete event.request.headers['authorization']
      delete event.request.headers['cookie']
    }
  }
  return event
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
    beforeSend: scrubSentryEvent,
  })
}

export { Sentry }
