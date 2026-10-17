// @vitest-environment node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it } from "vitest";
import { STUB_AUTH_SESSION } from "../../e2e-perf/lib/stub-session";
import { WEB_SEARCH_STUB_FETCHED_AT, WEB_SEARCH_STUB_RESULTS } from "../lib/tasks";
import { startStubApi, type StubApi } from "../safari/stub-api";

let stub: StubApi | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

/** Port 0: the OS picks a free one, so the test never collides with a real run on 3131. */
async function start(): Promise<{ stub: StubApi; base: string }> {
  stub = await startStubApi(0);
  return { stub, base: `http://127.0.0.1:${stub.port}` };
}

describe("the stub api", () => {
  it("answers the signed-in session the Chrome lane stubs", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/auth/get-session`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(STUB_AUTH_SESSION);
  });

  it("answers any other auth call with an empty object", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/auth/sign-out`, { method: "POST", body: "{}" });
    expect(await response.json()).toEqual({});
  });

  it("answers the search relay with the fixed payload and records the raw body", async () => {
    const { stub, base } = await start();
    const body = JSON.stringify({ q: "is it raining in Chicago right now" });
    const response = await fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(await response.json()).toEqual({
      fetchedAt: WEB_SEARCH_STUB_FETCHED_AT,
      results: WEB_SEARCH_STUB_RESULTS,
    });
    expect(stub.calls()).toEqual([{ method: "POST", body }]);
    stub.reset();
    expect(stub.calls()).toEqual([]);
  });

  it("refuses anything it does not stub, so an unexpected call is visible", async () => {
    const { stub, base } = await start();
    const response = await fetch(`${base}/v1/conversations`);
    expect(response.status).toBe(404);
    expect(stub.calls()).toEqual([]);
  });
});
