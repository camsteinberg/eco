// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { type ReactNode, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/**
 * A simple progressive-disclosure widget. Used in Settings → Eco for the
 * "Show details" → "Technical details" two-level reveal (vision §1.4).
 *
 * Accessible: button has aria-expanded, content has matching id, role=region.
 */

export type DetailsDisclosureProps = {
  label: string;
  expandedLabel?: string;
  /** Default open state. */
  defaultOpen?: boolean;
  /** Render-prop for the disclosed content. */
  children: ReactNode;
};

let nextId = 0;
function generateId(): string {
  nextId += 1;
  return `eco-disclosure-${nextId}`;
}

export function DetailsDisclosure({
  label,
  expandedLabel,
  defaultOpen = false,
  children,
}: DetailsDisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [id] = useState(generateId);
  const reducedMotion = useReducedMotion();

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        aria-controls={id}
        className="text-sm underline"
        style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}
      >
        {open ? (expandedLabel ?? `${label} ›`) : `${label} ›`}
      </button>
      {open && (
        <motion.div
          id={id}
          role="region"
          aria-label={label}
          initial={reducedMotion ? false : { opacity: 0, y: -4 }}
          animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.2 }}
          className="mt-3"
        >
          {children}
        </motion.div>
      )}
    </div>
  );
}
