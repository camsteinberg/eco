// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useEffect, useRef, useMemo } from 'react'
import type { Season } from '../../lib/season'

export type AnimationVariant = 'leaves' | 'snow' | 'dense-leaves'

export type EasterEggState = {
  variant: AnimationVariant
}

type LeafAnimationProps = {
  visible: boolean
  onComplete: () => void
  variant?: AnimationVariant
}

/**
 * Check if a message triggers an easter egg animation.
 * Returns the appropriate variant, or null if no match.
 */
export function checkEasterEgg(message: string, season: Season): EasterEggState | null {
  const lower = message.toLowerCase().trim()

  // "hello forest" / "hello eco" / "thank you forest" -- always triggers leaves
  if (lower === 'hello forest' || lower === 'hello eco' || lower === 'thank you forest') {
    return { variant: 'leaves' }
  }

  // "let it snow" -- winter only
  if (lower === 'let it snow') {
    if (season === 'winter') return { variant: 'snow' }
    return null
  }

  // "falling leaves" -- dense in autumn, normal otherwise
  if (lower === 'falling leaves') {
    if (season === 'autumn') return { variant: 'dense-leaves' }
    return { variant: 'leaves' }
  }

  return null
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Generate random particles for the animation overlay.
 */
function generateParticles(variant: AnimationVariant) {
  const count = variant === 'dense-leaves' ? 28 : variant === 'snow' ? 22 : 14
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    delay: Math.random() * 2,
    duration: variant === 'snow' ? 5 + Math.random() * 3 : 3 + Math.random() * 2,
    size: variant === 'snow' ? 4 + Math.random() * 4 : 12 + Math.random() * 8,
    rotation: Math.random() * 360,
    opacity: 0.4 + Math.random() * 0.5,
    swayAmount: variant === 'snow' ? 20 + Math.random() * 20 : 40 + Math.random() * 60,
  }))
}

const KEYFRAMES_STYLE = `
@keyframes leaf-fall {
  0% { transform: translateY(-20px) translateX(0) rotate(var(--leaf-rotate)); opacity: var(--leaf-opacity); }
  25% { transform: translateY(25vh) translateX(calc(var(--leaf-sway) * 0.5)) rotate(calc(var(--leaf-rotate) + 90deg)); }
  50% { transform: translateY(50vh) translateX(calc(var(--leaf-sway) * -0.3)) rotate(calc(var(--leaf-rotate) + 180deg)); }
  75% { transform: translateY(75vh) translateX(calc(var(--leaf-sway) * 0.4)) rotate(calc(var(--leaf-rotate) + 270deg)); }
  100% { transform: translateY(105vh) translateX(calc(var(--leaf-sway) * -0.2)) rotate(calc(var(--leaf-rotate) + 360deg)); opacity: 0; }
}
@keyframes snow-fall {
  0% { transform: translateY(-10px) translateX(0); opacity: var(--leaf-opacity); }
  25% { transform: translateY(25vh) translateX(calc(var(--leaf-sway) * 0.3)); }
  50% { transform: translateY(50vh) translateX(calc(var(--leaf-sway) * -0.2)); }
  75% { transform: translateY(75vh) translateX(calc(var(--leaf-sway) * 0.25)); }
  100% { transform: translateY(105vh) translateX(0); opacity: 0; }
}
`

/**
 * Falling leaf/snowflake overlay animation component.
 * Renders as a fixed overlay with pointer-events-none.
 * Auto-dismisses after ~4 seconds.
 */
export function LeafAnimation({ visible, onComplete, variant = 'leaves' }: LeafAnimationProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const particles = useMemo(() => {
    if (!visible) return []
    return generateParticles(variant)
  }, [visible, variant])

  useEffect(() => {
    if (!visible) return

    // Reduced motion: immediately complete
    if (prefersReducedMotion()) {
      onComplete()
      return
    }

    timerRef.current = setTimeout(() => {
      onComplete()
    }, 4000)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [visible, onComplete])

  if (!visible) return null
  if (prefersReducedMotion()) return null

  const isSnow = variant === 'snow'
  const animationName = isSnow ? 'snow-fall' : 'leaf-fall'

  return (
    <div
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 50, overflow: 'hidden' }}
      role="presentation"
    >
      <span className="sr-only" role="status">
        {isSnow ? 'Easter egg: snowfall!' : 'Easter egg: falling leaves!'}
      </span>
      <style>{KEYFRAMES_STYLE}</style>
      {particles.map((p) => (
        isSnow ? (
          <div
            key={p.id}
            data-particle
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: `${String(p.left)}%`,
              top: '-10px',
              width: `${String(p.size)}px`,
              height: `${String(p.size)}px`,
              borderRadius: '50%',
              backgroundColor: 'var(--eco-primary-soft, #e8f0f5)',
              opacity: p.opacity,
              filter: p.size < 6 ? 'blur(1px)' : 'none',
              animation: `${animationName} ${String(p.duration)}s ${String(p.delay)}s ease-in-out forwards`,
              ['--leaf-sway' as string]: `${String(p.swayAmount)}px`,
              ['--leaf-opacity' as string]: p.opacity,
            }}
          />
        ) : (
          <svg
            key={p.id}
            aria-hidden="true"
            data-particle
            width={p.size}
            height={p.size}
            viewBox="0 0 24 24"
            style={{
              position: 'absolute',
              left: `${String(p.left)}%`,
              top: '-20px',
              animation: `${animationName} ${String(p.duration)}s ${String(p.delay)}s ease-in-out forwards`,
              ['--leaf-rotate' as string]: `${String(p.rotation)}deg`,
              ['--leaf-sway' as string]: `${String(p.swayAmount)}px`,
              ['--leaf-opacity' as string]: p.opacity,
            }}
          >
            <path
              d="M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66.95-2.3c.48.17.98.3 1.34.3C19 20 22 3 22 3c-1 2-8 2.25-13 3.25S2 11.5 2 13.5s1.75 3.75 1.75 3.75C7 8 17 8 17 8z"
              fill="var(--eco-primary, #5a9e6f)"
              opacity={p.opacity}
            />
          </svg>
        )
      ))}
    </div>
  )
}
