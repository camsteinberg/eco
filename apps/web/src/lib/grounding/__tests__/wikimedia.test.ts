// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for the Wikimedia grounding lookup engine (#5 Slice 1).
 *
 * These drive `lookupWikipedia` + `getWikidataStatement` directly against a mocked
 * `global.fetch`. Fixtures are trimmed real response shapes from the Wikimedia REST
 * APIs. We assert real behavior — extract truncation, the title→page fallback,
 * disambiguation/timeout/abort declines, serial ordering, the `Api-User-Agent`
 * header, session-cache hits, and Wikidata amount/`asOf` parsing — not mocks of mocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearGroundingCache,
  getWikidataStatement,
  lookupWikipedia,
  searchWikipediaFulltext,
} from "../wikimedia";

// ─── Fetch mock plumbing ───────────────────────────────────────────────────────

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

let fetchMock: FetchMock;

/** Build a `Response`-like object with the fields our parser reads. */
function jsonResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; headers?: Record<string, string> }
): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  const headers = new Headers(init?.headers ?? {});
  return {
    ok,
    status,
    headers,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A response whose `.json()` rejects — simulates a malformed JSON body. */
function badJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.reject(new SyntaxError("Unexpected token")),
  } as unknown as Response;
}

/** The URL string of the Nth fetch call (in order). Inputs are always strings here. */
function urlOf(callIndex: number): string {
  const call = fetchMock.mock.calls[callIndex];
  const input = call?.[0];
  return typeof input === "string" ? input : "";
}

/** The headers object passed to the Nth fetch call. */
function headersOf(callIndex: number): Record<string, unknown> {
  const call = fetchMock.mock.calls[callIndex];
  const init = call?.[1];
  return (init?.headers ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  clearGroundingCache();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Fixtures (trimmed real shapes) ────────────────────────────────────────────

const SEARCH_TITLE_HIT = {
  pages: [
    {
      id: 49728,
      key: "Paris",
      title: "Paris",
      excerpt: "capital of France",
      description: "Capital of France",
      thumbnail: null,
    },
  ],
};

const SEARCH_EMPTY = { pages: [] };

/** A multi-page /search/page payload (the zero-entity full-text recall shape). */
const SEARCH_PAGE_MULTI = {
  pages: [
    { id: 18978754, key: "Apple", title: "Apple", excerpt: "An <b>apple</b> is a fruit" },
    { id: 18584, key: "Apple_Inc.", title: "Apple Inc.", excerpt: "technology company" },
    { id: 60759, key: "Apfelschorle", title: "Apfelschorle", excerpt: "a German drink" },
  ],
};

const PARIS_SUMMARY = {
  type: "standard",
  title: "Paris",
  displaytitle: "Paris",
  description: "Capital and largest city of France",
  extract:
    "Paris is the capital and most populous city of France. It is situated on the Seine. The city has many famous museums and landmarks that draw tourists from around the world every single year without fail.",
  wikibase_item: "Q90",
  content_urls: {
    desktop: { page: "https://en.wikipedia.org/wiki/Paris" },
    mobile: { page: "https://en.m.wikipedia.org/wiki/Paris" },
  },
};

const DISAMBIG_SUMMARY = {
  type: "disambiguation",
  title: "Mercury",
  extract: "Mercury may refer to:",
  content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Mercury" } },
};

const PARIS_POPULATION_STATEMENT = {
  P1082: [
    {
      id: "Q90$abc",
      rank: "preferred",
      value: {
        type: "value",
        content: { amount: "+2102650", unit: "1" },
      },
      qualifiers: [
        {
          property: { id: "P585", data_type: "time" },
          value: { type: "value", content: { time: "+2023-01-01T00:00:00Z" } },
        },
      ],
    },
  ],
};

// ─── lookupWikipedia: happy path ───────────────────────────────────────────────

describe("lookupWikipedia — success", () => {
  it("resolves search → summary and returns extract, url, and qid", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(jsonResponse(PARIS_SUMMARY));

    const result = await lookupWikipedia("paris");

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.title).toBe("Paris");
    expect(result.url).toBe("https://en.wikipedia.org/wiki/Paris");
    expect(result.qid).toBe("Q90");
    expect(result.extract).toContain("Paris is the capital");
  });

  it("truncates the extract to ~4 sentences and ~600 chars without cutting mid-word", async () => {
    // Five short sentences, well under the 600-char budget: only the sentence cap
    // (4) can fire here, so it's a clean test of the sentence boundary.
    const fiveSentences =
      "Paris is the capital of France. It sits on the Seine. The city has many museums. Tourists visit it year-round. The fifth sentence should be dropped.";
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(
        jsonResponse({ ...PARIS_SUMMARY, extract: fiveSentences })
      );

    const result = await lookupWikipedia("paris");
    expect(result.found).toBe(true);
    if (!result.found) return;

    // First four sentences kept; the fifth ("The fifth sentence...") dropped.
    expect(result.extract).toBe(
      "Paris is the capital of France. It sits on the Seine. The city has many museums. Tourists visit it year-round."
    );
    expect(result.extract).not.toContain("fifth sentence");
    expect(result.extract.length).toBeLessThanOrEqual(600);
  });

  it("keeps an extract within the char budget untruncated (3 sentences, < 600 chars)", async () => {
    // The default Paris fixture is 3 sentences / ~203 chars — entirely under the
    // raised 600/4 budget, so it now passes through whole (the third sentence,
    // previously dropped at the 2-sentence cap, is retained).
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(jsonResponse(PARIS_SUMMARY));

    const result = await lookupWikipedia("paris");
    expect(result.found).toBe(true);
    if (!result.found) return;

    expect(result.extract).toBe(PARIS_SUMMARY.extract);
    expect(result.extract).toContain("famous museums");
    expect(result.extract.endsWith("…")).toBe(false);
  });

  it("char-trims a single very long sentence on a word boundary with an ellipsis", async () => {
    const longWord = "supercalifragilistic";
    const longExtract = `${Array.from({ length: 40 }, () => longWord).join(" ")} extra`;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(
        jsonResponse({ ...PARIS_SUMMARY, extract: longExtract })
      );

    const result = await lookupWikipedia("longone");
    expect(result.found).toBe(true);
    if (!result.found) return;

    expect(result.extract.endsWith("…")).toBe(true);
    // No mid-word cut: stripping the ellipsis leaves only whole copies of the word.
    const body = result.extract.slice(0, -1).trim();
    for (const token of body.split(" ")) {
      expect(token).toBe(longWord);
    }
    expect(result.extract.length).toBeLessThanOrEqual(601); // 600 + the ellipsis
  });

  it("omits qid when the summary has no wikibase_item", async () => {
    const { wikibase_item: _omit, ...noQid } = PARIS_SUMMARY;
    void _omit;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(jsonResponse(noQid));

    const result = await lookupWikipedia("paris");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.qid).toBeUndefined();
  });
});

// ─── lookupWikipedia: fallback + declines ──────────────────────────────────────

describe("lookupWikipedia — fallback and declines", () => {
  it("falls back to /search/page when /search/title is empty", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_EMPTY)) // title search empty
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT)) // page search hits
      .mockResolvedValueOnce(jsonResponse(PARIS_SUMMARY));

    const result = await lookupWikipedia("paris");

    expect(result.found).toBe(true);
    expect(urlOf(0)).toContain("/search/title?q=paris");
    expect(urlOf(1)).toContain("/search/page?q=paris");
    expect(urlOf(2)).toContain("/page/summary/Paris");
  });

  it("returns no-match when both title and page search are empty", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_EMPTY))
      .mockResolvedValueOnce(jsonResponse(SEARCH_EMPTY));

    const result = await lookupWikipedia("briznor hollow");

    expect(result).toEqual({ found: false, reason: "no-match" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // never reaches summary
  });

  it("returns disambiguation when the summary type is disambiguation", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ pages: [{ key: "Mercury", title: "Mercury" }] })
      )
      .mockResolvedValueOnce(jsonResponse(DISAMBIG_SUMMARY));

    const result = await lookupWikipedia("mercury");

    expect(result).toEqual({ found: false, reason: "disambiguation" });
  });

  it("returns no-match when the summary lacks the fields we need to cite", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(jsonResponse({ type: "standard", title: "Paris" })); // no extract/url

    const result = await lookupWikipedia("paris");

    expect(result).toEqual({ found: false, reason: "no-match" });
  });

  it("returns no-match when extract is present but content_urls is missing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(
        jsonResponse({
          type: "standard",
          title: "Paris",
          extract: "Paris is the capital of France.",
          wikibase_item: "Q90",
          // content_urls intentionally absent — url resolves to null
        })
      );

    const result = await lookupWikipedia("paris");

    expect(result).toEqual({ found: false, reason: "no-match" });
  });
});

// ─── lookupWikipedia: network/parse errors ─────────────────────────────────────

describe("lookupWikipedia — network and parse errors", () => {
  it("returns network-error on a non-ok search response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }));

    const result = await lookupWikipedia("paris");
    expect(result).toEqual({ found: false, reason: "network-error" });
  });

  it("returns network-error on a non-ok summary response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 404 }));

    const result = await lookupWikipedia("paris");
    expect(result).toEqual({ found: false, reason: "network-error" });
  });

  it("returns network-error when fetch itself rejects", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const result = await lookupWikipedia("paris");
    expect(result).toEqual({ found: false, reason: "network-error" });
  });

  it("returns network-error when the summary JSON fails to parse", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(badJsonResponse());

    const result = await lookupWikipedia("paris");
    expect(result).toEqual({ found: false, reason: "network-error" });
  });

  it("does not throw on a wrong/unexpected response shape (degrades to no-match)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ unexpected: "shape" }))
      .mockResolvedValueOnce(jsonResponse({ also: "wrong" }));

    const result = await lookupWikipedia("paris");
    expect(result).toEqual({ found: false, reason: "no-match" });
  });
});

// ─── lookupWikipedia: header, serial ordering, cache ───────────────────────────

describe("lookupWikipedia — etiquette and caching", () => {
  it("sends the Api-User-Agent header on every request", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(jsonResponse(PARIS_SUMMARY));

    await lookupWikipedia("paris");

    expect(headersOf(0)["Api-User-Agent"]).toBe(
      "EcoChat/1.0 (https://econetwork.ai; support@econetwork.ai)"
    );
    expect(headersOf(1)["Api-User-Agent"]).toBe(
      "EcoChat/1.0 (https://econetwork.ai; support@econetwork.ai)"
    );
  });

  it("calls the summary endpoint only AFTER search resolves (serial, not parallel)", async () => {
    const order: string[] = [];
    let resolveSearch: ((r: Response) => void) | undefined;

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : "";
      if (url.includes("/search/")) {
        order.push("search");
        return new Promise<Response>((resolve) => {
          resolveSearch = resolve;
        });
      }
      order.push("summary");
      return Promise.resolve(jsonResponse(PARIS_SUMMARY));
    });

    const pending = lookupWikipedia("paris");

    // Let the microtask queue drain — summary must NOT have fired yet.
    await Promise.resolve();
    expect(order).toEqual(["search"]);

    resolveSearch?.(jsonResponse(SEARCH_TITLE_HIT));
    await pending;

    expect(order).toEqual(["search", "summary"]);
  });

  it("serves a repeated query from the session cache without a second fetch", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(jsonResponse(PARIS_SUMMARY));

    const first = await lookupWikipedia("Paris");
    const second = await lookupWikipedia("  paris  "); // normalizes to same key

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(2); // not 4
  });

  it("does NOT cache a decline (a later success still hits the network)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_EMPTY))
      .mockResolvedValueOnce(jsonResponse(SEARCH_EMPTY));
    const declined = await lookupWikipedia("paris");
    expect(declined).toEqual({ found: false, reason: "no-match" });

    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(jsonResponse(PARIS_SUMMARY));
    const found = await lookupWikipedia("paris");
    expect(found.found).toBe(true);
  });
});

// ─── lookupWikipedia: timeout + caller abort ───────────────────────────────────

describe("lookupWikipedia — timeout and abort", () => {
  it("returns timeout when a request exceeds timeoutMs, and clears the timer", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    // A fetch that resolves only when its abort signal fires (a hanging request).
    fetchMock.mockImplementation((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = lookupWikipedia("paris", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);

    const result = await pending;
    expect(result).toEqual({ found: false, reason: "timeout" });
    expect(clearSpy).toHaveBeenCalled();
  });

  it("propagates a caller signal abort as a timeout decline", async () => {
    const controller = new AbortController();

    fetchMock.mockImplementation((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = lookupWikipedia("paris", { signal: controller.signal });
    controller.abort();

    const result = await pending;
    expect(result).toEqual({ found: false, reason: "timeout" });
  });

  it("declines immediately when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await lookupWikipedia("paris", { signal: controller.signal });
    expect(result).toEqual({ found: false, reason: "timeout" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── lookupWikipedia: Retry-After etiquette ────────────────────────────────────

describe("lookupWikipedia — 429/503 retry", () => {
  it("honors a bounded Retry-After once on 503, then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({}, { ok: false, status: 503, headers: { "Retry-After": "1" } })
      )
      .mockResolvedValueOnce(jsonResponse(SEARCH_TITLE_HIT))
      .mockResolvedValueOnce(jsonResponse(PARIS_SUMMARY));

    const pending = lookupWikipedia("paris");
    await vi.advanceTimersByTimeAsync(1000); // the Retry-After wait
    const result = await pending;

    expect(result.found).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // retried title search once, then summary
  });

  it("gives up with network-error if the retry also returns 429", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 429 }))
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 429 }));

    const pending = lookupWikipedia("paris");
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;

    expect(result).toEqual({ found: false, reason: "network-error" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // one retry only
  });
});

// ─── searchWikipediaFulltext ───────────────────────────────────────────────────

describe("searchWikipediaFulltext", () => {
  it("returns the top pages (title + key) from /search/page, limit 3", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_PAGE_MULTI));

    const result = await searchWikipediaFulltext("how many calories in an apple");

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.pages).toEqual([
      { title: "Apple", key: "Apple" },
      { title: "Apple Inc.", key: "Apple_Inc." },
      { title: "Apfelschorle", key: "Apfelschorle" },
    ]);
    // Single request — full-text only, never the title endpoint or a summary.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(0)).toContain("/search/page?q=");
    expect(urlOf(0)).toContain("limit=3");
  });

  it("sends the Api-User-Agent header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_PAGE_MULTI));
    await searchWikipediaFulltext("calories apple");
    expect(headersOf(0)["Api-User-Agent"]).toBe(
      "EcoChat/1.0 (https://econetwork.ai; support@econetwork.ai)"
    );
  });

  it("tolerates a page missing its key (falls back to title only)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ pages: [{ id: 1, title: "Apple" }] })
    );
    const result = await searchWikipediaFulltext("apple");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.pages).toEqual([{ title: "Apple" }]);
  });

  it("skips pages with no usable title, keeping the rest in order", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        pages: [
          { id: 1, title: "   " }, // unusable
          { id: 2, key: "Banana" }, // key-only → title falls back to key
          { id: 3, title: "Cherry", key: "Cherry" },
        ],
      })
    );
    const result = await searchWikipediaFulltext("fruit");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.pages).toEqual([
      { title: "Banana", key: "Banana" },
      { title: "Cherry", key: "Cherry" },
    ]);
  });

  it("declines no-match on an empty page list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_EMPTY));
    const result = await searchWikipediaFulltext("zzzznothing");
    expect(result).toEqual({ found: false, reason: "no-match" });
  });

  it("declines no-match on an unexpected response shape (degrades, never throws)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: "shape" }));
    const result = await searchWikipediaFulltext("apple");
    expect(result).toEqual({ found: false, reason: "no-match" });
  });

  it("declines network-error on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }));
    const result = await searchWikipediaFulltext("apple");
    expect(result).toEqual({ found: false, reason: "network-error" });
  });

  it("declines network-error when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await searchWikipediaFulltext("apple");
    expect(result).toEqual({ found: false, reason: "network-error" });
  });

  it("declines network-error on malformed JSON without throwing", async () => {
    fetchMock.mockResolvedValueOnce(badJsonResponse());
    const result = await searchWikipediaFulltext("apple");
    expect(result).toEqual({ found: false, reason: "network-error" });
  });

  it("declines timeout when the request exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = searchWikipediaFulltext("apple", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toEqual({ found: false, reason: "timeout" });
  });

  it("declines timeout when a caller signal aborts", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = searchWikipediaFulltext("apple", { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ found: false, reason: "timeout" });
  });

  it("declines immediately (no network) for an empty query", async () => {
    expect(await searchWikipediaFulltext("   ")).toEqual({
      found: false,
      reason: "no-match",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves a repeated query from the session cache without a second fetch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_PAGE_MULTI));
    const first = await searchWikipediaFulltext("Calories Apple");
    const second = await searchWikipediaFulltext("  calories apple  "); // same normalized key
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a decline (a later success still hits the network)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_EMPTY));
    expect(await searchWikipediaFulltext("apple")).toEqual({
      found: false,
      reason: "no-match",
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_PAGE_MULTI));
    const found = await searchWikipediaFulltext("apple");
    expect(found.found).toBe(true);
  });
});

// ─── getWikidataStatement ──────────────────────────────────────────────────────

describe("getWikidataStatement", () => {
  it("parses amount (stripping +) and extracts the P585 year into asOf", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(PARIS_POPULATION_STATEMENT));

    const result = await getWikidataStatement("Q90", "P1082");

    expect(result).toEqual({ value: "2102650", asOf: "2023" });
    expect(urlOf(0)).toContain("/entities/items/Q90/statements?property=P1082");
  });

  it("sends the Api-User-Agent header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(PARIS_POPULATION_STATEMENT));
    await getWikidataStatement("Q90", "P1082");
    expect(headersOf(0)["Api-User-Agent"]).toBe(
      "EcoChat/1.0 (https://econetwork.ai; support@econetwork.ai)"
    );
  });

  it("prefers the rank:'preferred' statement over an earlier normal one", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        P1082: [
          { rank: "normal", value: { type: "value", content: { amount: "+100" } } },
          { rank: "preferred", value: { type: "value", content: { amount: "+999" } } },
        ],
      })
    );

    const result = await getWikidataStatement("Q90", "P1082");
    expect(result?.value).toBe("999");
  });

  it("falls back to the first statement when none is preferred", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        P1082: [
          { rank: "normal", value: { type: "value", content: { amount: "+42" } } },
          { rank: "normal", value: { type: "value", content: { amount: "+7" } } },
        ],
      })
    );

    const result = await getWikidataStatement("Q90", "P1082");
    expect(result?.value).toBe("42");
  });

  it("omits asOf when there is no P585 qualifier", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        P1082: [
          { rank: "preferred", value: { type: "value", content: { amount: "+500" } } },
        ],
      })
    );

    const result = await getWikidataStatement("Q90", "P1082");
    expect(result).toEqual({ value: "500" });
    expect(result?.asOf).toBeUndefined();
  });

  it("tolerates a numeric content value", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        P1082: [{ rank: "preferred", value: { type: "value", content: 1234 } }],
      })
    );

    const result = await getWikidataStatement("Q90", "P1082");
    expect(result?.value).toBe("1234");
  });

  it("returns null when there are no statements for the property", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ P1082: [] }));
    expect(await getWikidataStatement("Q90", "P1082")).toBeNull();
  });

  it("returns null for a novalue snak", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        P1082: [{ rank: "preferred", value: { type: "novalue" } }],
      })
    );
    expect(await getWikidataStatement("Q90", "P1082")).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 404 }));
    expect(await getWikidataStatement("Q404", "P1082")).toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await getWikidataStatement("Q90", "P1082")).toBeNull();
  });

  it("returns null on malformed JSON without throwing", async () => {
    fetchMock.mockResolvedValueOnce(badJsonResponse());
    expect(await getWikidataStatement("Q90", "P1082")).toBeNull();
  });

  it("returns null for empty qid/property without touching the network", async () => {
    expect(await getWikidataStatement("", "P1082")).toBeNull();
    expect(await getWikidataStatement("Q90", "")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves a repeated qid|property from the session cache", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(PARIS_POPULATION_STATEMENT));

    const first = await getWikidataStatement("Q90", "P1082");
    const second = await getWikidataStatement("Q90", "P1082");

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses a bare amount (no leading +) and a negative amount correctly", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          P2044: [
            {
              rank: "preferred",
              value: { type: "value", content: { amount: "8849" } },
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          P2012: [
            {
              rank: "preferred",
              value: { type: "value", content: { amount: "-40.5" } },
            },
          ],
        })
      );

    const elevation = await getWikidataStatement("Q513", "P2044");
    expect(elevation).toEqual({ value: "8849" });

    const temperature = await getWikidataStatement("Q513", "P2012");
    expect(temperature).toEqual({ value: "-40.5" });
  });

  it("omits asOf when the P585 qualifier time is malformed or non-string", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        P1082: [
          {
            rank: "preferred",
            value: { type: "value", content: { amount: "+750" } },
            qualifiers: [
              {
                property: { id: "P585", data_type: "time" },
                value: { type: "value", content: { time: 12345 } }, // non-string
              },
            ],
          },
        ],
      })
    );

    const nonString = await getWikidataStatement("Q999", "P1082");
    expect(nonString).toEqual({ value: "750" });
    expect(nonString?.asOf).toBeUndefined();

    clearGroundingCache();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        P1082: [
          {
            rank: "preferred",
            value: { type: "value", content: { amount: "+600" } },
            qualifiers: [
              {
                property: { id: "P585", data_type: "time" },
                value: { type: "value", content: { time: "not-a-date" } }, // no YYYY match
              },
            ],
          },
        ],
      })
    );

    const garbage = await getWikidataStatement("Q999", "P1082");
    expect(garbage).toEqual({ value: "600" });
    expect(garbage?.asOf).toBeUndefined();
  });
});
