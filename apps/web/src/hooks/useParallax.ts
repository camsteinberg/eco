// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useEffect, useState, useCallback, useRef } from 'react'

type ParallaxOptions = {
  /** Height multiplier for scroll range (default: 1 = 1x viewport height) */
  scrollRange?: number
}

/**
 * Custom hook for parallax scrolling effects.
 * Returns scroll progress (0–1) normalized to viewport height × scrollRange.
 *
 * - Uses passive scroll listener + rAF for performance
 * - < 768px: disabled (returns 0) — saves mobile performance
 * - prefers-reduced-motion: disabled (returns 0)
 */
export function useParallax(options: ParallaxOptions = {}) {
  const { scrollRange = 1 } = options
  const [scrollY, setScrollY] = useState(0)
  const [isEnabled, setIsEnabled] = useState(true)
  const enabledRef = useRef(true)

  useEffect(() => {
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (motionQuery.matches) {
      setIsEnabled(false)
      enabledRef.current = false
      return
    }

    const checkWidth = () => {
      const enabled = window.innerWidth >= 768
      enabledRef.current = enabled
      setIsEnabled(enabled)
    }
    checkWidth()
    window.addEventListener('resize', checkWidth, { passive: true })

    let ticking = false
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          if (enabledRef.current) {
            setScrollY(window.scrollY)
          }
          ticking = false
        })
        ticking = true
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', checkWidth)
    }
  }, [])

  const scrollProgress = typeof window !== 'undefined'
    ? Math.min(1, scrollY / (window.innerHeight * scrollRange))
    : 0

  const getLayerOffset = useCallback(
    (speed: number): number => {
      if (!isEnabled) return 0

      const maxScroll = typeof window !== 'undefined'
        ? window.innerHeight * scrollRange
        : 800
      const clamped = Math.min(scrollY, maxScroll)

      return -(clamped * speed)
    },
    [scrollY, isEnabled, scrollRange]
  )

  const getScrollOpacity = useCallback(
    (fadeSpeed: number): number => {
      if (!isEnabled) return 1

      return Math.max(0, 1 - scrollProgress * fadeSpeed)
    },
    [scrollProgress, isEnabled]
  )

  return {
    scrollY,
    scrollProgress,
    getLayerOffset,
    getScrollOpacity,
    isEnabled,
  }
}
