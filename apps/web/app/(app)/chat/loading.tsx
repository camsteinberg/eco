// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export default function Loading() {
  return (
    <div className="flex h-full flex-col bg-[var(--eco-surface-chat)]">
      {/* Message area */}
      <div className="flex-1 px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* User message 1 */}
          <div className="flex justify-end">
            <div className="skeleton-shimmer h-10 w-48 rounded-2xl" />
          </div>

          {/* Assistant message 1 */}
          <div className="flex items-start gap-3">
            <div className="skeleton-shimmer h-8 w-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="skeleton-shimmer h-4 w-full rounded-lg" />
              <div className="skeleton-shimmer h-4 w-4/5 rounded-lg" />
              <div className="skeleton-shimmer h-4 w-3/5 rounded-lg" />
            </div>
          </div>

          {/* User message 2 */}
          <div className="flex justify-end">
            <div className="skeleton-shimmer h-10 w-36 rounded-2xl" />
          </div>

          {/* Assistant message 2 */}
          <div className="flex items-start gap-3">
            <div className="skeleton-shimmer h-8 w-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="skeleton-shimmer h-4 w-full rounded-lg" />
              <div className="skeleton-shimmer h-4 w-3/4 rounded-lg" />
            </div>
          </div>
        </div>
      </div>

      {/* Input skeleton */}
      <div className="border-t border-[var(--eco-border)]/40 px-4 py-5">
        <div className="mx-auto max-w-2xl">
          <div className="skeleton-shimmer h-12 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
