// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { NextResponse } from "next/server";
import { redactPrivacyUnsafeString } from "../../../src/lib/privacy-safe-redaction";

const MAX_BATCH_SIZE = 20;

const SAFE_EVENT_KEYS = [
  "schemaVersion",
  "operationId",
  "kind",
  "phase",
  "state",
  "modelId",
  "slot",
  "backend",
  "browserClass",
  "browserVersionBucket",
  "platformClass",
  "deviceMemoryBucket",
  "cacheBackend",
  "lockWaitMs",
  "durationMs",
  "errorCode",
  "cooldownReason",
  "workerTerminationReason",
  "createdAt",
] as const;

type SafeEventKey = (typeof SAFE_EVENT_KEYS)[number];
type SafeRuntimeDiagnosticEvent = Partial<Record<SafeEventKey, unknown>>;

function diagnosticsRouteEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_ECO_LOCAL_RUNTIME_DIAGNOSTICS === "true"
    || process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS === "true"
  );
}

function sanitizeEvent(input: unknown): SafeRuntimeDiagnosticEvent | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const operationId = redactPrivacyUnsafeString(record.operationId);
  if (record.schemaVersion !== 1 || !operationId) {
    return null;
  }

  const sanitized: SafeRuntimeDiagnosticEvent = { operationId };
  for (const key of SAFE_EVENT_KEYS) {
    if (key === "operationId") continue;
    if (key in record) {
      sanitized[key] = typeof record[key] === "string"
        ? redactPrivacyUnsafeString(record[key])
        : record[key];
    }
  }
  return sanitized;
}

function extractEvents(body: unknown): SafeRuntimeDiagnosticEvent[] | null {
  const rawEvents = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
      ? (body as { events: unknown[] }).events
      : [body];

  if (rawEvents.length > MAX_BATCH_SIZE) {
    return null;
  }

  const events = rawEvents.map(sanitizeEvent);
  if (events.some((event) => event === null)) {
    return null;
  }
  return events as SafeRuntimeDiagnosticEvent[];
}

export async function POST(request: Request) {
  if (!diagnosticsRouteEnabled()) {
    return new NextResponse(null, {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const events = extractEvents(body);
  if (!events) {
    return NextResponse.json({ error: "Invalid diagnostic event payload." }, { status: 400 });
  }

  console.info("eco.local_runtime_diagnostics", { events });
  return NextResponse.json(
    { ok: true, count: events.length },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
