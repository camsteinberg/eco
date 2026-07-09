// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// Dev-only route to set a fake session cookie for UI testing.
// This does NOT create a real auth session — it only satisfies
// the middleware cookie check so you can navigate protected pages.

import { NextResponse } from "next/server";
import {
  resolveAuthSuccessDestination,
  sanitizeRelativeUrl,
} from "../../../src/lib/auth-continuation";
import { internalDeniedJson } from "../../../src/lib/internal-route-denial";

function normalizeHost(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized === "::ffff:127.0.0.1"
  );
}

function parseAbsoluteUrl(value: string | null): URL | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function buildOriginFromHost(protocol: string, hostHeader: string | null): string | null {
  if (!hostHeader) {
    return null;
  }

  const host = hostHeader.split(",")[0]?.trim();
  if (!host) {
    return null;
  }

  return `${protocol}://${host}`;
}

function resolveRedirectOrigin(request: Request): string {
  const requestUrl = new URL(request.url);
  const protocol =
    request.headers.get("x-forwarded-proto")
    ?? request.headers.get("origin")?.split("://")[0]
    ?? requestUrl.protocol.replace(/:$/, "");

  const candidateOrigins = [
    (() => parseAbsoluteUrl(request.headers.get("origin"))?.origin ?? null)(),
    (() => {
      const referer = parseAbsoluteUrl(request.headers.get("referer"));
      return referer?.origin ?? null;
    })(),
    (() => parseAbsoluteUrl(buildOriginFromHost(protocol, request.headers.get("x-forwarded-host")))?.origin ?? null)(),
    (() => parseAbsoluteUrl(buildOriginFromHost(protocol, request.headers.get("host")))?.origin ?? null)(),
    requestUrl.origin,
  ].filter((value): value is string => Boolean(value));

  const preferredLoopbackOrigin = candidateOrigins.find((origin) => {
    const candidate = parseAbsoluteUrl(origin);
    return candidate ? isLoopbackHost(candidate.hostname) : false;
  });

  return preferredLoopbackOrigin ?? candidateOrigins[0] ?? requestUrl.origin;
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return internalDeniedJson({ error: "Not available in production" }, { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const callbackUrl = sanitizeRelativeUrl(
    requestUrl.searchParams.get("callbackUrl"),
    "/chat",
  );
  const prompt = requestUrl.searchParams.get("prompt");
  const redirectPath = resolveAuthSuccessDestination(callbackUrl, prompt);
  const response = NextResponse.redirect(
    new URL(redirectPath, resolveRedirectOrigin(request)),
  );

  response.cookies.set("better-auth.session_token", "dev-test-session", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24, // 24 hours
  });

  return response;
}
