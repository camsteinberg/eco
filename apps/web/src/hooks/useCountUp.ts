// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useEffect, useRef, useState, useCallback } from 'react'

type UseCountUpOptions = {
  /** Target value to count up to */
  endValue: number
  /** Animation duration in ms (default: 2000) */
  duration?: number
  /** Start counting when element enters viewport (default: true) */
  startOnView?: boolean
  /** Decimal places (default: 0) */
  decimals?: number
}

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
}

export function useCountUp({
  endValue,
  duration = 2000,
  startOnView = true,
  decimals = 0,
}: UseCountUpOptions) {
  const [value, setValue] = useState(0)
  const [hasStarted, setHasStarted] = useState(false)
  const ref = useRef<HTMLElement>(null)
  const rafRef = useRef<number | null>(null)

  const start = useCallback(() => {
    if (hasStarted) return
    setHasStarted(true)

    // Check prefers-reduced-motion
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(endValue)
      return
    }

    const startTime = performance.now()

    const animate = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const easedProgress = easeOutExpo(progress)

      setValue(Number((easedProgress * endValue).toFixed(decimals)))

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate)
      }
    }

    rafRef.current = requestAnimationFrame(animate)
  }, [endValue, duration, decimals, hasStarted])

  // IntersectionObserver for viewport entry
  useEffect(() => {
    if (!startOnView || hasStarted) return
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          start()
          observer.unobserve(el)
        }
      },
      { threshold: 0.3 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [startOnView, start, hasStarted])

  // Cleanup
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const formattedValue = value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })

  return { value, formattedValue, start, ref, hasStarted }
}
