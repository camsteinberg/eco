// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * The Settings-tab toggle switch.
 *
 * The single source for the on/off switch rendered inside `SettingsRow` across the
 * Settings tabs (Appearance, AI). It pairs with `SettingsRow`, which owns the
 * label + description, so this control carries only the track + thumb and an
 * `ariaLabel`. Design tokens only; spring-free CSS transitions degrade to
 * instant under `prefers-reduced-motion` via `motion-reduce:`.
 */
export function SettingsSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className="group inline-flex min-h-11 items-center justify-center p-2 -m-2 cursor-pointer transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--eco-surface)] rounded-md"
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors motion-reduce:transition-none ${
          checked ? "bg-[var(--eco-primary)]" : "bg-[var(--eco-border)]"
        }`}
      >
        <span
          className={`pointer-events-none absolute inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${
            checked ? "translate-x-[18px]" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}
