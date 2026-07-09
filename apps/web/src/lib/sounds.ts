// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Nature-inspired sound effects using Web Audio API.
 * Wind chime tone for sending messages, leaf rustle for receiving.
 * AudioContext is created lazily on first use — never on import.
 */

let audioCtx: AudioContext | null = null

function getContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null

  try {
    if (!audioCtx) {
      audioCtx = new AudioContext()
    }
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume()
    }
    return audioCtx
  } catch {
    return null
  }
}

/**
 * Check if the user prefers reduced motion.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Play a nature-inspired ascending wind-chime tone when sending a message.
 * Two overlapping sine oscillators that sweep upward — bright and brief.
 *
 * @param enabled - Whether sound effects are enabled (from settings store)
 */
export function playMessageSent(enabled: boolean): void {
  if (!enabled) return
  if (prefersReducedMotion()) return

  const ctx = getContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime

    // Main gain envelope
    const gainNode = ctx.createGain()
    gainNode.gain.setValueAtTime(0.06, now)
    gainNode.gain.linearRampToValueAtTime(0.001, now + 0.2)
    gainNode.connect(ctx.destination)

    // Oscillator 1: 880Hz -> 1320Hz sweep (ascending wind chime)
    const osc1 = ctx.createOscillator()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(880, now)
    osc1.frequency.linearRampToValueAtTime(1320, now + 0.08)
    osc1.connect(gainNode)
    osc1.start(now)
    osc1.stop(now + 0.25)

    // Oscillator 2: harmonic at 1760Hz, delayed 30ms, softer
    const gain2 = ctx.createGain()
    gain2.gain.setValueAtTime(0.04, now + 0.03)
    gain2.gain.linearRampToValueAtTime(0.001, now + 0.2)
    gain2.connect(ctx.destination)

    const osc2 = ctx.createOscillator()
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(1760, now + 0.03)
    osc2.connect(gain2)
    osc2.start(now + 0.03)
    osc2.stop(now + 0.25)
  } catch {
    // Silently fail — sound is non-critical
  }
}

/**
 * Play a softer descending leaf-rustle tone when receiving a response.
 * Descending sine with a triangle undertone — warm and gentle.
 *
 * @param enabled - Whether sound effects are enabled (from settings store)
 */
export function playMessageReceived(enabled: boolean): void {
  if (!enabled) return
  if (prefersReducedMotion()) return

  const ctx = getContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime

    // Main gain envelope — softer than send
    const gainNode = ctx.createGain()
    gainNode.gain.setValueAtTime(0.04, now)
    gainNode.gain.linearRampToValueAtTime(0.001, now + 0.3)
    gainNode.connect(ctx.destination)

    // Oscillator 1: 1320Hz -> 660Hz sweep (descending rustle)
    const osc1 = ctx.createOscillator()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(1320, now)
    osc1.frequency.linearRampToValueAtTime(660, now + 0.1)
    osc1.connect(gainNode)
    osc1.start(now)
    osc1.stop(now + 0.35)

    // Oscillator 2: triangle undertone at 330Hz
    const gain2 = ctx.createGain()
    gain2.gain.setValueAtTime(0.03, now)
    gain2.gain.linearRampToValueAtTime(0.001, now + 0.3)
    gain2.connect(ctx.destination)

    const osc2 = ctx.createOscillator()
    osc2.type = 'triangle'
    osc2.frequency.setValueAtTime(330, now)
    osc2.connect(gain2)
    osc2.start(now)
    osc2.stop(now + 0.35)
  } catch {
    // Silently fail — sound is non-critical
  }
}
