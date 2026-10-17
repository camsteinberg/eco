// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A stand-in for Eco's api, for a run in a browser Playwright cannot drive.
 *
 * The Chrome lane answers the auth session and the search relay by
 * intercepting the browser's requests. Real Safari offers no interception, so
 * this answers them one hop later instead: the web app's own same-origin
 * proxy (`app/api/auth/[...path]`, `app/v1/[...path]` → `src/lib/api-proxy`)
 * forwards to whatever `API_URL` names, and a run points `API_URL` at this.
 *
 * It serves the same bodies the Chrome lane does — the signed-in session from
 * `../../e2e-perf/lib/stub-session`, an empty object for any other auth call, and
 * the relay's fixed payload from `../lib/tasks` — and records every search
 * request's method and raw body, as the proxy forwarded them. Bound to
 * loopback only.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { STUB_AUTH_SESSION } from "../../e2e-perf/lib/stub-session";
import {
  WEB_SEARCH_STUB_FETCHED_AT,
  WEB_SEARCH_STUB_RESULTS,
  type SearchRelayCall,
} from "../lib/tasks";

export type StubApi = {
  port: number;
  /** Every `/v1/search` call since the last reset, in order. */
  calls: () => SearchRelayCall[];
  reset: () => void;
  close: () => Promise<void>;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function startStubApi(port: number): Promise<StubApi> {
  let calls: SearchRelayCall[] = [];

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://stub.invalid").pathname;
    const method = (request.method ?? "GET").toUpperCase();
    void (async () => {
      if (path === "/api/auth/get-session") {
        sendJson(response, 200, STUB_AUTH_SESSION);
      } else if (path === "/api/auth" || path.startsWith("/api/auth/")) {
        sendJson(response, 200, {});
      } else if (path === "/v1/search") {
        const body = method === "GET" || method === "HEAD" ? null : await readBody(request);
        calls.push({ method, body });
        sendJson(response, 200, {
          fetchedAt: WEB_SEARCH_STUB_FETCHED_AT,
          results: WEB_SEARCH_STUB_RESULTS,
        });
      } else {
        sendJson(response, 404, { error: { code: "not_stubbed", message: `${method} ${path}` } });
      }
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: { code: "stub_error" } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    calls: () => [...calls],
    reset: () => {
      calls = [];
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
