// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The `/v1/*` proxy handler. The point of the handler (over the rewrite it
 * replaced) is the trusted client-IP header, so the header contract is what most
 * of these tests pin: exactly one allowlist in, a client-supplied `x-eco-*`
 * never surviving, and nothing added when no secret is configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST, GET, DELETE, OPTIONS } from "../route";

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

function sentHeaders(index = 0): Headers {
  return new Headers(callAt(index).init.headers as Headers);
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

describe("(a) forwarding", () => {
  it("forwards method, path and query to the upstream base", async () => {
    const response = await POST(
      new Request("https://eco.test/v1/search?debug=1", { method: "POST", body: '{"q":"x"}' }),
    );

    expect(calls).toHaveLength(1);
    expect(callAt(0).url).toBe("http://api.test/v1/search?debug=1");
    expect(callAt(0).init.method).toBe("POST");
    expect(response.status).toBe(200);
  });

  it("falls back to NEXT_PUBLIC_API_URL, then to localhost, and trims a trailing slash", async () => {
    delete process.env.API_URL;
    process.env.NEXT_PUBLIC_API_URL = "http://public.test/";
    await GET(new Request("https://eco.test/v1/ping"));
    expect(callAt(0).url).toBe("http://public.test/v1/ping");

    delete process.env.NEXT_PUBLIC_API_URL;
    await GET(new Request("https://eco.test/v1/ping"));
    expect(callAt(1).url).toBe("http://localhost:3001/v1/ping");
  });

  it("streams a body with duplex: half and sends none on GET/DELETE-without-body", async () => {
    await POST(new Request("https://eco.test/v1/feedback", { method: "POST", body: "hello" }));
    expect(callAt(0).init.duplex).toBe("half");
    expect(callAt(0).init.body).not.toBeUndefined();

    await GET(new Request("https://eco.test/v1/ping"));
    expect(callAt(1).init.body).toBeUndefined();

    await DELETE(new Request("https://eco.test/v1/auth/account", { method: "DELETE" }));
    expect(callAt(2).init.body).toBeUndefined();
  });

  it("forwards OPTIONS rather than answering it locally", async () => {
    await OPTIONS(new Request("https://eco.test/v1/search", { method: "OPTIONS" }));
    expect(callAt(0).init.method).toBe("OPTIONS");
  });
});

describe("(b) request headers", () => {
  it("forwards only the allowlisted headers", async () => {
    await POST(
      new Request("https://eco.test/v1/search", {
        method: "POST",
        body: "{}",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          cookie: "eco_site_access=abc",
          origin: "https://eco.test",
          authorization: "Bearer t",
          "accept-language": "en-GB",
          "user-agent": "Mozilla/5.0",
          "x-forwarded-for": "198.51.100.9",
          "x-real-ip": "198.51.100.9",
          "fly-client-ip": "198.51.100.9",
          "x-custom-thing": "nope",
        },
      }),
    );

    const sent = sentHeaders();
    expect([...sent.keys()].sort()).toEqual([
      "accept",
      "accept-language",
      "authorization",
      "content-type",
      "cookie",
      "origin",
      "user-agent",
    ]);
    expect(sent.get("host")).toBeNull();
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(sent.get("fly-client-ip")).toBeNull();
  });

  it("adds the trusted IP + key from x-real-ip when the secret is set", async () => {
    process.env.API_PROXY_SECRET = "s3cret";
    await POST(
      new Request("https://eco.test/v1/search", {
        method: "POST",
        body: "{}",
        headers: { "x-real-ip": "203.0.113.7" },
      }),
    );

    const sent = sentHeaders();
    expect(sent.get("x-eco-client-ip")).toBe("203.0.113.7");
    expect(sent.get("x-eco-proxy-key")).toBe("s3cret");
  });

  it("takes the first entry of x-forwarded-for when x-real-ip is absent", async () => {
    process.env.API_PROXY_SECRET = "s3cret";
    await POST(
      new Request("https://eco.test/v1/search", {
        method: "POST",
        body: "{}",
        headers: { "x-forwarded-for": "203.0.113.7, 70.41.3.18" },
      }),
    );

    expect(sentHeaders().get("x-eco-client-ip")).toBe("203.0.113.7");
  });

  it("drops a client-supplied x-eco-client-ip and replaces it with the edge value", async () => {
    process.env.API_PROXY_SECRET = "s3cret";
    await POST(
      new Request("https://eco.test/v1/search", {
        method: "POST",
        body: "{}",
        headers: {
          "x-real-ip": "203.0.113.7",
          "x-eco-client-ip": "1.1.1.1",
          "x-eco-proxy-key": "guessed",
        },
      }),
    );

    const sent = sentHeaders();
    expect(sent.get("x-eco-client-ip")).toBe("203.0.113.7");
    expect(sent.get("x-eco-proxy-key")).toBe("s3cret");
  });

  it("sends neither header when the secret is unset, even with a client-supplied one", async () => {
    await POST(
      new Request("https://eco.test/v1/search", {
        method: "POST",
        body: "{}",
        headers: { "x-real-ip": "203.0.113.7", "x-eco-proxy-key": "guessed" },
      }),
    );

    const sent = sentHeaders();
    expect(sent.get("x-eco-client-ip")).toBeNull();
    expect(sent.get("x-eco-proxy-key")).toBeNull();
  });

  it("sends neither header when the secret is set but no client IP is resolvable", async () => {
    process.env.API_PROXY_SECRET = "s3cret";
    await POST(new Request("https://eco.test/v1/search", { method: "POST", body: "{}" }));

    const sent = sentHeaders();
    expect(sent.get("x-eco-client-ip")).toBeNull();
    expect(sent.get("x-eco-proxy-key")).toBeNull();
  });
});

describe("(c) response pass-through", () => {
  it("returns the upstream status and body", async () => {
    nextResponse = new Response('{"results":[]}', {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "42",
        "x-ratelimit-limit": "20",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "42",
        "cache-control": "no-store",
      },
    });

    const response = await POST(
      new Request("https://eco.test/v1/search", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toBe('{"results":[]}');
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("x-ratelimit-limit")).toBe("20");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(response.headers.get("x-ratelimit-reset")).toBe("42");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("passes every Set-Cookie value through", async () => {
    const upstream = new Response("{}", { status: 200 });
    upstream.headers.append("set-cookie", "a=1; Path=/; HttpOnly");
    upstream.headers.append("set-cookie", "b=2; Path=/; HttpOnly");
    nextResponse = upstream;

    const response = await POST(
      new Request("https://eco.test/v1/auth/profile", { method: "POST", body: "{}" }),
    );

    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; HttpOnly",
    ]);
  });

  it("does not leak unlisted upstream headers", async () => {
    nextResponse = new Response("{}", {
      status: 200,
      headers: { server: "fly", "x-internal-debug": "leak" },
    });

    const response = await POST(
      new Request("https://eco.test/v1/search", { method: "POST", body: "{}" }),
    );

    expect(response.headers.get("x-internal-debug")).toBeNull();
  });
});

describe("(d) upstream failure", () => {
  it("returns an opaque 502 and no details", async () => {
    nextResponse = new Error("getaddrinfo ENOTFOUND api.internal");

    const response = await POST(
      new Request("https://eco.test/v1/search", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({
      error: { code: "upstream_unreachable", message: "API unreachable" },
    });
    expect(JSON.stringify(body)).not.toContain("ENOTFOUND");
  });
});

describe("(e) the body is never read or logged", () => {
  it("logs nothing at all, on success or failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );

    const secret = "q-never-logged-7f3a";
    await POST(
      new Request("https://eco.test/v1/search", {
        method: "POST",
        body: JSON.stringify({ q: secret }),
        headers: { "content-type": "application/json" },
      }),
    );

    nextResponse = new Error("boom");
    await POST(
      new Request("https://eco.test/v1/search", {
        method: "POST",
        body: JSON.stringify({ q: secret }),
        headers: { "content-type": "application/json" },
      }),
    );

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("hands the body to fetch as an unread stream", async () => {
    const request = new Request("https://eco.test/v1/search", {
      method: "POST",
      body: JSON.stringify({ q: "unread" }),
    });

    await POST(request);

    // The handler must not consume the body itself — if it had, `bodyUsed` would
    // be true here and the streamed forward would have failed.
    expect(request.bodyUsed).toBe(false);
    expect(callAt(0).init.body).toBe(request.body);
  });
});
