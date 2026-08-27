// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * Battery awareness hook for on-device inference.
 *
 * Reads battery level and charging state via the Battery Status API and
 * derives a restriction tier:
 *
 * - **none** (>20% or charging)
 * - **reduced** (<20%, not charging)
 * - **disabled** (<10%, not charging)
 *
 * What the app actually DOES with it today: `useLocalModelReadiness` shows a
 * low-battery notice when the tier is `reduced`. Generation is not paused and
 * token budgets are not changed by battery state — `getMaxTokensForBattery`
 * exists for that but has no production caller.
 *
 * When the Battery API is unavailable (Safari, Firefox), fails open with no
 * restrictions and no battery-related UI. The OS handles power management.
 *
 * Privacy: Battery data is NEVER sent to any server. Used only for local UI.
 *
 * Mobile detection: On mobile viewports (max-width: 768px), defaults
 * preferredModel to 'quick' tier.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { getValidationHarnessBatteryOverride } from '../lib/validation-harness';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BatteryRestriction = 'none' | 'reduced' | 'disabled';

/** Model tier for battery-aware preferred model selection. */
export type ModelTier = 'quick' | 'full';

export type UseBatteryAwarenessReturn = {
  /** Battery level (0-1), null when Battery API unavailable */
  level: number | null;
  /** Whether device is charging, null when Battery API unavailable */
  charging: boolean | null;
  /** Current restriction tier based on battery state */
  restriction: BatteryRestriction;
  /** Preferred model tier based on device form factor */
  preferredModel: ModelTier;
};

// ---------------------------------------------------------------------------
// Battery restriction thresholds
// ---------------------------------------------------------------------------

const THRESHOLD_REDUCED = 0.2; // Below 20%: halve max_new_tokens
const THRESHOLD_DISABLED = 0.1; // Below 10%: disable local inference

/**
 * Compute the battery restriction based on level and charging state.
 */
export function computeRestriction(level: number | null, charging: boolean | null): BatteryRestriction {
  // Battery API unavailable — fail open
  if (level === null || charging === null) return 'none';
  // Charging removes all restrictions
  if (charging) return 'none';
  // Apply thresholds
  if (level < THRESHOLD_DISABLED) return 'disabled';
  if (level < THRESHOLD_REDUCED) return 'reduced';
  return 'none';
}

// ---------------------------------------------------------------------------
// Utility: adjust max tokens for battery restriction
// ---------------------------------------------------------------------------

/**
 * Get the adjusted max_new_tokens for the current battery restriction.
 * Exported for reuse in useLocalInference and other contexts.
 *
 * @param baseTokens - The normal max_new_tokens value
 * @param restriction - The current battery restriction
 * @returns Adjusted token count (0 for disabled = should not generate)
 */
export function getMaxTokensForBattery(baseTokens: number, restriction: BatteryRestriction | string): number {
  switch (restriction) {
    case 'reduced':
      return Math.floor(baseTokens / 2);
    case 'disabled':
      return 0;
    default:
      return baseTokens;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBatteryAwareness(): UseBatteryAwarenessReturn {
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState<boolean | null>(null);
  const [preferredModel, setPreferredModel] = useState<ModelTier>('full');
  const cleanupRef = useRef<(() => void) | null>(null);

  // Detect mobile viewport for preferred model
  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const mq = window.matchMedia('(max-width: 768px)');
      if (mq.matches) {
        setPreferredModel('quick');
      }
    } catch {
      // matchMedia not available — default to full
    }
  }, []);

  // Update local state whenever battery state changes
  const updateBattery = useCallback((newLevel: number | null, newCharging: boolean | null) => {
    setLevel(newLevel);
    setCharging(newCharging);
  }, []);

  // Initialize Battery API monitoring
  useEffect(() => {
    const validationOverride = getValidationHarnessBatteryOverride();
    if (validationOverride) {
      updateBattery(validationOverride.level, validationOverride.charging);
      return;
    }

    if (typeof navigator === 'undefined') return;
    if (!('getBattery' in navigator)) {
      // Battery API unavailable — fail open
      return;
    }

    let mounted = true;

    navigator.getBattery!().then((battery) => {
      if (!mounted) return;

      // Initial state
      updateBattery(battery.level, battery.charging);

      // Listen for changes
      const handleLevelChange = () => {
        if (mounted) {
          updateBattery(battery.level, battery.charging);
        }
      };

      const handleChargingChange = () => {
        if (mounted) {
          updateBattery(battery.level, battery.charging);
        }
      };

      battery.addEventListener('levelchange', handleLevelChange);
      battery.addEventListener('chargingchange', handleChargingChange);

      // Store cleanup function
      cleanupRef.current = () => {
        battery.removeEventListener('levelchange', handleLevelChange);
        battery.removeEventListener('chargingchange', handleChargingChange);
      };
    }).catch(() => {
      // getBattery() failed — fail open (no restrictions)
    });

    return () => {
      mounted = false;
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [updateBattery]);

  const restriction = computeRestriction(level, charging);

  return {
    level,
    charging,
    restriction,
    preferredModel,
  };
}
