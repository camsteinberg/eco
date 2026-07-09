// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { NextResponse } from "next/server";

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function GET() {
  return NextResponse.json(
    {
      service: "eco-web",
      status: "ok",
      commitSha: envValue("VERCEL_GIT_COMMIT_SHA"),
      deploymentId: envValue("VERCEL_DEPLOYMENT_ID"),
      deploymentUrl: envValue("VERCEL_URL"),
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
