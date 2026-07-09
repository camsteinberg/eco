// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useEffect, useId, useState } from 'react';
import {
  LOCAL_MODEL_ROUTE_PREFERENCE_CHANGE_EVENT,
  readLocalModelRoutePreference,
  resetLocalModelRoutePreference,
  writeLocalModelRoutePreference,
  type LocalModelRoutePreference,
} from '../../local-ai/settings/route-preference';

const ROUTE_PREFERENCE_OPTIONS: Array<{
  value: LocalModelRoutePreference;
  label: string;
  description: string;
}> = [
  {
    value: 'fastest',
    label: 'Quick replies',
    description: 'Favor quick first replies and lower latency.',
  },
  {
    value: 'balanced',
    label: 'Balanced local',
    description: 'Blend speed, quality, and local safety.',
  },
  {
    value: 'quality',
    label: 'Stronger answers',
    description: 'Prefer the strongest proven local model choice.',
  },
  {
    value: 'battery',
    label: 'Low power',
    description: 'Favor lighter models while power is limited.',
  },
  {
    value: 'storage-saver',
    label: 'Smaller downloads',
    description: 'Prefer smaller downloads and lower storage pressure.',
  },
];

type RoutePreferenceControlsProps = {
  compact?: boolean;
  className?: string;
};

export function RoutePreferenceControls({
  compact = false,
  className = '',
}: RoutePreferenceControlsProps) {
  const groupId = useId();
  const descriptionId = `${groupId}-description`;
  const [preference, setPreference] = useState<LocalModelRoutePreference>('balanced');

  useEffect(() => {
    setPreference(readLocalModelRoutePreference());

    const refreshPreference = () => {
      setPreference(readLocalModelRoutePreference());
    };

    window.addEventListener(LOCAL_MODEL_ROUTE_PREFERENCE_CHANGE_EVENT, refreshPreference);
    window.addEventListener('storage', refreshPreference);
    return () => {
      window.removeEventListener(LOCAL_MODEL_ROUTE_PREFERENCE_CHANGE_EVENT, refreshPreference);
      window.removeEventListener('storage', refreshPreference);
    };
  }, []);

  const selectedOption = ROUTE_PREFERENCE_OPTIONS.find((option) => option.value === preference)
    ?? ROUTE_PREFERENCE_OPTIONS[1]!;

  return (
    <section
      role="group"
      className={`rounded-lg border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-4 ${className}`}
      aria-labelledby={`${groupId}-label`}
      aria-describedby={descriptionId}
    >
      <div className={compact ? 'space-y-1' : 'flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'}>
        <div>
          <p
            id={`${groupId}-label`}
            className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--eco-primary)]"
          >
            Local performance preference
          </p>
          <p id={descriptionId} className="mt-1 text-xs leading-5 text-[var(--eco-text-secondary)]">
            Changes recommendations and model choice only. It never starts downloads, readiness checks, local workers, inference, or prompt egress.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPreference(resetLocalModelRoutePreference())}
          className="inline-flex min-h-9 items-center justify-center rounded-lg border border-[var(--eco-border)] px-3 text-xs font-medium text-[var(--eco-text-secondary)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
        >
          Reset to balanced
        </button>
      </div>

      <fieldset className="mt-3">
        <legend className="sr-only">Local performance preference</legend>
        <div className={compact ? 'grid gap-2' : 'grid gap-2 sm:grid-cols-5'}>
          {ROUTE_PREFERENCE_OPTIONS.map((option) => {
            const inputId = `${groupId}-${option.value}`;
            const checked = preference === option.value;
            return (
              <label
                key={option.value}
                htmlFor={inputId}
                className={`flex cursor-pointer flex-col rounded-xl border p-3 text-left transition-colors ${
                  checked
                    ? 'border-[var(--eco-primary)] bg-[var(--eco-primary-soft)] text-[var(--eco-primary)]'
                    : 'border-[var(--eco-border)] bg-[var(--eco-surface)] text-[var(--eco-text)] hover:border-[var(--eco-primary)]/60'
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <input
                    id={inputId}
                    type="radio"
                    name={`${groupId}-route-preference`}
                    value={option.value}
                    checked={checked}
                    onChange={() => setPreference(writeLocalModelRoutePreference(option.value))}
                    className="h-4 w-4 accent-[var(--eco-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
                    aria-label={option.label}
                    aria-describedby={`${inputId}-description`}
                  />
                  {option.label}
                </span>
                <span
                  id={`${inputId}-description`}
                  className={`mt-1 text-[11px] leading-4 ${
                    checked ? 'text-[var(--eco-primary)]' : 'text-[var(--eco-text-secondary)]'
                  }`}
                >
                  {option.description}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <p className="mt-3 text-xs leading-5 text-[var(--eco-text-secondary)]" aria-live="polite">
        Current local preference: <span className="font-medium text-[var(--eco-text)]">{selectedOption.label}</span>.
      </p>
    </section>
  );
}
