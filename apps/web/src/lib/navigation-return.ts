// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { sanitizeRelativeUrl } from "./auth-continuation";

const ECO_LOCAL_BASE_URL = "https://eco.local";

export function withReturnTo(
  path: string,
  returnTo: string = "/chat",
): string {
  const url = new URL(path, ECO_LOCAL_BASE_URL);
  url.searchParams.set("returnTo", sanitizeRelativeUrl(returnTo, "/chat"));
  return `${url.pathname}${url.search}`;
}

export function resolveReturnTo(
  returnTo: string | null | undefined,
  fallback: string = "/",
): string {
  return sanitizeRelativeUrl(returnTo, fallback);
}
