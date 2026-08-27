// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono } from 'hono'
import { feedback } from '../db/schema/feedback.js'
import type { Db } from '../db/index.js'

type Env = {
  Variables: {
    /** Per-request pino child logger set by the logging middleware. */
    logger?: { error: (obj: unknown, msg?: string) => void }
  }
}

// Bounds are deliberately tight: this is an anonymous write endpoint. The
// 64 KB body limit and the `feedback` rate-limit tier sit in front of it
// (wired in index.ts); these caps bound what actually reaches the table.
const MAX_MESSAGE_LENGTH = 4000
const MAX_DEVICE_SUMMARY_LENGTH = 1000
const MAX_FAILURE_SUMMARY_LENGTH = 2000

export function createFeedbackRouter({ db }: { db: Db }) {
  const router = new Hono<Env>()

  // POST / — accept a feedback submission. Anonymous by design: no user id,
  // no IP, no headers are stored — only the typed message and the device
  // summary the person explicitly opted into sending.
  router.post('/', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json(
        { error: { message: 'Invalid JSON', type: 'invalid_request_error' } },
        400,
      )
    }

    if (typeof body.message !== 'string') {
      return c.json(
        { error: { message: 'message is required and must be a string', type: 'validation_error' } },
        400,
      )
    }

    const message = body.message.trim()

    if (message.length === 0) {
      return c.json(
        { error: { message: 'message must not be empty after trimming', type: 'validation_error' } },
        400,
      )
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return c.json(
        { error: { message: `message must be at most ${MAX_MESSAGE_LENGTH} characters`, type: 'validation_error' } },
        400,
      )
    }

    let deviceSummary: string | null = null
    if (body.deviceSummary !== undefined && body.deviceSummary !== null) {
      if (typeof body.deviceSummary !== 'string') {
        return c.json(
          { error: { message: 'deviceSummary must be a string when provided', type: 'validation_error' } },
          400,
        )
      }
      const trimmed = body.deviceSummary.trim()
      if (trimmed.length > MAX_DEVICE_SUMMARY_LENGTH) {
        return c.json(
          { error: { message: `deviceSummary must be at most ${MAX_DEVICE_SUMMARY_LENGTH} characters`, type: 'validation_error' } },
          400,
        )
      }
      deviceSummary = trimmed.length > 0 ? trimmed : null
    }

    let failureSummary: string | null = null
    if (body.failureSummary !== undefined && body.failureSummary !== null) {
      if (typeof body.failureSummary !== 'string') {
        return c.json(
          { error: { message: 'failureSummary must be a string when provided', type: 'validation_error' } },
          400,
        )
      }
      const trimmed = body.failureSummary.trim()
      if (trimmed.length > MAX_FAILURE_SUMMARY_LENGTH) {
        return c.json(
          { error: { message: `failureSummary must be at most ${MAX_FAILURE_SUMMARY_LENGTH} characters`, type: 'validation_error' } },
          400,
        )
      }
      failureSummary = trimmed.length > 0 ? trimmed : null
    }

    try {
      await db.insert(feedback).values({ message, deviceSummary, failureSummary })
    } catch (err) {
      // Catch here rather than letting the global onError handle it: driver
      // errors can carry the bound SQL parameters (the feedback text), and the
      // global handler logs the whole error object. Log only name/message —
      // the text must never reach the logs.
      const name = err instanceof Error ? err.name : 'UnknownError'
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 200)
      c.get('logger')?.error({ name, detail }, 'Feedback insert failed')
      return c.json(
        { error: { message: 'Could not save feedback. Please try again shortly.', type: 'server_error' } },
        500,
      )
    }

    return c.json({ ok: true })
  })

  return router
}
