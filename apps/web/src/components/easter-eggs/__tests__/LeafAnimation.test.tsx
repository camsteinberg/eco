// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { LeafAnimation } from '../LeafAnimation'
import { checkEasterEgg } from '../LeafAnimation'

describe('LeafAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Default: no reduced motion preference
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('renders leaf SVG elements when visible=true and variant="leaves"', () => {
    const onComplete = vi.fn()
    const { container } = render(
      <LeafAnimation visible={true} onComplete={onComplete} variant="leaves" />
    )
    const leafElements = container.querySelectorAll('[aria-hidden="true"]')
    // Should have 12-15 leaves plus the container
    expect(leafElements.length).toBeGreaterThanOrEqual(12)
  })

  it('renders snowflake elements when visible=true and variant="snow"', () => {
    const onComplete = vi.fn()
    const { container } = render(
      <LeafAnimation visible={true} onComplete={onComplete} variant="snow" />
    )
    // Snow renders circles, check for elements with data-particle attribute
    const particles = container.querySelectorAll('[data-particle]')
    expect(particles.length).toBeGreaterThanOrEqual(20)
  })

  it('renders nothing when visible=false', () => {
    const onComplete = vi.fn()
    const { container } = render(
      <LeafAnimation visible={false} onComplete={onComplete} variant="leaves" />
    )
    expect(container.innerHTML).toBe('')
  })

  it('auto-hides after ~4 seconds (calls onComplete)', () => {
    const onComplete = vi.fn()
    render(
      <LeafAnimation visible={true} onComplete={onComplete} variant="leaves" />
    )
    expect(onComplete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(4100)
    expect(onComplete).toHaveBeenCalled()
  })

  it('respects prefers-reduced-motion (renders nothing)', () => {
    // Set reduced motion preference
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    })
    const onComplete = vi.fn()
    const { container } = render(
      <LeafAnimation visible={true} onComplete={onComplete} variant="leaves" />
    )
    expect(container.innerHTML).toBe('')
    expect(onComplete).toHaveBeenCalled()
  })
})

describe('checkEasterEgg', () => {
  it('"hello forest" always triggers leaves regardless of season', () => {
    const seasons = ['spring', 'summer', 'autumn', 'winter'] as const
    for (const season of seasons) {
      const result = checkEasterEgg('hello forest', season)
      expect(result).not.toBeNull()
      expect(result!.variant).toBe('leaves')
    }
  })

  it('"let it snow" only triggers in winter', () => {
    expect(checkEasterEgg('let it snow', 'winter')).not.toBeNull()
    expect(checkEasterEgg('let it snow', 'winter')!.variant).toBe('snow')
    expect(checkEasterEgg('let it snow', 'spring')).toBeNull()
    expect(checkEasterEgg('let it snow', 'summer')).toBeNull()
    expect(checkEasterEgg('let it snow', 'autumn')).toBeNull()
  })

  it('"falling leaves" triggers denser leaves in autumn', () => {
    const result = checkEasterEgg('falling leaves', 'autumn')
    expect(result).not.toBeNull()
    expect(result!.variant).toBe('dense-leaves')
  })

  it('"falling leaves" triggers normal leaves in non-autumn seasons', () => {
    // "falling leaves" should still trigger leaves in other seasons, just not dense
    const result = checkEasterEgg('falling leaves', 'spring')
    expect(result).not.toBeNull()
    expect(result!.variant).toBe('leaves')
  })

  it('easter egg triggers are case-insensitive', () => {
    expect(checkEasterEgg('Hello Forest', 'spring')).not.toBeNull()
    expect(checkEasterEgg('LET IT SNOW', 'winter')).not.toBeNull()
  })

  it('returns null for non-matching messages', () => {
    expect(checkEasterEgg('how is the weather?', 'spring')).toBeNull()
    expect(checkEasterEgg('tell me about forests', 'summer')).toBeNull()
  })
})
