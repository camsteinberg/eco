// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

type JsonBody = Record<string, unknown>;

export function internalDeniedJson(
  body: JsonBody = { error: "Not found" },
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("X-Robots-Tag", "noindex, nofollow");

  return Response.json(body, {
    ...init,
    status: init.status ?? 404,
    headers,
  });
}
