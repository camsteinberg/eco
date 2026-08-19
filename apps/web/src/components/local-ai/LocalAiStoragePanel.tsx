// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Button, LeafDivider, LeafIllustration } from '@eco/ui';
import type { StorageBreakdown, StorageModelEntry } from '../../hooks/local-ai/useLocalAiStorageBreakdown';

/**
 * Storage panel — token-themed per-model storage breakdown for the
 * Settings → Eco tab (v7.1).
 *
 * Renders:
 *   1. A "soil bar" with Eco's share of browser storage in forest green and
 *      other browser data behind it in muted cream. Springs in from 0.
 *   2. A row of per-model cards (friendlyName · vendor · size · Remove).
 *      Empty state shows a leaf illustration and a friendly nudge.
 *
 * Pure presentational — caller fetches the breakdown via
 * `useLocalAiStorageBreakdown` and passes it in.
 *
 * The panel carries NO heading of its own: its only mount is inside the
 * Settings → Eco tab's "Storage on this device" section, and a second heading
 * of the same name printed the title twice, one under the other. The section
 * owns the title; this component owns the contents. `aria-label` keeps the
 * region named for assistive tech.
 */

export type LocalAiStoragePanelProps = {
  status: 'loading' | 'ready';
  breakdown: StorageBreakdown | null;
  onClearModel(modelId: string): Promise<void> | void;
};

export function LocalAiStoragePanel({ status, breakdown, onClearModel }: LocalAiStoragePanelProps) {
  const reduceMotion = useReducedMotion();

  return (
    <section
      className="rounded-2xl p-5"
      style={{
        background: 'var(--eco-surface)',
        border: '1px solid var(--eco-border-muted)',
        fontFamily: 'var(--eco-font-body)',
      }}
      aria-label="Local AI storage"
      data-testid="local-ai-storage-panel"
    >
      {status === 'loading' && !breakdown ? (
        <SoilBarSkeleton reduceMotion={reduceMotion} />
      ) : (
        <SoilBar breakdown={breakdown!} reduceMotion={reduceMotion} />
      )}

      {breakdown && breakdown.models.length > 0 && (
        <>
          <div className="my-5" aria-hidden>
            <LeafDivider />
          </div>
          <ul className="flex flex-col gap-2" aria-label="Cached models">
            {breakdown.models.map((model, index) => (
              <ModelCard
                key={model.id}
                model={model}
                onClear={onClearModel}
                reduceMotion={reduceMotion}
                stagger={index}
              />
            ))}
          </ul>
        </>
      )}

      {breakdown && breakdown.models.length === 0 && status === 'ready' && (
        breakdown.measured ? (
          <EmptyStorageState reduceMotion={reduceMotion} />
        ) : (
          <UnmeasuredStorageState reduceMotion={reduceMotion} />
        )
      )}
    </section>
  );
}

// ─── Soil bar ───────────────────────────────────────────────────────────────

function SoilBar({
  breakdown,
  reduceMotion,
}: {
  breakdown: StorageBreakdown;
  reduceMotion: boolean | null;
}) {
  const { ecoTotalBytes, browserUsage, browserQuota } = breakdown;

  // Scale the bar against quota when we have it; otherwise scale against
  // whichever is larger of (ecoTotalBytes, browserUsage) so the eco fill
  // remains visible even without a quota estimate.
  const denominator = browserQuota
    ?? Math.max(ecoTotalBytes, browserUsage ?? 0, 1);
  const ecoPercent = clampPercent((ecoTotalBytes / denominator) * 100);
  const otherUsage = browserUsage != null
    ? Math.max(0, browserUsage - ecoTotalBytes)
    : 0;
  const otherPercent = clampPercent((otherUsage / denominator) * 100);
  const availableBytes = browserQuota != null
    ? Math.max(0, browserQuota - (browserUsage ?? ecoTotalBytes))
    : null;

  return (
    <div>
      <div
        className="relative h-3 w-full rounded-full overflow-hidden"
        style={{ background: 'var(--eco-surface-elevated)' }}
        role="img"
        aria-label={ariaForBar(ecoTotalBytes, browserUsage, browserQuota)}
      >
        {/* Other browser data — muted layer behind */}
        <motion.div
          className="absolute top-0 h-full"
          style={{
            left: `${ecoPercent}%`,
            background: 'var(--eco-border-muted)',
            opacity: 0.6,
          }}
          initial={reduceMotion ? false : { width: 0 }}
          animate={{ width: `${otherPercent}%` }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: 'spring', stiffness: 180, damping: 24, delay: 0.05 }
          }
        />
        {/* Eco share — forest green, foregrounded */}
        <motion.div
          className="absolute top-0 left-0 h-full"
          style={{ background: 'var(--eco-primary)' }}
          initial={reduceMotion ? false : { width: 0 }}
          animate={{ width: `${ecoPercent}%` }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: 'spring', stiffness: 200, damping: 22 }
          }
        />
      </div>

      <div
        className="mt-2 flex items-baseline justify-between gap-3 text-sm"
        style={{ color: 'var(--eco-text-secondary)' }}
      >
        <span>
          <span style={{ color: 'var(--eco-text)' }}>
            {ecoTotalBytes > 0 ? formatBytes(ecoTotalBytes) : 'Nothing cached'}
          </span>
          <span aria-hidden> · </span>
          <span>on Eco</span>
        </span>
        <span>
          {availableBytes != null
            ? `${formatBytes(availableBytes)} available`
            : browserUsage != null
              ? `${formatBytes(browserUsage)} used overall`
              : null}
        </span>
      </div>
    </div>
  );
}

function SoilBarSkeleton({ reduceMotion }: { reduceMotion: boolean | null }) {
  return (
    <div>
      <div
        className="h-3 w-full rounded-full"
        style={{ background: 'var(--eco-surface-elevated)' }}
        aria-hidden
      >
        {!reduceMotion && (
          <motion.div
            className="h-full rounded-full"
            style={{ background: 'var(--eco-border-muted)', opacity: 0.5, width: '40%' }}
            animate={{ x: ['-100%', '250%'] }}
            transition={{ repeat: Infinity, duration: 1.6, ease: 'linear' }}
          />
        )}
      </div>
      <p className="mt-2 text-sm" style={{ color: 'var(--eco-text-muted)' }}>
        Measuring storage…
      </p>
    </div>
  );
}

// ─── Model card ─────────────────────────────────────────────────────────────

function ModelCard({
  model,
  onClear,
  reduceMotion,
  stagger,
}: {
  model: StorageModelEntry;
  onClear(modelId: string): Promise<void> | void;
  reduceMotion: boolean | null;
  stagger: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleConfirm = async () => {
    setClearing(true);
    try {
      await onClear(model.id);
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  };

  return (
    <motion.li
      className="rounded-xl p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      style={{
        background: 'var(--eco-surface-elevated)',
        border: '1px solid var(--eco-border-muted)',
      }}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: 'spring', stiffness: 220, damping: 24, delay: stagger * 0.04 }
      }
      whileHover={
        reduceMotion ? undefined : { y: -1, transition: { duration: 0.18 } }
      }
      data-testid={`storage-model-card-${model.id}`}
    >
      <div className="min-w-0">
        <p
          className="text-sm font-medium truncate"
          style={{ color: 'var(--eco-text)' }}
        >
          {model.friendlyName}
        </p>
        <p
          className="text-xs mt-0.5"
          style={{ color: 'var(--eco-text-secondary)' }}
        >
          Made by {model.vendor} · {formatBytes(model.sizeBytes)} on this device
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-sm underline"
            style={{ color: 'var(--eco-text-secondary)' }}
            aria-label={`Remove ${model.friendlyName} from this device`}
          >
            Remove
          </button>
        ) : (
          <>
            <Button
              onClick={handleConfirm}
              variant="primary"
              disabled={clearing}
              aria-label={`Confirm removing ${model.friendlyName}`}
            >
              {clearing ? 'Removing…' : 'Yes, remove'}
            </Button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-sm underline"
              style={{ color: 'var(--eco-text-secondary)' }}
              disabled={clearing}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </motion.li>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyStorageState({ reduceMotion }: { reduceMotion: boolean | null }) {
  return (
    <motion.div
      className="mt-5 flex flex-col items-center text-center gap-3 py-4"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.4 }}
    >
      <div style={{ width: 56, color: 'var(--eco-primary)' }} aria-hidden>
        <LeafIllustration />
      </div>
      <p style={{ color: 'var(--eco-text)' }} className="text-sm font-medium">
        Nothing cached on this device yet
      </p>
      <p style={{ color: 'var(--eco-text-secondary)' }} className="text-xs max-w-xs">
        Models you download for Eco will appear here so you can see exactly
        what&apos;s stored — and prune anything you no longer use.
      </p>
    </motion.div>
  );
}

/**
 * "Nothing cached" is a confident claim. When the Cache API could not even be
 * asked, say we could not check — cached models may well be on disk.
 */
function UnmeasuredStorageState({ reduceMotion }: { reduceMotion: boolean | null }) {
  return (
    <motion.div
      className="mt-5 flex flex-col items-center text-center gap-3 py-4"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.4 }}
    >
      <div style={{ width: 56, color: 'var(--eco-text-secondary)' }} aria-hidden>
        <LeafIllustration />
      </div>
      <p style={{ color: 'var(--eco-text)' }} className="text-sm font-medium">
        Eco couldn&apos;t check storage on this device
      </p>
      <p style={{ color: 'var(--eco-text-secondary)' }} className="text-xs max-w-xs">
        This browser didn&apos;t let Eco read its model cache just now, so
        nothing is listed — downloaded models may still be here. Reload to
        try again.
      </p>
    </motion.div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function ariaForBar(
  ecoBytes: number,
  browserUsage: number | null,
  browserQuota: number | null,
): string {
  const parts: string[] = [];
  parts.push(`Eco models use ${formatBytes(ecoBytes)}`);
  if (browserUsage != null) parts.push(`browser total ${formatBytes(browserUsage)}`);
  if (browserQuota != null) parts.push(`out of ${formatBytes(browserQuota)} available`);
  return parts.join(', ');
}
