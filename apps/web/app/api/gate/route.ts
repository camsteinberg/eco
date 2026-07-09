// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { NextResponse } from "next/server";
import {
  createSiteGateAccessToken,
  SITE_ACCESS_COOKIE,
  SITE_ACCESS_COOKIE_MAX_AGE_SECONDS,
} from "../../../src/lib/site-gate-cookie";

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

  if (typeof body.password !== "string" || body.password !== sitePassword) {
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
