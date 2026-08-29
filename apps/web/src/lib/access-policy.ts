// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { SettingsTabId } from "../components/settings/settingsNavigation";

export type ViewerMode = "guest" | "member";
export type LaunchRouteClass =
  | "launch-public"
  | "guest-safe-app"
  | "member-only-preview"
  | "hard-member-only"
  | "retired"
  | "internal"
  | "static-asset"
  | "unknown";
export type GuestAllowedSettingsTabId = Extract<
  SettingsTabId,
  "appearance" | "support" | "models"
>;
export type GuestLockedSettingsTabId = Extract<
  SettingsTabId,
  "account" | "billing"
>;
export type GuestAccessDecision = {
  pathname: string;
  settingsTab?: SettingsTabId;
  routeClass: LaunchRouteClass;
  canAccessAsGuest: boolean;
  renderLockedPreview: boolean;
  authRedirectTarget: string;
};

const GUEST_APP_PATH_PREFIXES = ["/chat", "/settings"] as const;
// No hard member-only routes remain after the referral dashboard was removed in
// Wave D S3b. The mechanism stays in place so future member-only surfaces can be
// re-added by listing their prefixes here; with an empty list nothing classifies
// as "hard-member-only" (such paths fall through to "unknown" and stay blocked).
const HARD_MEMBER_ONLY_PATH_PREFIXES = [] as const;
const RETIRED_PUBLIC_PATH_PREFIXES = [
  "/download",
  "/founding-miners",
  "/contributors",
  "/developers",
  "/try",
  "/archive/prelaunch",
  // The network status + governance surfaces moved to the eco-desktop product and
  // are no longer part of the v1.0 web app. They stay retired (blocked, never a
  // guest preview, and an unsafe redirect target) rather than guest-accessible.
  "/network",
  "/governance",
] as const;
const INTERNAL_PATH_PREFIXES = [
  "/api",
  "/_next",
  "/validation",
  "/dev-login",
  "/dev-logout",
] as const;
const STATIC_ASSET_PATH_PREFIXES = [
  "/favicon.ico",
  "/icon",
  "/manifest",
  "/robots.txt",
  "/sitemap.xml",
  "/sw.js",
] as const;
const LAUNCH_PUBLIC_PATH_PREFIXES = [
  "/",
  "/gate",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/privacy",
  "/terms",
  "/impact",
  "/transparency",
  "/licenses",
] as const;

const GUEST_ALLOWED_SETTINGS_TABS = new Set<GuestAllowedSettingsTabId>([
  "appearance",
  "support",
  "models",
]);

const GUEST_LOCKED_SETTINGS_TABS = new Set<GuestLockedSettingsTabId>([
  "account",
  "billing",
]);

function matchesPathPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function getRelativeUrl(value: string | null | undefined): URL | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  try {
    return new URL(value, "https://eco.local");
  } catch {
    return null;
  }
}

export function getViewerMode(hasSession: boolean): ViewerMode {
  return hasSession ? "member" : "guest";
}

export function isHardMemberOnlyPath(pathname: string): boolean {
  return matchesPathPrefix(pathname, HARD_MEMBER_ONLY_PATH_PREFIXES);
}

export function isGuestAccessibleAppPath(pathname: string): boolean {
  return matchesPathPrefix(pathname, GUEST_APP_PATH_PREFIXES);
}

export function classifyLaunchRoute(pathname: string): LaunchRouteClass {
  if (matchesPathPrefix(pathname, INTERNAL_PATH_PREFIXES)) {
    return "internal";
  }

  if (matchesPathPrefix(pathname, STATIC_ASSET_PATH_PREFIXES)) {
    return "static-asset";
  }

  if (isHardMemberOnlyPath(pathname)) {
    return "hard-member-only";
  }

  if (matchesPathPrefix(pathname, RETIRED_PUBLIC_PATH_PREFIXES)) {
    return "retired";
  }

  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "member-only-preview";
  }

  if (isGuestAccessibleAppPath(pathname)) {
    return "guest-safe-app";
  }

  if (matchesPathPrefix(pathname, LAUNCH_PUBLIC_PATH_PREFIXES)) {
    return "launch-public";
  }

  return "unknown";
}

export function sanitizeLaunchSafeRelativeUrl(
  url: string | null | undefined,
  fallback: string = "/chat",
): string {
  const relativeUrl = getRelativeUrl(url);

  if (!relativeUrl) {
    return fallback;
  }

  const routeClass = classifyLaunchRoute(relativeUrl.pathname);

  if (
    routeClass === "internal"
    || routeClass === "static-asset"
    || routeClass === "hard-member-only"
    || routeClass === "retired"
    || routeClass === "unknown"
  ) {
    return fallback;
  }

  return `${relativeUrl.pathname}${relativeUrl.search}${relativeUrl.hash}`;
}

export function isGuestAllowedSettingsTab(
  tab: SettingsTabId,
): tab is GuestAllowedSettingsTabId {
  return GUEST_ALLOWED_SETTINGS_TABS.has(tab as GuestAllowedSettingsTabId);
}

export function isGuestLockedSettingsTab(
  tab: SettingsTabId,
): tab is GuestLockedSettingsTabId {
  return GUEST_LOCKED_SETTINGS_TABS.has(tab as GuestLockedSettingsTabId);
}

export function getGuestAccessDecision(
  pathname: string,
  settingsTab?: SettingsTabId,
): GuestAccessDecision {
  const routeClass = classifyLaunchRoute(pathname);
  const canAccessAsGuest =
    routeClass === "guest-safe-app"
    || routeClass === "member-only-preview";
  const renderLockedPreview =
    (pathname === "/settings" || pathname.startsWith("/settings/"))
    && (settingsTab ? isGuestLockedSettingsTab(settingsTab) : true);

  return {
    pathname,
    settingsTab,
    routeClass,
    canAccessAsGuest,
    renderLockedPreview,
    authRedirectTarget: canAccessAsGuest ? pathname : "/sign-in",
  };
}

export function canGuestAccessAppRoute(
  pathname: string,
  settingsTab?: SettingsTabId,
): boolean {
  return getGuestAccessDecision(pathname, settingsTab).canAccessAsGuest;
}

export function shouldRenderGuestLockedPreview(
  pathname: string,
  settingsTab?: SettingsTabId,
): boolean {
  return getGuestAccessDecision(pathname, settingsTab).renderLockedPreview;
}

export function resolvePublicAppDestination(returnTo?: string | null): string {
  const destination = sanitizeLaunchSafeRelativeUrl(returnTo, "/chat");
  return destination === "/" ? "/chat" : destination;
}
