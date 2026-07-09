// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  SeedIllustration,
  SproutIllustration,
  SaplingIllustration,
  TreeIllustration,
} from '@eco/ui';

/**
 * Botanical animation for the welcome / setup wait.
 *
 * The concrete "how much longer" signal is the progress bar in WelcomeSetup;
 * this illustration is the calm brand presence beside it. Two behaviours:
 *   - Growth : the illustration scales up + rises slightly (0.9→1.0) with
 *              download progress, so the plant matures alongside the bar.
 *   - Stage  : the lifecycle illustration crossfades as it matures —
 *              downloading 0-50% → seed · 50-95% → sprout · smoke → sapling ·
 *              done → tree (a gentle bloom on the final transition).
 *
 * Honors prefers-reduced-motion: no growth, no crossfade — the illustration
 * simply reflects the current stage; it still carries the meaning.
 *
 * The stage illustrations are the shared @eco/ui botanical primitives; a
 * refined custom illustration remains a v1.1 item.
 */

export type BotanicalAnimationProps = {
  phase: 'downloading' | 'smoke' | 'done';
  percent: number;
  /** Size of the visual; defaults to a comfortable hero size. */
  size?: number;
};

const ARIA_LABEL = 'A botanical illustration that grows as Eco prepares your AI.';

const CENTER = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
} as const;

export function BotanicalAnimation({ phase, percent, size = 200 }: BotanicalAnimationProps) {
  const reducedMotion = useReducedMotion();
  const stage = pickStage(phase, percent);
  const Illustration = pickIllustration(stage);

  if (reducedMotion) {
    return (
      <div
        role="img"
        aria-label={ARIA_LABEL}
        className="[&_svg]:[stroke-width:2]"
        style={{ width: size, height: size, ...CENTER }}
      >
        <Illustration size={size} />
      </div>
    );
  }

  const { scale: growthScale, y: growthY } = growthFor(phase, percent);
  // The final tree blooms in with a little more spring; earlier stages settle
  // in quietly so the growth reads as steady, not busy.
  const stageEntrance =
    stage === 'tree'
      ? { type: 'spring' as const, stiffness: 220, damping: 14 }
      : { type: 'spring' as const, stiffness: 120, damping: 18 };

  return (
    // GROWTH layer — percent-driven; the plant matures alongside the bar.
    <motion.div
      role="img"
      aria-label={ARIA_LABEL}
      className="[&_svg]:[stroke-width:2]"
      animate={{ scale: growthScale, y: growthY }}
      transition={{ type: 'spring', stiffness: 55, damping: 20 }}
      style={{ width: size, height: size, position: 'relative' }}
    >
      {/* STAGE layer — crossfades as the plant matures. */}
      <AnimatePresence initial={false} mode="sync">
        <motion.div
          key={stage}
          aria-hidden="true"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.06 }}
          transition={stageEntrance}
          style={{ position: 'absolute', inset: 0, ...CENTER }}
        >
          <Illustration size={size} />
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

type Stage = 'seed' | 'sprout' | 'sapling' | 'tree';

function pickStage(phase: BotanicalAnimationProps['phase'], percent: number): Stage {
  if (phase === 'done') return 'tree';
  if (phase === 'smoke') return 'sapling';
  if (percent >= 50) return 'sprout';
  return 'seed';
}

/**
 * Maps setup progress to a subtle scale + rise. The plant grows from 0.9→1.0
 * across the download so it matures alongside the bar. Smoke (the cold model
 * load, where percent can be stale) holds near-full; done rests at full.
 */
function growthFor(
  phase: BotanicalAnimationProps['phase'],
  percent: number,
): { scale: number; y: number } {
  if (phase === 'done') return { scale: 1, y: 0 };
  if (phase === 'smoke') return { scale: 0.99, y: 0 };
  const p = Math.max(0, Math.min(100, percent)) / 100;
  return { scale: 0.9 + 0.1 * p, y: 6 - 6 * p };
}

function pickIllustration(stage: Stage): React.ComponentType<{ size?: number }> {
  switch (stage) {
    case 'seed': return SeedIllustration;
    case 'sprout': return SproutIllustration;
    case 'sapling': return SaplingIllustration;
    case 'tree': return TreeIllustration;
  }
}
