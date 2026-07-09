// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import * as Sentry from "@sentry/nextjs";

function initServerSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
  });
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    initServerSentry();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    initServerSentry();
  }
}

export const onRequestError = Sentry.captureRequestError;
