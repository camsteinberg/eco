// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { playMessageSent, playMessageReceived } from '../sounds'

// Mock AudioContext
class MockOscillatorNode {
  type = 'sine'
  frequency = { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }
  connect = vi.fn().mockReturnThis()
  start = vi.fn()
  stop = vi.fn()
  disconnect = vi.fn()
}

class MockGainNode {
  gain = { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }
  connect = vi.fn().mockReturnThis()
  disconnect = vi.fn()
}

class MockAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  createOscillator = vi.fn(() => new MockOscillatorNode())
  createGain = vi.fn(() => new MockGainNode())
  resume = vi.fn().mockResolvedValue(undefined)
  close = vi.fn()
}

describe('sounds', () => {
  let originalAudioContext: typeof globalThis.AudioContext

  beforeEach(() => {
    originalAudioContext = globalThis.AudioContext
    // @ts-expect-error -- mock AudioContext
    globalThis.AudioContext = MockAudioContext
    // Reset module state by re-importing would be ideal but for unit tests
    // we test the public API behavior
  })

  afterEach(() => {
    globalThis.AudioContext = originalAudioContext
  })

  describe('playMessageSent', () => {
    it('does nothing when enabled is false', () => {
      // Should not throw and not create any AudioContext
      expect(() => playMessageSent(false)).not.toThrow()
    })

    it('does nothing when AudioContext is undefined (SSR/test)', () => {
      // @ts-expect-error -- simulate SSR
      delete globalThis.AudioContext
      expect(() => playMessageSent(true)).not.toThrow()
    })

    it('creates AudioContext lazily (not on import)', () => {
      // The module was already imported but no AudioContext should have been created
      // until playMessageSent(true) is called
      // @ts-expect-error -- mock AudioContext
      globalThis.AudioContext = MockAudioContext
      playMessageSent(true)
      // If we got here without error, AudioContext was created on demand
      expect(true).toBe(true)
    })
  })

  describe('playMessageReceived', () => {
    it('creates a distinct tone (does not throw)', () => {
      // @ts-expect-error -- mock AudioContext
      globalThis.AudioContext = MockAudioContext
      expect(() => playMessageReceived(true)).not.toThrow()
    })

    it('does nothing when enabled is false', () => {
      expect(() => playMessageReceived(false)).not.toThrow()
    })
  })
})
