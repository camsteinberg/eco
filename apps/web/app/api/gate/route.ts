// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { NextResponse } from "next/server";
import {
  createSiteGateAccessToken,
  SITE_ACCESS_COOKIE,
  SITE_ACCESS_COOKIE_MAX_AGE_SECONDS,
} from "../../../src/lib/site-gate-cookie";

/**
 * Compare the submitted password with the configured one in time that does not
 * depend on how much of it matched. `!==` on strings short-circuits at the
 * first differing byte, which is a (small, but free to close) oracle.
 *
 * Unequal lengths cannot be compared byte-for-byte, so the loop still runs in
 * full — against the expected value itself — before the mismatch is reported,
 * so an early return does not turn length into its own, faster signal.
 *
 * Node's `timingSafeEqual` is deliberately not used: this route carries no
 * `runtime` export, and a hand-rolled byte loop stays correct if it is ever
 * moved to the edge runtime, where `node:crypto` is unavailable.
 */
function timingSafeStringEqual(supplied: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const suppliedBytes = encoder.encode(supplied);
  const expectedBytes = encoder.encode(expected);
  const sameLength = suppliedBytes.length === expectedBytes.length;
  const left = sameLength ? suppliedBytes : expectedBytes;

  let diff = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    diff |= left[index]! ^ expectedBytes[index]!;
  }

  return sameLength && diff === 0;
}

export function GET() {
  return NextResponse.json({ configured: Boolean(process.env.SITE_PASSWORD) });
}

export async function POST(request: Request) {
  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword) {
    return NextResponse.json({ error: "No password configured" }, { status: 404 });
  }

  let body: { password?: unknown };
  try {
    body = (await request.json()) as { password?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (typeof body.password !== "string" || !timingSafeStringEqual(body.password, sitePassword)) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SITE_ACCESS_COOKIE, await createSiteGateAccessToken(sitePassword), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SITE_ACCESS_COOKIE_MAX_AGE_SECONDS,
  });

  return response;
}
