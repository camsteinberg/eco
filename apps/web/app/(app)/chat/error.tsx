// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import Link from "next/link";
import { EmptyState } from "../../../src/components/ui/EmptyState";
import { LeafIllustration } from "../../../src/components/illustrations/LeafIllustration";

export default function ChatError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="flex flex-col items-center">
        <EmptyState
          illustration={<LeafIllustration />}
          title="The conversation got lost"
          description="Something went wrong with this chat. Try again or start fresh."
          action={{ label: "Try again", onClick: reset }}
        />
        <Link
          href="/chat"
          className="mt-2 rounded-lg border border-[var(--eco-border)] px-4 py-2 text-sm font-medium text-[var(--eco-text)] transition-colors hover:bg-[var(--eco-surface-elevated)]"
        >
          Return to chat
        </Link>
      </div>
    </div>
  );
}
