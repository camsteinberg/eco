// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createFeedbackRouter } from '../feedback.js'

let insertedRows: Array<Record<string, unknown>> = []

const mockDb = {
  insert: vi.fn(),
}

function createApp() {
  insertedRows = []

  // Mock db.insert(table).values(row)
  mockDb.insert.mockImplementation(() => ({
    values: (row: Record<string, unknown>) => {
      insertedRows.push(row)
      return Promise.resolve()
    },
  }))

  const app = new Hono()
  app.route('/v1/feedback', createFeedbackRouter({ db: mockDb as never }))
  return app
}

function submit(app: Hono, body: unknown) {
  return app.request('/v1/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /v1/feedback', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('stores a message and returns ok', async () => {
    const res = await submit(app, { message: 'The download stalled on my laptop.' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(insertedRows).toEqual([
      { message: 'The download stalled on my laptop.', deviceSummary: null, failureSummary: null },
    ])
  })

  it('stores the opt-in device summary when provided', async () => {
    const res = await submit(app, {
      message: 'Model picker is confusing.',
      deviceSummary: 'Firefox 146 · WebGPU · Eco Compact',
    })

    expect(res.status).toBe(200)
    expect(insertedRows).toEqual([
      {
        message: 'Model picker is confusing.',
        deviceSummary: 'Firefox 146 · WebGPU · Eco Compact',
        failureSummary: null,
      },
    ])
  })

  it('trims whitespace and stores an empty device summary as null', async () => {
    const res = await submit(app, { message: '  hello  ', deviceSummary: '   ' })

    expect(res.status).toBe(200)
    expect(insertedRows).toEqual([{ message: 'hello', deviceSummary: null, failureSummary: null }])
  })

  it('treats an explicit null deviceSummary as absent', async () => {
    const res = await submit(app, { message: 'works', deviceSummary: null, failureSummary: null })

    expect(res.status).toBe(200)
    expect(insertedRows).toEqual([{ message: 'works', deviceSummary: null, failureSummary: null }])
  })

  it('stores nothing beyond message and deviceSummary even when extra fields are sent', async () => {
    const res = await submit(app, {
      message: 'hi',
      email: 'someone@example.com',
      ip: '1.2.3.4',
    })

    expect(res.status).toBe(200)
    expect(insertedRows).toEqual([{ message: 'hi', deviceSummary: null, failureSummary: null }])
  })

  it('stores the opt-in failure summary when provided', async () => {
    const res = await submit(app, {
      message: 'the deeper model will not load',
      failureSummary: '2026-08-26 load-fail candidate/lfm2-2.6b-onnx webgpu',
    })
    expect(res.status).toBe(200)
    expect(insertedRows).toEqual([
      {
        message: 'the deeper model will not load',
        deviceSummary: null,
        failureSummary: '2026-08-26 load-fail candidate/lfm2-2.6b-onnx webgpu',
      },
    ])
  })

  it('rejects a non-string failure summary and caps its length', async () => {
    expect((await submit(app, { message: 'x', failureSummary: 42 })).status).toBe(400)
    expect((await submit(app, { message: 'x', failureSummary: 'a'.repeat(2001) })).status).toBe(400)
    expect((await submit(app, { message: 'x', failureSummary: 'a'.repeat(2000) })).status).toBe(200)
  })

  it('rejects a missing message', async () => {
    const res = await submit(app, {})

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.type).toBe('validation_error')
    expect(body.error.message).toMatch(/message/i)
    expect(insertedRows).toEqual([])
  })

  it('rejects a non-string message', async () => {
    const res = await submit(app, { message: 42 })

    expect(res.status).toBe(400)
    expect(insertedRows).toEqual([])
  })

  it('rejects a message that is empty after trimming', async () => {
    const res = await submit(app, { message: '   ' })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.type).toBe('validation_error')
    expect(insertedRows).toEqual([])
  })

  it('rejects a message longer than 4000 characters and accepts exactly 4000', async () => {
    const tooLong = await submit(app, { message: 'a'.repeat(4001) })
    expect(tooLong.status).toBe(400)
    expect((await tooLong.json()).error.message).toMatch(/4000/)

    const exact = await submit(app, { message: 'a'.repeat(4000) })
    expect(exact.status).toBe(200)
    expect(insertedRows).toHaveLength(1)
  })

  it('rejects a non-string deviceSummary', async () => {
    const res = await submit(app, { message: 'hi', deviceSummary: { os: 'mac' } })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toMatch(/deviceSummary/)
    expect(insertedRows).toEqual([])
  })

  it('rejects a deviceSummary longer than 1000 characters', async () => {
    const res = await submit(app, { message: 'hi', deviceSummary: 'd'.repeat(1001) })

    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/1000/)
    expect(insertedRows).toEqual([])
  })

  it('returns a generic 500 that carries no driver detail when the insert fails', async () => {
    mockDb.insert.mockImplementationOnce(() => ({
      values: () =>
        Promise.reject(
          Object.assign(new Error('connect ECONNREFUSED — parameters: ["secret text"]'), {
            parameters: ['secret text'],
          }),
        ),
    }))

    const res = await submit(app, { message: 'secret text' })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.type).toBe('server_error')
    // The response must never echo driver internals or the submitted text.
    expect(JSON.stringify(body)).not.toContain('secret text')
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED')
  })

  it('rejects invalid JSON', async () => {
    const res = await submit(app, 'not-json')

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toEqual({ message: 'Invalid JSON', type: 'invalid_request_error' })
    expect(insertedRows).toEqual([])
  })
})
