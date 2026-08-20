// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/**
 * First-run welcome + model choice — the v1.0 front door.
 *
 * Shown ONCE, centered in front of the app, before any model downloads. It
 * introduces Eco, tells the on-device / waterless story with a real visual, and
 * lets the person pick their model from honest, plain-language tradeoffs. On
 * choose, the parent binds + downloads that model and swaps to the download-wait
 * surface (WelcomeSetup).
 *
 * Pure presentational shell: the device-appropriate options and which one is
 * recommended are computed by the caller (recommendation adapts by device —
 * Deeper on capable desktops, Fast on mobile / limited hardware). One to two
 * options; a single-option device shows no false choice.
 */

export type WelcomeModelChoice = {
  /** Catalog model id to bind on choose. */
  id: string;
  /** Product tier name, e.g. "Eco Fast" / "Eco Deeper". */
  name: string;
  /** Human download size, e.g. "~0.8 GB". */
  sizeLabel: string;
  /** One plain sentence a casual user understands. */
  tagline: string;
  /** 1–4: relative snappiness of replies (filled dots). */
  speed: number;
  /** 1–4: relative depth / thoroughness (filled dots). */
  depth: number;
};

export type WelcomeCardProps = {
  /** Device-appropriate options (1–2), best-first. */
  choices: readonly WelcomeModelChoice[];
  /** Which choice carries the "Recommended" badge and is preselected. */
  recommendedId: string;
  /** Called with the chosen model id when the user commits. */
  onChoose: (id: string) => void;
  /** Href for the "See how" impact link. */
  impactHref?: string;
};

export function WelcomeCard({
  choices,
  recommendedId,
  onChoose,
  impactHref = '/impact',
}: WelcomeCardProps) {
  const reduced = useReducedMotion();
  const [selectedId, setSelectedId] = useState(
    () => (choices.some((c) => c.id === recommendedId) ? recommendedId : choices[0]?.id) ?? '',
  );
  const selected = choices.find((c) => c.id === selectedId) ?? choices[0];
  const single = choices.length === 1;

  return (
    <div
      data-eco-welcome-card
      className="fixed inset-0 z-50 flex items-center-safe justify-center overflow-y-auto px-4 py-4 sm:py-8"
      style={{ background: 'color-mix(in srgb, var(--eco-surface) 88%, transparent)', backdropFilter: 'blur(6px)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Eco — choose your model"
    >
      <motion.div
        className="grain-subtle relative w-full max-w-xl rounded-3xl px-7 py-5 sm:px-10 sm:py-6"
        style={{
          background: 'var(--eco-surface-elevated)',
          border: '1px solid var(--eco-border)',
          boxShadow: 'var(--eco-shadow-lg, 0 24px 60px rgba(0,0,0,0.18))',
          fontFamily: 'var(--eco-font-body)',
          color: 'var(--eco-text)',
        }}
        initial={reduced ? false : { opacity: 0, y: 14, scale: 0.985 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 210, damping: 26 }}
      >
        {/* Header */}
        <div className="flex flex-col items-center text-center">
          <LeafMark />
          <h1
            className="mt-2 text-3xl tracking-tight sm:text-4xl"
            style={{ fontFamily: 'var(--eco-font-display)', color: 'var(--eco-text)' }}
          >
            Welcome to Eco
          </h1>
          <p className="mt-1.5 text-base" style={{ color: 'var(--eco-text-secondary)' }}>
            The AI runs on your device, not in a data center.
          </p>
        </div>

        {/* Mission + water story. The subtitle above already says the model runs
            here, and the comparison caption below already says on-device answers
            use no cooling water — this line carries only the part neither does:
            why data centers spend water at all. */}
        <p
          className="mx-auto mt-2.5 max-w-lg text-center text-sm leading-normal sm:mt-3"
          style={{ color: 'var(--eco-text-secondary)' }}
        >
          Data centers answer your messages on their servers, and cool those servers with water.
        </p>

        {/* The signature: water comparison visual */}
        <div className="mt-3 sm:mt-4">
          <WaterComparison />
          <div className="mt-1.5 text-center">
            <a
              href={impactHref}
              className="text-xs font-medium underline decoration-[var(--eco-primary)]/40 underline-offset-2 transition-opacity hover:opacity-70"
              style={{ color: 'var(--eco-primary)' }}
            >
              See the numbers →
            </a>
          </div>
        </div>

        {/* Model choice */}
        <div className="mt-4 sm:mt-5">
          <div className="text-center">
            <p className="text-base font-semibold" style={{ color: 'var(--eco-text)' }}>
              {single ? 'Your model' : 'Pick the model that fits your device'}
            </p>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--eco-text-muted)' }}>
              {single ? 'Chosen for your device.' : 'You can change this anytime in Settings.'}
            </p>
          </div>

          <div
            className={`mt-3 grid gap-3 ${single ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}
            role={single ? undefined : 'radiogroup'}
            aria-label="Choose your model"
          >
            {choices.map((choice) => (
              <ModelChoiceTile
                key={choice.id}
                choice={choice}
                selected={choice.id === selectedId}
                recommended={choice.id === recommendedId && !single}
                selectable={!single}
                onSelect={() => setSelectedId(choice.id)}
              />
            ))}
          </div>
        </div>

        {/* CTA */}
        <button
          type="button"
          onClick={() => selected && onChoose(selected.id)}
          className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-base font-semibold transition-transform active:scale-[0.99] sm:mt-4"
          style={{ background: 'var(--eco-primary)', color: 'var(--eco-on-primary)' }}
        >
          {single ? `Start with ${selected?.name ?? 'Eco'}` : `Start with ${selected?.name ?? ''}`}
          <span aria-hidden="true">→</span>
        </button>
      </motion.div>
    </div>
  );
}

/** A selectable model tile. */
function ModelChoiceTile({
  choice,
  selected,
  recommended,
  selectable,
  onSelect,
}: {
  choice: WelcomeModelChoice;
  selected: boolean;
  recommended: boolean;
  selectable: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      role={selectable ? 'radio' : undefined}
      aria-checked={selectable ? selected : undefined}
      className="flex flex-col rounded-2xl px-4 py-3.5 text-left transition-colors"
      style={{
        background: selected ? 'var(--eco-primary-soft)' : 'var(--eco-surface)',
        border: `1.5px solid ${selected ? 'var(--eco-primary)' : 'var(--eco-border)'}`,
        cursor: selectable ? 'pointer' : 'default',
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-base font-semibold" style={{ color: 'var(--eco-text)' }}>
          {choice.name}
        </span>
        <span className="text-xs tabular-nums" style={{ color: 'var(--eco-text-muted)' }}>
          {choice.sizeLabel}
        </span>
      </div>
      {/* In-flow like every other "Recommended" tag in the product, so the tile's
          border stays unbroken. Neutral, not primary: the primary hue belongs to
          the selected tile alone, and the two must not read as rival approvals
          when the person picks the other model. */}
      {recommended && (
        <span
          className="mt-1.5 inline-flex w-fit items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{
            background: 'color-mix(in srgb, var(--eco-text-muted) 14%, transparent)',
            color: 'var(--eco-text-secondary)',
          }}
        >
          Recommended
        </span>
      )}
      <p className="mt-1.5 text-[13px] leading-snug" style={{ color: 'var(--eco-text-secondary)' }}>
        {choice.tagline}
      </p>
      <div className="mt-3 flex flex-col gap-1">
        <Meter label="Speed" value={choice.speed} />
        <Meter label="Depth" value={choice.depth} />
      </div>
    </button>
  );
}

/** A tiny 4-dot meter with a label — casual, glanceable. */
function Meter({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(4, value));
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-[11px]" style={{ color: 'var(--eco-text-muted)' }}>
        {label}
      </span>
      <span className="flex gap-1" aria-label={`${label}: ${String(v)} of 4`}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: i < v ? 'var(--eco-primary)' : 'color-mix(in srgb, var(--eco-primary) 18%, transparent)' }}
          />
        ))}
      </span>
    </div>
  );
}

/** Small botanical wordmark leaf. */
function LeafMark() {
  return (
    <span
      className="flex h-10 w-10 items-center justify-center rounded-2xl"
      style={{ background: 'var(--eco-primary-soft)' }}
      aria-hidden="true"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 3C12 3 5 8 5 14a7 7 0 0014 0c0-6-7-11-7-11Z"
          fill="var(--eco-primary)"
          opacity="0.16"
        />
        <path
          d="M12 3C12 3 5 8 5 14a7 7 0 0014 0c0-6-7-11-7-11Z"
          stroke="var(--eco-primary)"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M12 20V9M12 13l-3-2M12 15l3-2" stroke="var(--eco-primary)" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/**
 * The waterless story, drawn: a cloud data center that spends ~250 mL of cooling
 * water per query vs. the same query answered on your device (0 mL). Echoes the
 * /impact comparison but as one warm, glanceable diagram for non-technical users.
 * Figures match impact-calc.ts / the /impact page (UC Riverside, ~0.25 L/query).
 */
function WaterComparison() {
  return (
    <div
      className="mx-auto w-full max-w-md rounded-2xl px-4 py-3"
      style={{ background: 'var(--eco-surface)', border: '1px solid var(--eco-border-muted)' }}
    >
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        {/* Cloud AI side */}
        <figure className="flex flex-col items-center gap-2 text-center">
          <svg width="72" height="56" viewBox="0 0 72 56" fill="none" aria-hidden="true">
            {/* falling water drops */}
            <path d="M20 8c0 2-2 3-2 5a2 2 0 004 0c0-2-2-3-2-5Z" fill="var(--eco-sky)" />
            <path d="M36 4c0 2-2 3-2 5a2 2 0 004 0c0-2-2-3-2-5Z" fill="var(--eco-sky)" />
            <path d="M52 8c0 2-2 3-2 5a2 2 0 004 0c0-2-2-3-2-5Z" fill="var(--eco-sky)" />
            {/* server rack */}
            <rect x="16" y="20" width="40" height="30" rx="3" stroke="var(--eco-text-muted)" strokeWidth="1.5" />
            <line x1="16" y1="30" x2="56" y2="30" stroke="var(--eco-text-muted)" strokeWidth="1.2" />
            <line x1="16" y1="40" x2="56" y2="40" stroke="var(--eco-text-muted)" strokeWidth="1.2" />
            <circle cx="21" cy="25" r="1.4" fill="var(--eco-text-muted)" />
            <circle cx="21" cy="35" r="1.4" fill="var(--eco-text-muted)" />
            <circle cx="21" cy="45" r="1.4" fill="var(--eco-text-muted)" />
          </svg>
          <figcaption>
            <p className="text-xs font-medium" style={{ color: 'var(--eco-text-secondary)' }}>Cloud AI</p>
            <p className="text-sm font-semibold tabular-nums" style={{ color: 'var(--eco-sky)' }}>~250 mL</p>
          </figcaption>
        </figure>

        <span className="text-lg" style={{ color: 'var(--eco-text-muted)' }} aria-hidden="true">→</span>

        {/* Eco / device side */}
        <figure className="flex flex-col items-center gap-2 text-center">
          <svg width="72" height="56" viewBox="0 0 72 56" fill="none" aria-hidden="true">
            {/* laptop */}
            <rect x="18" y="16" width="36" height="24" rx="2.5" stroke="var(--eco-text-muted)" strokeWidth="1.5" />
            <path d="M12 46h48l-4-6H16l-4 6Z" stroke="var(--eco-text-muted)" strokeWidth="1.5" strokeLinejoin="round" />
            {/* sprout on screen */}
            <path d="M36 36V26" stroke="var(--eco-primary)" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M36 29c-3 0-5-2-5-4 3 0 5 2 5 4Z" fill="var(--eco-primary)" opacity="0.85" />
            <path d="M36 27c3 0 5-2 5-4-3 0-5 2-5 4Z" fill="var(--eco-primary)" />
          </svg>
          <figcaption>
            <p className="text-xs font-medium" style={{ color: 'var(--eco-text-secondary)' }}>Eco, on your device</p>
            <p className="text-sm font-semibold tabular-nums" style={{ color: 'var(--eco-primary)' }}>0 mL</p>
          </figcaption>
        </figure>
      </div>
      <p className="mt-2 text-center text-[11px]" style={{ color: 'var(--eco-text-muted)' }}>
        Data-center cooling water per query. On-device answers use none.
      </p>
    </div>
  );
}
