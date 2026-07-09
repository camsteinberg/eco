// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest'
import { getAllowedWebOrigins } from '../auth-origins.js'

describe('getAllowedWebOrigins', () => {
  it('adds local mission browser origins outside production for credentialed validation fixtures', () => {
    expect(
      getAllowedWebOrigins({
        webUrl: 'https://econetwork.ai',
        nodeEnv: 'development',
      }),
    ).toEqual([
      'https://econetwork.ai',
      'http://127.0.0.1:3101',
      'http://localhost:3101',
    ])
  })

  it('deduplicates configured and local validation origins', () => {
    expect(
      getAllowedWebOrigins({
        webUrl: 'http://127.0.0.1:3101, http://localhost:3101, http://127.0.0.1:3101',
        nodeEnv: 'test',
      }),
    ).toEqual([
      'http://127.0.0.1:3101',
      'http://localhost:3101',
    ])
  })

  it('does not add local validation origins in production', () => {
    expect(
      getAllowedWebOrigins({
        webUrl: 'https://econetwork.ai',
        nodeEnv: 'production',
      }),
    ).toEqual(['https://econetwork.ai'])
  })

  it('returns exactly the configured origins in production (no localhost fallback)', () => {
    expect(
      getAllowedWebOrigins({
        webUrl: 'https://econetwork.ai, https://www.econetwork.ai',
        nodeEnv: 'production',
      }),
    ).toEqual(['https://econetwork.ai', 'https://www.econetwork.ai'])
  })

  it('throws in production when WEB_URL is unset (fail closed — no localhost fallback)', () => {
    expect(() =>
      getAllowedWebOrigins({ webUrl: undefined, nodeEnv: 'production' }),
    ).toThrow(/WEB_URL must be set in production/)
  })

  it('throws in production when WEB_URL is empty/whitespace (no usable origins)', () => {
    expect(() =>
      getAllowedWebOrigins({ webUrl: '  ,  ', nodeEnv: 'production' }),
    ).toThrow(/WEB_URL must be set in production/)
  })

  it('falls back to the localhost default outside production when WEB_URL is unset', () => {
    expect(
      getAllowedWebOrigins({ webUrl: undefined, nodeEnv: 'development' }),
    ).toEqual([
      'http://localhost:3000',
      'http://127.0.0.1:3101',
      'http://localhost:3101',
    ])
  })
})
