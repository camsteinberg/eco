// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import type { ErrorEvent } from '@sentry/node'
import { scrubSentryEvent } from '../sentry.js'

describe('scrubSentryEvent', () => {
  it('strips the query string from the request URL so a verify-email token is never persisted', () => {
    const event = {
      request: {
        url: 'https://api.econetwork.ai/api/auth/verify-email?token=secret-bearer&callbackURL=/chat',
      },
    } as ErrorEvent

    const scrubbed = scrubSentryEvent(event)

    expect(scrubbed.request?.url).toBe('https://api.econetwork.ai/api/auth/verify-email')
    expect(JSON.stringify(scrubbed)).not.toContain('secret-bearer')
  })

  it('drops the parsed query_string, request body, and authorization/cookie headers', () => {
    const event = {
      request: {
        url: 'https://api.econetwork.ai/api/auth/reset-password',
        query_string: 'token=secret-bearer',
        data: { newPassword: 'super-secret' },
        headers: {
          authorization: 'Bearer abc',
          cookie: 'session=xyz',
          'user-agent': 'curl/8',
        },
      },
    } as ErrorEvent

    const scrubbed = scrubSentryEvent(event)

    expect(scrubbed.request?.query_string).toBeUndefined()
    expect(scrubbed.request?.data).toBeUndefined()
    expect(scrubbed.request?.headers?.authorization).toBeUndefined()
    expect(scrubbed.request?.headers?.cookie).toBeUndefined()
    // Non-sensitive headers are kept — they aid debugging and carry no credential.
    expect(scrubbed.request?.headers?.['user-agent']).toBe('curl/8')
    expect(JSON.stringify(scrubbed)).not.toContain('secret-bearer')
    expect(JSON.stringify(scrubbed)).not.toContain('super-secret')
  })

  it('leaves a query-less URL untouched and tolerates an event with no request', () => {
    const pathOnly = {
      request: { url: 'https://api.econetwork.ai/health' },
    } as ErrorEvent
    expect(scrubSentryEvent(pathOnly).request?.url).toBe('https://api.econetwork.ai/health')

    const noRequest = { message: 'boom' } as ErrorEvent
    expect(() => scrubSentryEvent(noRequest)).not.toThrow()
    expect(scrubSentryEvent(noRequest)).toEqual({ message: 'boom' })
  })
})
