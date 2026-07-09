// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export default function Loading() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-screen bg-[var(--eco-surface)]">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
          {/* Header skeleton */}
          <div className="mb-12 flex flex-col items-center gap-6">
            <div className="skeleton-shimmer h-10 w-10 rounded-full" />
            <div className="skeleton-shimmer h-12 w-64 rounded-lg" />
            <div className="skeleton-shimmer h-5 w-80 rounded-lg" />
          </div>

          {/* Content sections skeleton */}
          <div className="space-y-10">
            {/* Section 1 */}
            <div>
              <div className="skeleton-shimmer mb-3 h-6 w-44 rounded-lg" />
              <div className="space-y-2">
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
              </div>
            </div>

            {/* Section 2 */}
            <div>
              <div className="skeleton-shimmer mb-3 h-6 w-40 rounded-lg" />
              <div className="skeleton-shimmer mb-3 h-4 w-full rounded-lg" />
              <div className="space-y-2 pl-6">
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-3/5 rounded-lg" />
              </div>
              <div className="skeleton-shimmer mt-4 h-20 w-full rounded-xl" />
            </div>

            {/* Section 3 */}
            <div>
              <div className="skeleton-shimmer mb-3 h-6 w-48 rounded-lg" />
              <div className="skeleton-shimmer mb-3 h-4 w-full rounded-lg" />
              <div className="space-y-2 pl-6">
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
              </div>
            </div>

            {/* Section 4 */}
            <div>
              <div className="skeleton-shimmer mb-3 h-6 w-32 rounded-lg" />
              <div className="space-y-2">
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-3/5 rounded-lg" />
              </div>
            </div>

            {/* Section 5 - Network Metrics placeholder */}
            <div>
              <div className="skeleton-shimmer mb-3 h-6 w-40 rounded-lg" />
              <div className="skeleton-shimmer h-48 w-full rounded-xl" />
            </div>

            {/* Section 6 */}
            <div>
              <div className="skeleton-shimmer mb-3 h-6 w-52 rounded-lg" />
              <div className="space-y-2">
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-full rounded-lg" />
                <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
              </div>
            </div>
          </div>

          {/* Footer links skeleton */}
          <div className="mt-16 flex flex-col items-center gap-4 border-t border-[var(--eco-border)] pt-8">
            <div className="flex gap-6">
              <div className="skeleton-shimmer h-4 w-28 rounded-lg" />
              <div className="skeleton-shimmer h-4 w-24 rounded-lg" />
              <div className="skeleton-shimmer h-4 w-12 rounded-lg" />
            </div>
            <div className="skeleton-shimmer h-4 w-44 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
