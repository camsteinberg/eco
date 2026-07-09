// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { EmptyState } from "../../../src/components/ui/EmptyState";
import { FernIllustration } from "../../../src/components/illustrations/FernIllustration";

export default function SettingsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-4">
      <EmptyState
        illustration={<FernIllustration />}
        title="Settings hit a snag"
        description="Something went wrong loading settings. Your conversations are safe."
        action={{ label: "Try again", onClick: reset }}
      />
    </div>
  );
}
