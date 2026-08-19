// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useSyncExternalStore } from "react";

import { WarningTriangle } from "@eco/ui";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";
import {
  hasReadySlot,
  subscribe as subscribeSlots,
} from "../../local-ai/lifecycle/slots";

/**
 * Read-only local-model readiness for the offline banner.
 *
 * `hasReadySlot()` is a synchronous localStorage read of the slot registry — the
 * same accessor the chat surface already relies on. It NEVER loads a model, runs
 * smoke, or starts heavy work; the banner only observes what setup already
 * settled. SSR assumes online (so the banner renders nothing), and the no-model
 * copy is the stable default until readiness is known on the client.
 */
function subscribeReadiness(callback: () => void): () => void {
  return subscribeSlots(() => {
    callback();
  });
}

function getReadinessSnapshot(): boolean {
  return hasReadySlot();
}

function getReadinessServerSnapshot(): boolean {
  return false;
}

function useLocalModelReady(): boolean {
  return useSyncExternalStore(
    subscribeReadiness,
    getReadinessSnapshot,
    getReadinessServerSnapshot,
  );
}

function LeafIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="mt-0.5 h-4 w-4 shrink-0"
      aria-hidden="true"
    >
      <path d="M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66.95-2.3c.48.17.98.33 1.5.33C19 20 22 3 22 3c-1 2-8 2.25-13 3.25S2 11.5 2 13.5s1.75 3.75 1.75 3.75S6.75 8 17 8Z" />
    </svg>
  );
}


export function OfflineBanner() {
  const isOnline = useNetworkStatus();
  const localModelReady = useLocalModelReady();

  if (isOnline) return null;

  // Two honest states. When a model is ready on this device, offline is the
  // local-first promise landing — not a failure. When no model is ready yet,
  // the one-time setup connection is the honest caveat.
  const lead = localModelReady
    ? "You're offline — and that's okay."
    : "You're offline.";
  const detail = localModelReady
    ? "Your AI runs right here on your device. Web lookups are paused until you're back online."
    : "Eco needs to connect just once to set up your on-device AI. Come back online to get started.";

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 border-b border-[var(--eco-amber-border)] bg-[var(--eco-amber-soft)] px-4 py-2 text-sm text-[var(--eco-amber-text)]"
    >
      {localModelReady ? <LeafIcon /> : <WarningTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <p className="min-w-0">
        <span className="font-medium">{lead}</span>{" "}
        <span className="opacity-80">{detail}</span>
      </p>
    </div>
  );
}
