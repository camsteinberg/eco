// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { sanitizeLaunchSafeRelativeUrl } from "./access-policy";

export const AUTH_INVITE_COOKIE_NAME = "eco-invite-code";

type AuthContinuationOptions = {
  callbackUrl?: string | null;
  prompt?: string | null;
};

export type AuthSuccessNavigation = {
  redirectTo: string;
  promptToResume: string | null;
};

// legacy: bounces stale /invite callbackUrls to /chat instead of 404
const AUTH_ENTRY_PATH_PREFIXES = ["/sign-in", "/sign-up", "/invite"] as const;
const RETIRED_PUBLIC_AUTH_BOUNCE_PATH_PREFIXES = [
  "/download",
  "/founding-miners",
  "/contributors",
  "/developers",
] as const;
const CANONICAL_CHAT_PATH_PREFIXES = ["/try", "/chat/new"] as const;

function matchesPathPrefix(
  pathname: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function getRelativePathname(relativeUrl: string): string {
  return new URL(relativeUrl, "https://eco.local").pathname;
}

export function sanitizeRelativeUrl(
  url: string | null | undefined,
  fallback: string,
): string {
  return sanitizeLaunchSafeRelativeUrl(url, fallback);
}

export function isRetiredPublicAuthBouncePath(pathname: string): boolean {
  return matchesPathPrefix(pathname, RETIRED_PUBLIC_AUTH_BOUNCE_PATH_PREFIXES);
}

export function shouldResolveAuthDestinationToChat(
  url: string | null | undefined,
): boolean {
  const safeUrl = sanitizeRelativeUrl(url, "/chat");
  const pathname = getRelativePathname(safeUrl);

  return (
    pathname === "/" ||
    pathname === "/chat" ||
    matchesPathPrefix(pathname, AUTH_ENTRY_PATH_PREFIXES) ||
    matchesPathPrefix(pathname, CANONICAL_CHAT_PATH_PREFIXES) ||
    isRetiredPublicAuthBouncePath(pathname)
  );
}

export function resolveAuthSuccessDestination(
  callbackUrl: string | null | undefined,
  prompt: string | null | undefined,
): string {
  const safeCallback = sanitizeRelativeUrl(callbackUrl, "/chat");
  const resolvedCallback = shouldResolveAuthDestinationToChat(safeCallback)
    ? "/chat"
    : safeCallback;
  const trimmedPrompt = prompt?.trim() ?? "";

  if (!trimmedPrompt) {
    return resolvedCallback;
  }

  const callback = new URL(resolvedCallback, "https://eco.local");
  if (callback.pathname !== "/chat") {
    return resolvedCallback;
  }

  callback.searchParams.set("prompt", trimmedPrompt);
  return `${callback.pathname}${callback.search}`;
}

export function resolveAuthSuccessNavigation(
  callbackUrl: string | null | undefined,
  prompt: string | null | undefined,
): AuthSuccessNavigation {
  const redirectTo = resolveAuthSuccessDestination(callbackUrl, prompt);
  const promptToResume = prompt?.trim() ?? "";

  if (!promptToResume) {
    return {
      redirectTo,
      promptToResume: null,
    };
  }

  const destination = new URL(redirectTo, "https://eco.local");
  if (destination.pathname !== "/chat") {
    return {
      redirectTo,
      promptToResume: null,
    };
  }

  destination.searchParams.delete("prompt");
  const nextSearch = destination.searchParams.toString();

  return {
    redirectTo: nextSearch ? `${destination.pathname}?${nextSearch}` : destination.pathname,
    promptToResume,
  };
}

export function buildAuthPageHref(
  basePath: "/sign-in" | "/sign-up",
  options: AuthContinuationOptions,
): string {
  const params = new URLSearchParams({
    callbackUrl: sanitizeRelativeUrl(options.callbackUrl, "/chat"),
  });

  const trimmedPrompt = options.prompt?.trim();
  if (trimmedPrompt) {
    params.set("prompt", trimmedPrompt);
  }

  return `${basePath}?${params.toString()}`;
}

export function buildChatContinuationHref(
  prompt: string | null | undefined,
): string {
  const trimmedPrompt = prompt?.trim();
  if (!trimmedPrompt) {
    return "/chat";
  }

  const params = new URLSearchParams({ prompt: trimmedPrompt });
  return `/chat?${params.toString()}`;
}

export function buildRecoveryPageHref(
  basePath: "/forgot-password" | "/reset-password",
  options: Pick<AuthContinuationOptions, "callbackUrl" | "prompt">,
): string {
  const params = new URLSearchParams();
  const callbackUrl = sanitizeRelativeUrl(options.callbackUrl, "/chat");
  const trimmedPrompt = options.prompt?.trim();

  if (callbackUrl !== "/chat") {
    params.set("callbackUrl", callbackUrl);
  } else if (trimmedPrompt) {
    params.set("callbackUrl", callbackUrl);
  }

  if (trimmedPrompt) {
    params.set("prompt", trimmedPrompt);
  }

  const search = params.toString();
  return search ? `${basePath}?${search}` : basePath;
}

/**
 * Resolve an app-relative path to an absolute URL on the web origin.
 *
 * Better Auth builds emailed links (verification, password reset) from its own
 * baseURL — the API origin — and resolves relative callback/redirect URLs
 * against it. The API host serves no app pages, so a relative URL sent with
 * sign-up / sign-in / forget-password strands the user on an API 404 after
 * they click the emailed link (sign-up / sign-in / request-password-reset all
 * carry one). Always send absolute web-origin URLs; the web origin is in the
 * API's trustedOrigins, so they pass its origin check.
 */
export function toAbsoluteWebUrl(relativeUrl: string): string {
  if (typeof window === "undefined" || !window.location?.origin) {
    return relativeUrl;
  }
  return new URL(relativeUrl, window.location.origin).toString();
}

/** Retained to evict legacy invite cookies from returning users after open-signup. */
export function clearInviteCodeCookie(): void {
  if (typeof document === "undefined") {
    return;
  }

  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  document.cookie = [
    `${AUTH_INVITE_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}
