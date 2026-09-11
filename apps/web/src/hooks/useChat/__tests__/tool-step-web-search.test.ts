// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The web-search step (slice 2): what a live question does when the person's Web
 * switch is on.
 *
 * The invariants pinned here are the ones the privacy copy promises:
 *  - with the switch OFF nothing is requested, and the no-live-data path is
 *    exactly as it was;
 *  - with it ON the request body is `{ q }` and NOTHING else;
 *  - every failure — non-2xx, network error, timeout, garbage body, no results —
 *    lands on the honest "couldn't reach its sources" marker, never an invented
 *    live answer;
 *  - a user stop mid-search produces no marker at all (the caller finalizes).
 *
 * `fetch` is injected, so no test here can reach the network; the global is also
 * stubbed to throw, so an accidental real call fails loudly.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { runToolStep, type ToolStepStore, type WebSearchFetch } from "../tool-step";
import type { ToolCallDisplay } from "../../../lib/tool-parser";
import type { StreamPhase } from "../../../stores/chatStore";

/** Claimed by the grounding matcher ⇒ the citation-path real-time site. */
const CLAIMED_LIVE_ASK = "what's the weather in chicago today";
/** Claimed by nothing ⇒ the abstain-path real-time site. */
const UNCLAIMED_LIVE_ASK = "is jfk having delays right now";

const FETCHED_AT = "2026-09-11T18:05:00.000Z";

const RELAY_BODY = {
  fetchedAt: FETCHED_AT,
  results: [
    {
      title: "Chicago weather today",
      url: "https://example-weather.test/chicago",
      snippet: "Cloudy, 18 °C, with rain arriving after 6 p.m.",
      domain: "example-weather.test",
      published: "2026-09-11",
    },
    {
      title: "Chicago forecast",
      url: "https://example-forecast.test/il/chicago",
      snippet: "Highs near 19 °C through Friday.",
      domain: "example-forecast.test",
    },
    {
      title: "Radar — northern Illinois",
      url: "https://example-radar.test/il",
      snippet: "Light returns over the western suburbs.",
      domain: "example-radar.test",
    },
  ],
};

function makeStore() {
  const calls: ToolCallDisplay[] = [];
  const phases: StreamPhase[] = [];
  const store: ToolStepStore = {
    clearToolState: () => {
      calls.length = 0;
    },
    addToolCall: (call) => {
      calls.push(call);
    },
    updateToolCall: () => {
      /* no tool block on this path */
    },
    setStreamPhase: (phase) => {
      phases.push(phase);
    },
  };
  return { store, calls, phases };
}

type Recorded = Parameters<WebSearchFetch>;

/** An injected fetch that records its call and replies with the given response. */
function stubFetch(respond: () => Promise<Response> | Response) {
  const recorded: Recorded[] = [];
  const impl: WebSearchFetch = async (input, init) => {
    recorded.push([input, init]);
    return await respond();
  };
  return { impl, recorded };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("a test reached the network");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runToolStep — web search off", () => {
  it.each([
    ["the citation path", CLAIMED_LIVE_ASK],
    ["the abstain path", UNCLAIMED_LIVE_ASK],
  ])("makes no request and keeps the no-live-data note on %s", async (_label, ask) => {
    const { store, phases } = makeStore();
    const { impl, recorded } = stubFetch(() => jsonResponse(RELAY_BODY));

    const out = await runToolStep(ask, store, undefined, { webSearchFetch: impl });

    expect(recorded).toHaveLength(0);
    expect(out).toEqual({
      systemNote: null,
      verification: { status: "no-live-data", query: ask },
    });
    // "Looking it up…" never flashes for a lookup that does not happen.
    expect(phases).toEqual([]);
  });

  it("makes no request when the option is explicitly false", async () => {
    const { store } = makeStore();
    const { impl, recorded } = stubFetch(() => jsonResponse(RELAY_BODY));

    const out = await runToolStep(UNCLAIMED_LIVE_ASK, store, undefined, {
      webSearch: false,
      webSearchFetch: impl,
    });

    expect(recorded).toHaveLength(0);
    expect(out.verification).toEqual({ status: "no-live-data", query: UNCLAIMED_LIVE_ASK });
  });
});

describe("runToolStep — web search on", () => {
  it.each([
    ["the citation path", CLAIMED_LIVE_ASK],
    ["the abstain path", UNCLAIMED_LIVE_ASK],
  ])("searches on %s and sends only the question", async (_label, ask) => {
    const { store, phases, calls } = makeStore();
    const { impl, recorded } = stubFetch(() => jsonResponse(RELAY_BODY));

    const out = await runToolStep(ask, store, undefined, {
      webSearch: true,
      webSearchFetch: impl,
    });

    // One request, same-origin, POST, and a body of exactly `{ q }`.
    expect(recorded).toHaveLength(1);
    const [input, init] = recorded[0]!;
    expect(input).toBe("/v1/search");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ q: ask });
    expect(Object.keys(JSON.parse(init.body) as object)).toEqual(["q"]);

    // The fenced note the fixture arm measured, and a citation per result.
    expect(out.systemNote).toContain(`[Source: web search, fetched ${FETCHED_AT}]`);
    expect(out.systemNote).toContain("Chicago weather today");
    expect(out.verification).toBeUndefined();
    expect(out.citations).toEqual([
      {
        source: "Web search",
        title: "Chicago weather today",
        url: "https://example-weather.test/chicago",
        asOf: FETCHED_AT,
      },
      {
        source: "Web search",
        title: "Chicago forecast",
        url: "https://example-forecast.test/il/chicago",
        asOf: FETCHED_AT,
      },
      {
        source: "Web search",
        title: "Radar — northern Illinois",
        url: "https://example-radar.test/il",
        asOf: FETCHED_AT,
      },
    ]);
    // The composer says "Looking it up…" while the search runs, and no
    // ToolCallBlock is drawn (the model phrases the answer).
    expect(phases).toEqual(["looking-up"]);
    expect(calls).toHaveLength(0);
  });

  it("never lets a deterministic tool turn become a search", async () => {
    const { store } = makeStore();
    const { impl, recorded } = stubFetch(() => jsonResponse(RELAY_BODY));

    const out = await runToolStep("what date is 6 weeks from today", store, undefined, {
      webSearch: true,
      webSearchFetch: impl,
    });

    expect(recorded).toHaveLength(0);
    expect(out.canonicalAnswer).toBeTruthy();
  });

  it.each([
    ["a non-2xx relay response", () => jsonResponse({ error: "rate_limited" }, 429)],
    ["a 500 from the relay", () => jsonResponse({ error: "upstream" }, 500)],
    ["a body that is not JSON", () => new Response("<html>nope</html>", { status: 200 })],
    ["an empty result list", () => jsonResponse({ fetchedAt: FETCHED_AT, results: [] })],
    ["a body missing fetchedAt", () => jsonResponse({ results: RELAY_BODY.results })],
    [
      "results missing their fields",
      () => jsonResponse({ fetchedAt: FETCHED_AT, results: [{ title: "only a title" }] }),
    ],
    [
      "a network error",
      () => {
        throw new Error("relay unreachable");
      },
    ],
  ])("falls back to the honest unreachable marker on %s", async (_label, respond) => {
    const { store, phases } = makeStore();
    const { impl, recorded } = stubFetch(respond as () => Response);

    const out = await runToolStep(UNCLAIMED_LIVE_ASK, store, undefined, {
      webSearch: true,
      webSearchFetch: impl,
    });

    expect(recorded).toHaveLength(1);
    expect(out).toEqual({ systemNote: null, verification: { status: "unreachable" } });
    // The model still answers from memory; nothing was invented.
    expect(phases).toEqual(["looking-up"]);
  });

  it("drops a malformed result but keeps the usable ones", async () => {
    const { store } = makeStore();
    const { impl } = stubFetch(() =>
      jsonResponse({
        fetchedAt: FETCHED_AT,
        results: [{ title: "half a result" }, RELAY_BODY.results[0]],
      }),
    );

    const out = await runToolStep(UNCLAIMED_LIVE_ASK, store, undefined, {
      webSearch: true,
      webSearchFetch: impl,
    });

    expect(out.citations).toHaveLength(1);
    expect(out.citations?.[0]?.title).toBe("Chicago weather today");
    expect(out.systemNote).not.toContain("half a result");
  });

  it("gives up on a relay that never answers, and says so honestly", async () => {
    vi.useFakeTimers();
    const { store } = makeStore();
    const impl: WebSearchFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });

    const pending = runToolStep(UNCLAIMED_LIVE_ASK, store, undefined, {
      webSearch: true,
      webSearchFetch: impl,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({
      systemNote: null,
      verification: { status: "unreachable" },
    });
  });

  it("says nothing when the user stops mid-search", async () => {
    const controller = new AbortController();
    const { store } = makeStore();
    const impl: WebSearchFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
        controller.abort();
      });

    const out = await runToolStep(UNCLAIMED_LIVE_ASK, store, controller.signal, {
      webSearch: true,
      webSearchFetch: impl,
    });

    // No marker: the caller's post-step aborted check finalizes the message and
    // skips generation, exactly as for a stopped Wikipedia lookup.
    expect(out).toEqual({ systemNote: null });
  });

  it("aborts the in-flight request when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const { store } = makeStore();
    const impl: WebSearchFetch = (_input, init) =>
      new Promise((resolve, reject) => {
        expect(init.signal.aborted).toBe(false);
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
        // Abort a tick later, as a user pressing Stop mid-request would.
        setTimeout(() => {
          controller.abort();
        }, 0);
        void resolve;
      });

    const out = await runToolStep(UNCLAIMED_LIVE_ASK, store, controller.signal, {
      webSearch: true,
      webSearchFetch: impl,
    });

    expect(out).toEqual({ systemNote: null });
  });

  it("does not send when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { store } = makeStore();
    let seenAborted: boolean | undefined;
    const impl: WebSearchFetch = async (_input, init) => {
      seenAborted = init.signal.aborted;
      throw new Error("a real fetch would reject on an aborted signal");
    };

    const out = await runToolStep(UNCLAIMED_LIVE_ASK, store, controller.signal, {
      webSearch: true,
      webSearchFetch: impl,
    });

    expect(seenAborted).toBe(true);
    expect(out).toEqual({ systemNote: null });
  });
});
