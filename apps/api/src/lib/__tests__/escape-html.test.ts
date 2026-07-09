// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { escapeHtml } from '../escape-html.js'

describe('escapeHtml', () => {
  it('neutralizes a script-injection payload in a display name', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    )
  })

  it('escapes all five significant HTML characters', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;')
  })

  it('escapes the ampersand first so entities are not double-escaped', () => {
    // A literal "&lt;" typed by a user must become "&amp;lt;", not "&lt;".
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('closes an attribute-breakout attempt', () => {
    expect(escapeHtml('" onmouseover="alert(1)')).toBe(
      '&quot; onmouseover=&quot;alert(1)',
    )
  })

  it('leaves a plain name untouched', () => {
    expect(escapeHtml('Ada Lovelace')).toBe('Ada Lovelace')
  })

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('')
  })
})
