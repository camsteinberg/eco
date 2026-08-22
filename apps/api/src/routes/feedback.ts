// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono } from 'hono'
import { feedback } from '../db/schema/feedback.js'
import type { Db } from '../db/index.js'

// Bounds are deliberately tight: this is an anonymous write endpoint. The
// 64 KB body limit and the `feedback` rate-limit tier sit in front of it
// (wired in index.ts); these caps bound what actually reaches the table.
const MAX_MESSAGE_LENGTH = 4000
const MAX_DEVICE_SUMMARY_LENGTH = 1000

export function createFeedbackRouter({ db }: { db: Db }) {
  const router = new Hono()

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

    await db.insert(feedback).values({ message, deviceSummary })

    return c.json({ ok: true })
  })

  return router
}
