// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The `/api/auth/*` proxy handler. The header contract itself is pinned by the
 * `/v1/*` suite over the same `proxyToApi` module; what is specific to this path
 * is why it could not be moved off the rewrite before — Better Auth's
 * `Set-Cookie` (which repeats) and the OAuth 3xx `location`. Those two are what
 * these tests hold down, plus the fact that every method export is the proxy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, OPTIONS, PATCH, POST, PUT } from "../route";
import { proxyToApi } from "../../../../../src/lib/api-proxy";

interface FetchCall {
  url: string;
  init: RequestInit & { duplex?: string };
}

const calls: FetchCall[] = [];
let nextResponse: Response | Error;

const originalEnv = { ...process.env };

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (nextResponse instanceof Error) return Promise.reject(nextResponse);
      return Promise.resolve(nextResponse);
    }),
  );
}

/** The nth recorded fetch, with a readable failure if the call never happened. */
function callAt(index: number): FetchCall {
  const call = calls[index];
  if (!call) throw new Error(`No fetch call at index ${String(index)} (of ${String(calls.length)})`);
  return call;
}

beforeEach(() => {
  calls.length = 0;
  nextResponse = new Response("{}", { status: 200 });
  process.env.API_URL = "http://api.test";
  delete process.env.NEXT_PUBLIC_API_URL;
  delete process.env.API_PROXY_SECRET;
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("(a) method exports", () => {
  it("routes every method through the shared proxy", () => {
    for (const handler of [GET, POST, PUT, PATCH, DELETE, OPTIONS]) {
      expect(handler).toBe(proxyToApi);
    }
  });
});

describe("(b) Better Auth sign-in", () => {
  it("forwards the path and the cookie, and returns every Set-Cookie", async () => {
    const upstream = new Response('{"user":{}}', { status: 200 });
    upstream.headers.append("set-cookie", "better-auth.session_token=abc; Path=/; HttpOnly");
    upstream.headers.append("set-cookie", "better-auth.session_data=xyz; Path=/; HttpOnly");
    nextResponse = upstream;

    const response = await POST(
      new Request("https://eco.test/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.test", password: "pw" }),
        headers: {
          "content-type": "application/json",
          cookie: "better-auth.state=s1",
          origin: "https://eco.test",
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(callAt(0).url).toBe("http://api.test/api/auth/sign-in/email");
    expect(callAt(0).init.method).toBe("POST");

    const sent = new Headers(callAt(0).init.headers as Headers);
    expect(sent.get("cookie")).toBe("better-auth.state=s1");
    expect(sent.get("origin")).toBe("https://eco.test");

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([
      "better-auth.session_token=abc; Path=/; HttpOnly",
      "better-auth.session_data=xyz; Path=/; HttpOnly",
    ]);
  });
});

describe("(c) the OAuth redirect", () => {
  it("hands a 302 back with its location rather than following it", async () => {
    nextResponse = new Response(null, {
      status: 302,
      headers: { location: "https://accounts.google.test/o/oauth2/auth?client_id=1" },
    });

    const response = await GET(
      new Request("https://eco.test/api/auth/callback/google?code=xyz"),
    );

    expect(callAt(0).url).toBe("http://api.test/api/auth/callback/google?code=xyz");
    expect(callAt(0).init.redirect).toBe("manual");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://accounts.google.test/o/oauth2/auth?client_id=1",
    );
  });
});
