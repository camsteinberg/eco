// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { NextResponse } from "next/server";
import { sanitizeRelativeUrl } from "../../../src/lib/auth-continuation";
import { internalDeniedJson } from "../../../src/lib/internal-route-denial";

function resolveOrigin(request: Request): string {
  const requestUrl = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol =
    request.headers.get("x-forwarded-proto") ?? requestUrl.protocol.replace(/:$/, "");

  if (host) {
    return `${protocol}://${host.split(",")[0]?.trim()}`;
  }

  return process.env.NEXT_PUBLIC_WEB_URL ?? requestUrl.origin;
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return internalDeniedJson({ error: "Not available in production" }, { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const requestedCallback = requestUrl.searchParams.get("callbackUrl");
  const callbackUrl = sanitizeRelativeUrl(
    requestedCallback,
    requestedCallback ? "/chat" : "/sign-in?signedOut=1&callbackUrl=/chat",
  );
  const response = NextResponse.redirect(new URL(callbackUrl, resolveOrigin(request)));
  response.cookies.delete("better-auth.session_token");
  return response;
}
