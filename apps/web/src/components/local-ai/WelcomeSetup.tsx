// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { BotanicalAnimation } from './BotanicalAnimation';
import { GerminatingComposer } from '../chat/GerminatingComposer';
import { ProgressBar } from '../ui/ProgressBar';

/**
 * Welcome + setup wait — the v1.0 first-touch surface.
 *
 * Renders:
 *   - centered botanical illustration (matures with progress)
 *   - "Eco" wordmark + subtitle
 *   - a calm status line + a progress bar bound to real download progress
 *   - rotating reassurance card (one visible, crossfade transition)
 *   - the three-pillar value pitch
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

// The wait runs 2–10 minutes; a 4-line loop (32s) empties fast and reads as
// "stuck" on the back 80%. Blend three registers — the privacy promise, gentle
// process-narration (labor illusion: name the real work), and warmth — so the
// rotation carries the whole wait without obvious repetition. Keep indices 0–1
// fixed; they are the load-bearing first impression (and unit-test-locked).
const REASSURANCE_COPY = [
  // — the promise —
  'Your conversations run on your device.',
  'Eco is open source — your AI, your trust.',
  // — what's happening (names the wait as the reason it's private) —
  'Downloading your AI so it never has to leave your device.',
  'Your chats stay on this device, not our servers.',
  'Saving it to your device — no cloud, no sign-in, no catch.',
  // — the warmth / values —
  "Private, by how it's built — not by promise.",
  'No account needed to think out loud.',
  'Your AI runs without a data center — lighter on water, lighter on the planet.',
  'Set up once — after this, it opens fast and works offline.',
  'Everything Eco does is free. Supporters chip in because they want to.',
];

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
      className="min-h-screen w-full flex flex-col items-center justify-center px-6 py-12"
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

        {/* Status line + the concrete progress signal. */}
        <div className="flex w-full flex-col items-center gap-3">
          <p
            aria-live="polite"
            className="text-sm"
            style={{ color: 'var(--eco-text-muted)' }}
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
            pill row so the brand promise is consistent across both surfaces. */}
        <ul
          className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3"
          aria-label="What makes Eco different"
        >
          {VALUE_PILLARS.map((pillar) => (
            <li
              key={pillar.title}
              className="flex flex-col items-center gap-1.5 rounded-2xl px-3 py-3 text-center"
              style={{
                background: 'var(--eco-surface-elevated)',
                border: '1px solid var(--eco-border-muted)',
              }}
            >
              <span
                aria-hidden="true"
                className="flex h-6 w-6 items-center justify-center"
                style={{ color: 'var(--eco-primary)' }}
              >
                {pillar.icon}
              </span>
              <p
                className="text-xs font-medium"
                style={{ color: 'var(--eco-text)' }}
              >
                {pillar.title}
              </p>
              <p
                className="text-[11px] leading-snug"
                style={{ color: 'var(--eco-text-secondary)' }}
              >
                {pillar.body}
              </p>
            </li>
          ))}
        </ul>

        <div
          className="w-full rounded-2xl px-5 py-4 text-sm leading-relaxed"
          style={{
            background: 'var(--eco-surface-elevated)',
            border: '1px solid var(--eco-border-muted)',
            color: 'var(--eco-text)',
            minHeight: '4.5rem',
          }}
          role="status"
          aria-label="Reassurance message"
        >
          <AnimatePresence initial={false}>
            <motion.span
              key={reassurance}
              initial={reducedMotion ? false : { opacity: 0, y: 6 }}
              animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
              transition={{ duration: reducedMotion ? 0 : 0.4 }}
              className="block"
            >
              {reassurance}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>

      {/* The composer, present from first paint. It sits in the live composer's
          box geometry (same width, same shell) so the input reads as "here,
          warming up" rather than missing — and springs to life when the model
          is ready. Download detail stays above; the composer never narrates it. */}
      <div className="mt-8 w-full max-w-2xl px-4">
        <GerminatingComposer ready={phase === 'done'} />
      </div>
    </main>
  );
}


const VALUE_PILLARS: ReadonlyArray<{
  title: string;
  body: string;
  icon: React.ReactNode;
}> = [
  {
    title: 'Private',
    body: 'Your conversations stay on your device.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M10 2a4 4 0 00-4 4v2H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-1V6a4 4 0 00-4-4zm-2 6V6a2 2 0 114 0v2H8z"
          fill="currentColor"
        />
      </svg>
    ),
  },
  {
    title: 'On-device',
    body: 'The model runs on your machine, not a server.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="6" y="6" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
        <rect x="8.75" y="8.75" width="2.5" height="2.5" rx="0.5" fill="currentColor" />
        <path
          d="M8.5 3v3M11.5 3v3M8.5 14v3M11.5 14v3M3 8.5h3M3 11.5h3M14 8.5h3M14 11.5h3"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: 'Waterless',
    body: 'Designed to avoid data-center water waste.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M10 2C10 2 4 8 4 12.5C4 15.5376 6.46243 18 9.5 18C12.5376 18 15 15.5376 15 12.5C15 8 10 2 10 2Z"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
        <path
          d="M6 5l8 8M6 13l8-8"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          opacity="0.55"
        />
      </svg>
    ),
  },
];

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
      ? 'Waking up your AI — this device runs a lighter model, so the first load can take a minute or two'
      : 'Almost there — waking up your AI for the first time. This one-time step can take a minute.';
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
    ? 'Setting up a lighter AI that runs smoothly on this device'
    : 'Getting your private AI ready — this takes a few minutes the first time.';
}
