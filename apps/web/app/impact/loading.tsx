// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export default function Loading() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-screen bg-[var(--eco-surface)]">
        {/* Nav skeleton */}
        <div className="flex items-center justify-between px-6 py-4">
          <div className="skeleton-shimmer h-8 w-24 rounded-lg" />
          <div className="flex gap-4">
            <div className="skeleton-shimmer h-8 w-16 rounded-lg" />
            <div className="skeleton-shimmer h-8 w-16 rounded-lg" />
          </div>
        </div>

        {/* Spacer for fixed nav */}
        <div className="h-20" />

        {/* Hero heading skeleton */}
        <section className="px-6 py-16 text-center">
          <div className="skeleton-shimmer mx-auto h-12 w-64 rounded-lg" />
          <div className="mx-auto mt-6 max-w-2xl space-y-3">
            <div className="skeleton-shimmer mx-auto h-5 w-full rounded-lg" />
            <div className="skeleton-shimmer mx-auto h-5 w-4/5 rounded-lg" />
          </div>
        </section>

        {/* Pillar 1 skeleton */}
        <section className="px-6 py-16">
          <div className="mx-auto max-w-4xl">
            <div className="skeleton-shimmer h-4 w-16 rounded-lg" />
            <div className="skeleton-shimmer mt-3 h-8 w-96 rounded-lg" />
            <div className="mt-8 grid gap-12 md:grid-cols-2">
              <div className="space-y-3">
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
                <div className="skeleton-shimmer h-4 w-3/5 rounded-lg" />
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
              </div>
              <div className="skeleton-shimmer h-40 w-full rounded-2xl" />
            </div>
          </div>
        </section>

        {/* Pillar 2 skeleton */}
        <section className="px-6 py-16" style={{ backgroundColor: "var(--eco-primary-soft)" }}>
          <div className="mx-auto max-w-4xl">
            <div className="skeleton-shimmer h-4 w-16 rounded-lg" />
            <div className="skeleton-shimmer mt-3 h-8 w-80 rounded-lg" />
            <div className="mt-8 grid gap-12 md:grid-cols-2">
              <div className="skeleton-shimmer h-40 w-full rounded-2xl" />
              <div className="space-y-3">
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
                <div className="skeleton-shimmer h-4 w-3/5 rounded-lg" />
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
              </div>
            </div>
          </div>
        </section>

        {/* Pillar 3 skeleton */}
        <section className="px-6 py-16">
          <div className="mx-auto max-w-4xl">
            <div className="skeleton-shimmer h-4 w-32 rounded-lg" />
            <div className="skeleton-shimmer mt-3 h-8 w-72 rounded-lg" />
            <div className="mt-8 grid gap-12 md:grid-cols-2">
              <div className="space-y-3">
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
                <div className="skeleton-shimmer h-4 w-3/5 rounded-lg" />
              </div>
              <div className="space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="skeleton-shimmer h-14 w-full rounded-lg"
                  />
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
