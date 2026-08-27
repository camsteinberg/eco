// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import {
  getValidationHeavyWorkDryRun,
  isValidationHarnessEnabled,
} from "./validation-harness";
import { safeStorage } from "./local-storage";

// `LocalHeavyWorkKind` lives in a dependency-free leaf so `validation-harness.ts`
// can name it without importing this module (which imports the harness at
// runtime) — that was the type-only cycle. Re-exported here so existing
// `from './local-heavy-work-owner'` imports of the type keep resolving.
import type { LocalHeavyWorkKind } from "./local-heavy-work-types";
export type { LocalHeavyWorkKind } from "./local-heavy-work-types";

export type LocalHeavyWorkLease = {
  ownerId: string;
  kind: LocalHeavyWorkKind;
  startedAt: number;
  expiresAt: number;
};

export type LocalHeavyWorkAcquireResult =
  | { ok: true; lease: LocalHeavyWorkLease; release: () => void }
  | { ok: false; active: LocalHeavyWorkLease | null; reason: string };

const LOCAL_HEAVY_WORK_OWNER_KEY = "eco-local-heavy-work-owner-v1";
const LOCAL_DOWNLOAD_OWNER_KEY = "eco-local-download-owner-v1";
const DEFAULT_LEASE_TTL_MS = 90_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const VALIDATION_DRY_RUN_LEASE_TTL_MS = 60 * 60 * 1000;
const ownedLeaseIds = new Set<string>();

function nowMs(): number {
  return Date.now();
}

function createOwnerId(kind: LocalHeavyWorkKind): string {
  const randomPart =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${kind}:${randomPart}`;
}

/**
 * Two independent mutual-exclusion domains (instant-start slice 2a):
 *
 *   - runtime — work that owns the model runtime's GPU/RAM (generation,
 *     readiness/warmup smoke, model switches, benchmarks, unload). At most
 *     one at a time, ever.
 *   - download — heavy network/storage transfers. Excludes other downloads
 *     (one background download invariant) but deliberately COEXISTS with
 *     runtime work so a background model download never blocks chat.
 */
type LeaseDomain = "runtime" | "download";

function domainForKind(kind: LocalHeavyWorkKind): LeaseDomain {
  return kind === "download" ? "download" : "runtime";
}

function storageKeyForDomain(domain: LeaseDomain): string {
  return domain === "download" ? LOCAL_DOWNLOAD_OWNER_KEY : LOCAL_HEAVY_WORK_OWNER_KEY;
}

function readLease(domain: LeaseDomain = "runtime"): LocalHeavyWorkLease | null {
  if (typeof localStorage === "undefined") return null;

  try {
    const raw = safeStorage.get(storageKeyForDomain(domain));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalHeavyWorkLease>;
    if (
      typeof parsed.ownerId !== "string"
      || typeof parsed.kind !== "string"
      || typeof parsed.startedAt !== "number"
      || typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed as LocalHeavyWorkLease;
  } catch {
    return null;
  }
}

function writeLease(lease: LocalHeavyWorkLease, domainOverride?: LeaseDomain): boolean {
  if (typeof localStorage === "undefined") return true;

  const domain = domainOverride ?? domainForKind(lease.kind);
  try {
    safeStorage.set(storageKeyForDomain(domain), JSON.stringify(lease));
    return readLease(domain)?.ownerId === lease.ownerId;
  } catch {
    return false;
  }
}

function clearLeaseFromDomain(domain: LeaseDomain, ownerId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const active = readLease(domain);
    if (!active || active.ownerId === ownerId) {
      safeStorage.remove(storageKeyForDomain(domain));
    }
  } catch {
    // Ownership is best-effort; callers still release their local worker state.
  }
}

/**
 * Clear a lease by owner. When the domain is known, clear that slot only.
 * Without a domain, check both — this also covers legacy rows written before
 * the domain split (e.g. a 'download' lease persisted under the runtime key).
 */
function clearLease(ownerId: string, domain?: LeaseDomain): void {
  ownedLeaseIds.delete(ownerId);
  if (domain) {
    clearLeaseFromDomain(domain, ownerId);
    return;
  }
  clearLeaseFromDomain("runtime", ownerId);
  clearLeaseFromDomain("download", ownerId);
}

function buildValidationDryRunOwnerId(dryRun: NonNullable<ReturnType<typeof getValidationHeavyWorkDryRun>>): string {
  return `validation-dry-run:${dryRun.mode}:${dryRun.modelId}`;
}

function isValidationDryRunLeaseStale(lease: LocalHeavyWorkLease): boolean {
  if (!lease.ownerId.startsWith("validation-dry-run:")) {
    return false;
  }

  if (!isValidationHarnessEnabled()) {
    return true;
  }

  const requestedDryRun = getValidationHeavyWorkDryRun();
  if (!requestedDryRun) {
    return true;
  }

  return lease.ownerId !== buildValidationDryRunOwnerId(requestedDryRun);
}

function getActiveLeaseInDomain(
  domain: LeaseDomain,
  at = nowMs(),
): LocalHeavyWorkLease | null {
  const active = readLease(domain);
  if (!active) return null;
  if (domain === "runtime" && isValidationDryRunLeaseStale(active)) {
    clearLease(active.ownerId, domain);
    return null;
  }
  if (active.expiresAt <= at) {
    // Clear from the domain the lease was FOUND in — its kind may disagree
    // on legacy rows written before the domain split.
    clearLease(active.ownerId, domain);
    return null;
  }
  return active;
}

/**
 * The active RUNTIME lease (generation/readiness/switch/…). Also sweeps an
 * expired download lease as a side effect, so self-heal's boot call keeps
 * both domains tidy. A live download lease is NOT returned here — downloads
 * coexist with runtime work by design; use `getActiveLocalDownloadLease`.
 */
export function getActiveLocalHeavyWorkLease(
  at = nowMs(),
): LocalHeavyWorkLease | null {
  getActiveLeaseInDomain("download", at);
  return getActiveLeaseInDomain("runtime", at);
}

/** The active download-domain lease, if any (expired leases are swept). */
export function getActiveLocalDownloadLease(
  at = nowMs(),
): LocalHeavyWorkLease | null {
  return getActiveLeaseInDomain("download", at);
}

export function acquireLocalHeavyWork(
  kind: LocalHeavyWorkKind,
  ttlMs = DEFAULT_LEASE_TTL_MS,
): LocalHeavyWorkAcquireResult {
  const at = nowMs();
  const active = getActiveLeaseInDomain(domainForKind(kind), at);
  if (active) {
    return {
      ok: false,
      active,
      reason:
        active.kind === kind
          ? "A local model check is already running in this browser."
          : `A local ${active.kind} job is already using this browser's model runtime.`,
    };
  }

  const lease: LocalHeavyWorkLease = {
    ownerId: createOwnerId(kind),
    kind,
    startedAt: at,
    expiresAt: at + ttlMs,
  };

  if (!writeLease(lease)) {
    return {
      ok: false,
      active: getActiveLeaseInDomain(domainForKind(kind)),
      reason: "Eco could not reserve the local model runtime safely.",
    };
  }
  ownedLeaseIds.add(lease.ownerId);

  // A reload or navigation kills the heartbeat but leaves the row in
  // localStorage with up to `ttlMs` of life left. The next page load does not
  // own that row, so its first generation would bounce off "already active"
  // for a reply nothing is producing (the offline continue-a-reply retry hit
  // exactly this). Release synchronously on pagehide, which fires on reload,
  // navigation, and tab close; a hard crash still relies on the TTL.
  const onPageHide = (): void => {
    if (readLease(domainForKind(kind))?.ownerId === lease.ownerId) {
      clearLease(lease.ownerId, domainForKind(kind));
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
  }

  const heartbeat = setInterval(() => {
    const current = readLease(domainForKind(kind));
    if (current?.ownerId !== lease.ownerId) {
      clearInterval(heartbeat);
      return;
    }
    writeLease({
      ...lease,
      expiresAt: nowMs() + ttlMs,
    });
  }, DEFAULT_HEARTBEAT_MS);

  return {
    ok: true,
    lease,
    release: () => {
      clearInterval(heartbeat);
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
      }
      ownedLeaseIds.delete(lease.ownerId);
      clearLease(lease.ownerId, domainForKind(kind));
    },
  };
}

export function isLocalHeavyWorkLeaseOwnedByThisContext(
  lease: LocalHeavyWorkLease | null,
): boolean {
  return Boolean(lease && ownedLeaseIds.has(lease.ownerId));
}

export function clearActiveLocalHeavyWorkLease(
  lease: LocalHeavyWorkLease | null,
): void {
  if (!lease) return;
  clearLease(lease.ownerId);
}

/**
 * The honest "a stronger model is warming up, please wait" copy. Shared so the
 * lease-busy path (a switch/warmup holding the runtime) and the chat error
 * surface (a send that lands mid-upgrade, before the model is ready) show the
 * SAME message — a not-ready-yet send must never read as a generic failure.
 */
export const MODEL_PREPARING_BUSY_MESSAGE =
  "Eco is preparing a local model. Wait for it to finish before starting another local model task.";

export function describeLocalHeavyWorkBusy(active: LocalHeavyWorkLease | null): string {
  if (!active) return "Another local model task is starting. Try again in a moment.";
  if (active.kind === "benchmark") {
    return "A local benchmark is already running. Eco keeps model checks serial to protect this browser.";
  }
  if (active.kind === "readiness") {
    return "A readiness check is already running. Wait for it to finish before starting another local model task.";
  }
  if (active.kind === "download") {
    return "A model preparation is already running. Eco will not start a second heavy download at the same time.";
  }
  if (active.kind === "warmup" || active.kind === "switch-model") {
    return MODEL_PREPARING_BUSY_MESSAGE;
  }
  if (active.kind === "unload") {
    return "Eco is releasing the local model runtime. Try again in a moment.";
  }
  return "Local inference is already active. Eco will not start another heavy model session at the same time.";
}

export function startValidationLocalHeavyWorkDryRun(
  at = nowMs(),
): LocalHeavyWorkLease | null {
  if (!isValidationHarnessEnabled()) {
    return null;
  }

  const dryRun = getValidationHeavyWorkDryRun();
  if (!dryRun) {
    return null;
  }

  const ownerId = buildValidationDryRunOwnerId(dryRun);
  const existing = getActiveLocalHeavyWorkLease(at);
  if (existing?.ownerId.startsWith("validation-dry-run:")) {
    if (existing.ownerId === ownerId) {
      return existing;
    }
    clearLease(existing.ownerId);
  } else if (existing) {
    return existing;
  }

  const lease: LocalHeavyWorkLease = {
    ownerId,
    kind: dryRun.mode,
    startedAt: at,
    expiresAt: at + VALIDATION_DRY_RUN_LEASE_TTL_MS,
  };

  // Dry-run leases simulate "the runtime is busy" for the validation harness
  // regardless of the simulated kind, and the staleness sweep only runs on
  // the runtime slot — so they always live in the runtime domain.
  return writeLease(lease, "runtime") ? lease : null;
}

export function cancelValidationLocalHeavyWorkDryRun(): void {
  if (!isValidationHarnessEnabled()) {
    return;
  }

  const active = readLease();
  if (active?.ownerId.startsWith("validation-dry-run:")) {
    clearLease(active.ownerId);
  }
}
