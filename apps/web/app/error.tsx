// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { EmptyState } from "../src/components/ui/EmptyState";
import { PineIllustration } from "../src/components/illustrations/PineIllustration";

export default function RootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="flex flex-col items-center gap-3">
        <EmptyState
          illustration={<PineIllustration />}
          title="Something tripped us up"
          description="We hit an unexpected snag. Try refreshing, or head back to chat."
          action={{ label: "Try again", onClick: reset }}
        />
        <a
          href="/chat"
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--eco-border)] px-5 py-2.5 text-sm font-medium text-[var(--eco-text)]"
        >
          Back to chat
        </a>
      </div>
    </div>
  );
}
