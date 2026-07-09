// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useSettingsStore } from "../../stores/settingsStore";

type TokenRateProps = {
  tokenCount: number;
  streamStartTime: number | null;
  isStreaming: boolean;
};

export function TokenRate({
  tokenCount,
  streamStartTime,
  isStreaming,
}: TokenRateProps) {
  const showTechnicalDetails = useSettingsStore((s) => s.showTechnicalDetails);

  // Technical surface — hidden unless the user opts into technical details.
  if (!showTechnicalDetails) {
    return null;
  }

  if (tokenCount === 0 || streamStartTime === null) {
    return null;
  }

  const elapsed = (Date.now() - streamStartTime) / 1000;
  const rate = elapsed > 0 ? tokenCount / elapsed : 0;

  if (!isStreaming && rate === 0) return null;

  return (
    <p className="text-xs text-[var(--eco-text-secondary)]">
      {isStreaming ? `${rate.toFixed(1)} tok/s` : `${tokenCount} tokens`}
    </p>
  );
}
