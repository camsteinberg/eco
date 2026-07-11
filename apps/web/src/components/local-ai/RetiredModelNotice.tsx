// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect, useRef } from "react";
import { useToast } from "../ui/Toast";

/**
 * Retired-model notice — fires a one-time toast when the boot self-heal
 * migration retired the model the user was actually running.
 *
 * The migration (local-ai/lifecycle/self-heal.ts) writes a hint to
 * localStorage under `eco-local-ai-retired-notice-v1` ONLY when the user was on
 * the retired model. This component reads and removes that hint on mount, then
 * fires an honest toast. It renders nothing — it's a side-effect-only mount
 * placed inside the app ToastProvider.
 *
 * The read-then-remove is idempotent: React's dev-mode double-mount (or a
 * re-render) finds no hint the second time, so the toast fires at most once.
 */

/** Writer: local-ai/lifecycle/self-heal.ts (RETIRED_MODEL_NOTICE_HINT_KEY). */
const RETIRED_MODEL_NOTICE_HINT_KEY = "eco-local-ai-retired-notice-v1";

/** Longer than the 3s default so the two-sentence copy can be read in full. */
const NOTICE_DURATION_MS = 8000;

function readAndClearHint(): { label: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RETIRED_MODEL_NOTICE_HINT_KEY);
    if (!raw) return null;
    window.localStorage.removeItem(RETIRED_MODEL_NOTICE_HINT_KEY);
    const parsed = JSON.parse(raw) as { label?: unknown };
    const label = typeof parsed.label === "string" && parsed.label.length > 0 ? parsed.label : null;
    return label ? { label } : null;
  } catch {
    // Best-effort: a malformed hint is dropped silently (the read above already
    // removed it), so we never re-notify on a bad value.
    return null;
  }
}

export function RetiredModelNotice() {
  const { toast } = useToast();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    const hint = readAndClearHint();
    if (!hint) return;
    toast(
      `The on-device model you were using (${hint.label}) is no longer offered. `
        + "Eco has switched you to its current recommendation for this device.",
      "info",
      NOTICE_DURATION_MS,
    );
  }, [toast]);

  return null;
}
