// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Transition } from 'motion/react';

export const springPresets = {
  snappy: { type: 'spring' as const, stiffness: 500, damping: 30 },
  modal: { type: 'spring' as const, stiffness: 280, damping: 22 },
  gentle: { type: 'spring' as const, stiffness: 200, damping: 20 },
  bouncy: { type: 'spring' as const, stiffness: 300, damping: 15, bounce: 0.6 },
  instant: { duration: 0 },
} satisfies Record<string, Transition>;

export function getTransition(
  preset: keyof typeof springPresets,
  shouldReduceMotion: boolean | null,
): Transition {
  return shouldReduceMotion ? springPresets.instant : springPresets[preset];
}
