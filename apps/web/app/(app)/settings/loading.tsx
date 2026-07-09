// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export default function Loading() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        {/* Header skeleton */}
        <div className="skeleton-shimmer h-8 w-32 rounded-lg" />

        {/* Tab bar skeleton */}
        <div className="mt-6 flex gap-2 border-b border-[var(--eco-border)] pb-2">
          <div className="skeleton-shimmer h-8 w-20 rounded-full" />
          <div className="skeleton-shimmer h-8 w-20 rounded-full" />
          <div className="skeleton-shimmer h-8 w-24 rounded-full" />
          <div className="skeleton-shimmer h-8 w-16 rounded-full" />
        </div>

        {/* Form content skeleton */}
        <div className="mt-8 space-y-6">
          {/* Field 1 */}
          <div className="space-y-2">
            <div className="skeleton-shimmer h-4 w-24 rounded" />
            <div className="skeleton-shimmer h-10 w-full rounded-lg" />
          </div>

          {/* Field 2 */}
          <div className="space-y-2">
            <div className="skeleton-shimmer h-4 w-32 rounded" />
            <div className="skeleton-shimmer h-10 w-full rounded-lg" />
          </div>

          {/* Toggle */}
          <div className="flex items-center justify-between">
            <div className="skeleton-shimmer h-4 w-40 rounded" />
            <div className="skeleton-shimmer h-6 w-11 rounded-full" />
          </div>

          {/* Button */}
          <div className="skeleton-shimmer h-10 w-28 rounded-full" />
        </div>
      </div>
    </div>
  );
}
