// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  isTourCompleted,
  isFeatureDiscovered,
  markFeatureDiscovered,
} from "../../lib/onboarding";

type DiscoveryDotProps = {
  featureId: string;
  children: ReactNode;
  className?: string;
};

/**
 * Wraps a feature element with an amber pulsing discovery dot.
 *
 * The dot only appears when:
 * 1. The onboarding tour has been completed (or skipped)
 * 2. The specific feature has NOT yet been discovered/interacted with
 *
 * On click or mouseenter, the dot is dismissed and the feature marked
 * as discovered in localStorage.
 */
export function DiscoveryDot({ featureId, children, className }: DiscoveryDotProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isTourCompleted() && !isFeatureDiscovered(featureId)) {
      setVisible(true);
    }
  }, [featureId]);

  const dismiss = useCallback(() => {
    if (!visible) return;
    markFeatureDiscovered(featureId);
    setVisible(false);
  }, [featureId, visible]);

  return (
    <div
      className={`relative ${className ?? ""}`}
      onMouseEnter={dismiss}
      onClick={dismiss}
    >
      {children}
      {visible && (
        <span
          data-discovery-dot
          className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-amber-400"
          style={{ animation: "discovery-pulse 2s ease-in-out infinite" }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
