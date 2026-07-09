// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import Link from "next/link";
import { EmptyState } from "../src/components/ui/EmptyState";
import { FernIllustration } from "../src/components/illustrations/FernIllustration";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="flex flex-col items-center gap-4">
        <EmptyState
          illustration={<FernIllustration />}
          title="Looks like you wandered off the trail"
          description="This page doesn't exist, but browser chat and the trust pages are still nearby."
          action={{ label: "Back to chat", href: "/chat" }}
        />
        <p className="flex justify-center gap-3 text-xs">
          <Link href="/privacy" className="text-[var(--eco-text-secondary)] hover:underline">
            Privacy
          </Link>
          <Link href="/transparency" className="text-[var(--eco-text-secondary)] hover:underline">
            Transparency
          </Link>
        </p>
      </div>
    </div>
  );
}
