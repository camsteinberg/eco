// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Time-of-day greeting for the chat empty state, derived from the user's local clock.
 *
 * Buckets: 05:00–11:59 → morning · 12:00–16:59 → afternoon · 17:00–04:59 → evening.
 *
 * Pure and deterministic — the caller decides when to read `new Date()` (client-side,
 * at mount) so the value never depends on server time and can't cause a hydration flash.
 */
export function timeGreeting(date: Date): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "Good morning.";
  if (hour >= 12 && hour < 17) return "Good afternoon.";
  return "Good evening.";
}
