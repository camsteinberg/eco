// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { BotanicalAnimation } from './BotanicalAnimation';
import { ProgressBar } from '../ui/ProgressBar';
import { VALUE_PILLARS } from '../../lib/value-pillars';
import { isBillingUiEnabled } from '../../lib/billing-ui-gate';

/**
 * Welcome + setup wait — the v1.0 first-touch surface.
 *
 * Renders:
 *   - centered botanical illustration (matures with progress)
 *   - "Eco" wordmark + subtitle
 *   - a calm status line + a progress bar bound to real download progress
 *   - rotating reassurance line (one visible, crossfade transition)
 *   - the three-pillar value pitch (chromeless, hairline-divided)
 *
 * Deliberately nothing else: no composer ghost, no boxed cards — the wait
 * surface stays a single calm column until the real chat takes over.
 *
 * The progress bar is the concrete "how much longer" signal — it tracks
 * aggregate downloaded bytes (monotonic), so it is honest and does not tick
 * backward like a time estimate would. No bytes/KB/s or raw percentage text.
 *
 * The component is a pure presentational shell — all state comes from
 * useEcoSetup, which wires to the live download/smoke pipeline.
 */

export type WelcomeSetupProps = {
  /** Setup phase from useEcoSetup. */
  phase: 'downloading' | 'smoke' | 'done';
  /** 0..100 aggregate download progress. Drives the bar and the illustration. */
  percent: number;
  /** Retained for compatibility with the setup gate; the progress bar now
   * carries the "how much longer" signal, so the copy no longer shows a
   * per-second countdown (it read as an inaccurate ticking timer). */
  etaSeconds?: number;
  /** Index into REASSURANCE_COPY (taken mod length). */
  reassuranceIndex: number;
  /** True when the prior session's setup attempt ended in error. Renders a
   * subtle "we had trouble setting up last time" note so the system shows
   * memory rather than silently re-trying. */
  priorAttemptFailed?: boolean;
  /** True while the setup ladder is demoting to a lighter model after the
   * first pick failed. Swaps the status line for an honest "finding the best
   * fit" cue so the restart reads as intentional. */
  findingFit?: boolean;
  /** True on a WASM/CPU-only device (no WebGPU), where the one loadable model
   * is our smallest and its first load runs on the slower CPU path. Sets an
   * honest expectation ("this device runs a lighter model") instead of the
   * standard first-load copy. */
  lightweightDevice?: boolean;
  /** True when this run resumed a bound-but-unfinished pick (an interrupted
   * download that a reload left mid-flight). Frames the wait as finishing an
   * existing download rather than a first-run setup, so the copy stays honest. */
  resuming?: boolean;
};

// Five lines at the 8s rotation interval is a ~40s loop. That repeats over a
// multi-minute wait, and repeating five true, concrete lines beats padding the
// list with filler to stretch the cycle. Index 0 is fixed (and unit-test-locked):
// it is the load-bearing first impression and it names what the wait is FOR.
// Every line has to say something concrete a person could act on or remember —
// no slogans, and nothing that merely restates the three-pillar row rendered
// below it, which would spend a slot saying nothing new.
// Changing the length here means changing REASSURANCE_COUNT in useEcoSetup.ts.
const REASSURANCE_COPY_BASE = [
  // — what's happening, and where it lands —
  'Downloading your AI so it never has to leave your device.',
  'The model saves into this browser. No copy lands on a server.',
  // — what it means for you —
  'You can use all of Eco without an account.',
  'You only wait like this once. After today, Eco opens in seconds and works offline.',
] as const;

const REASSURANCE_COPY: string[] = isBillingUiEnabled()
  ? [...REASSURANCE_COPY_BASE, 'Everything Eco does is free. Supporters chip in because they want to.']
  : [...REASSURANCE_COPY_BASE, 'Everything Eco does is free.'];

export function WelcomeSetup({
  phase,
  percent,
  reassuranceIndex,
  priorAttemptFailed = false,
  findingFit = false,
  lightweightDevice = false,
  resuming = false,
}: WelcomeSetupProps) {
  const reducedMotion = useReducedMotion();
  const reassurance = REASSURANCE_COPY[reassuranceIndex % REASSURANCE_COPY.length]!;
  // While the ladder demotes, hold the honest "finding the best fit" line so a
  // reset progress bar reads as deliberate. A resumed pick names the wait as
  // finishing an existing download, not a first-run setup. The smoke phase keeps
  // its own copy either way — it's the real cold load of the chosen model.
  const statusCopy =
    findingFit && phase !== 'smoke'
      ? 'Finding the best fit for your device…'
      : resuming && phase === 'downloading'
        ? 'Finishing your model download…'
        : statusCopyFor(phase, percent, lightweightDevice);

  return (
    <main
      data-eco-setup-surface
      className="min-h-screen w-full flex flex-col items-center justify-center px-6 py-8"
      style={{
        background: 'var(--eco-surface)',
        color: 'var(--eco-text)',
        fontFamily: 'var(--eco-font-body)',
      }}
    >
      <div className="flex flex-col items-center text-center max-w-lg w-full gap-8">
        <BotanicalAnimation phase={phase} percent={percent} size={216} />

        <div className="flex flex-col items-center gap-3">
          <h1
            className="text-4xl tracking-tight"
            style={{ fontFamily: 'var(--eco-font-display)', color: 'var(--eco-text)' }}
          >
            Eco
          </h1>
          <p className="text-base" style={{ color: 'var(--eco-text-secondary)' }}>
            Your private AI, on your device.
          </p>
        </div>

        {/* Status line + the concrete progress signal, with the rotating
            reassurance line directly beneath — one calm reading column, no
            card chrome. The grid overlap keeps the crossfade from shifting
            the layout as lines swap. */}
        <div className="flex w-full flex-col items-center gap-3">
          <p
            aria-live="polite"
            className="text-sm"
            style={{ color: 'var(--eco-text-secondary)' }}
          >
            {statusCopy}
          </p>
          <div className="w-full max-w-[260px]">
            <ProgressBar
              percent={phase === 'done' ? 100 : phase === 'smoke' ? Math.max(percent, 96) : percent}
              ariaLabel="Setup progress"
              working={phase === 'smoke'}
            />
          </div>
          <div
            className="mt-1 grid min-h-12 w-full max-w-md justify-items-center text-[13px] leading-relaxed"
            role="status"
            aria-label="Reassurance message"
            style={{ color: 'var(--eco-text-muted)' }}
          >
            <AnimatePresence initial={false}>
              <motion.span
                key={reassurance}
                initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                exit={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
                transition={{ duration: reducedMotion ? 0 : 0.4 }}
                className="col-start-1 row-start-1 block text-center"
              >
                {reassurance}
              </motion.span>
            </AnimatePresence>
          </div>
        </div>

        {priorAttemptFailed && (
          <p
            role="status"
            className="text-xs"
            style={{ color: 'var(--eco-text-muted)', opacity: 0.85 }}
          >
            Last time got interrupted — picking up where we left off.
          </p>
        )}

        {/* Three-pillar value pitch — the user's first impression while
            the model downloads. Same content as the post-setup chat-input
            pill row so the brand promise is consistent across both surfaces,
            and the same chromeless hairline-divided presentation (WhyEcoCard)
            so it reads as one system, not extra cards. */}
        <ul
          className="mt-4 flex w-full flex-col items-center gap-3 sm:flex-row sm:items-stretch sm:justify-center sm:gap-0"
          aria-label="What makes Eco different"
        >
          {VALUE_PILLARS.map((pillar, i) => (
            <li
              key={pillar.title}
              className={`flex w-full max-w-[200px] flex-col items-center gap-1 px-4 text-center ${
                i > 0 ? 'sm:border-l sm:border-[var(--eco-border-muted)]' : ''
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="flex items-center justify-center"
                  style={{ color: 'var(--eco-primary)' }}
                >
                  {pillar.icon}
                </span>
                <span className="text-xs font-medium" style={{ color: 'var(--eco-text)' }}>
                  {pillar.title}
                </span>
              </span>
              <p
                className="text-[11px] leading-snug"
                style={{ color: 'var(--eco-text-secondary)' }}
              >
                {pillar.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}



function statusCopyFor(
  phase: WelcomeSetupProps['phase'],
  percent: number,
  lightweightDevice: boolean,
): string {
  // The smoke phase includes the first-ever model load — cold caches, shader
  // compilation — which legitimately runs 30-60s. Frame it as the last,
  // one-time step ("almost there") so a bar that pins near-full reads as the
  // finish line, not a stall. On a WASM/CPU-only device the first load runs on
  // the slower CPU path, so promise more room.
  if (phase === 'smoke') {
    return lightweightDevice
      ? 'Waking up your AI. This device runs a lighter model, so the first load can take a minute or two.'
      : 'Almost there: waking up your AI for the first time. This one-time step can take a minute.';
  }
  if (phase === 'done') return 'Ready when you are.';
  if (percent >= 85) return 'Almost ready…';
  // A mid-download beat so the status line advances through the long middle
  // stretch instead of holding one line for the bulk of the bytes. This is a
  // phase label, not a percent readout — the bar carries "how much longer."
  if (percent >= 45) {
    return lightweightDevice
      ? 'Bringing a lighter AI onto your device…'
      : 'Bringing your AI onto your device…';
  }
  // The opening beat sets one calm, static verbal expectation (not a ticking
  // countdown). On a WASM/CPU-only device we name the lighter model up front so
  // it doesn't read like a downgrade later.
  return lightweightDevice
    ? 'Setting up a lighter AI that runs smoothly on this device.'
    : 'Getting your private AI ready. The first download takes a few minutes.';
}
