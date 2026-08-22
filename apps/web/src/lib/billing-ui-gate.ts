// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Compile-time gate for billing / Supporter / tier UI surfaces.
 *
 * Set `NEXT_PUBLIC_ECO_BILLING_UI=enabled` to show billing surfaces.
 * **Default (unset) = hidden** — fail-closed on the free-launch side.
 *
 * This is a single helper so the flag name and semantics live in one place
 * instead of scattered `process.env` reads.
 */
export function isBillingUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ECO_BILLING_UI === "enabled";
}
