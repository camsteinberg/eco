// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

type ComparisonFigureProps = {
  left: { value: string; unit: string; label: string }
  right: { value: string; unit: string; label: string }
}

export function ComparisonFigure({ left, right }: ComparisonFigureProps) {
  return (
    <div className="flex min-w-0 items-stretch justify-center gap-0 overflow-hidden">
      {/* Left (data center) side */}
      <div className="min-w-0 flex-1 py-8 pr-4 text-right sm:py-10 sm:pr-10">
        <span
          className="font-serif text-4xl font-semibold tracking-tight sm:text-5xl"
          style={{ color: 'var(--eco-text-secondary)' }}
        >
          {left.value}
        </span>
        <span
          className="ml-1 text-lg"
          style={{ color: 'var(--eco-text-secondary)', opacity: 0.7 }}
        >
          {left.unit}
        </span>
        <p className="mt-2 text-sm text-[var(--eco-text-secondary)]">
          {left.label}
        </p>
      </div>

      {/* Divider */}
      <div
        className="w-px self-stretch"
        style={{ backgroundColor: 'var(--eco-border)' }}
      />

      {/* Right (Eco) side */}
      <div className="min-w-0 flex-1 py-8 pl-4 sm:py-10 sm:pl-10">
        <span
          className="font-serif text-4xl font-semibold tracking-tight sm:text-5xl"
          style={{ color: 'var(--eco-primary)' }}
        >
          {right.value}
        </span>
        <span
          className="ml-1 text-lg"
          style={{ color: 'var(--eco-primary)', opacity: 0.7 }}
        >
          {right.unit}
        </span>
        <p className="mt-2 text-sm text-[var(--eco-text-secondary)]">
          {right.label}
        </p>
      </div>
    </div>
  )
}
