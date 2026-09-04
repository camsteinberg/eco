// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for the host-driven tool step (#4 Phase 4a Task 2, #5 S3).
 *
 * These exercise `runToolStep` in isolation against fake store actions and the
 * REAL tool registry — verifying the side-channel writes (clear → add running →
 * update complete/error), the injected `forModel` note, abstention, the
 * async-execute / throw-safety contract, and the #5 S3 seams: the grounding tool's
 * `presentation:"citation"` path (no ToolCallBlock, citation returned), the
 * `"tool-executing"` phase flip around a matched lookup, and the abort signal
 * threaded into `execute`.
 *
 * The grounding module is mocked so no network is hit in jsdom — every test that
 * triggers grounding controls the `WikipediaResult` it sees.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WikipediaResult, WikidataStatement, WikipediaFulltextResult } from "../../../lib/grounding";
import {
  runToolStep,
  type ToolStepStore,
} from "../tool-step";
import {
  DEFAULT_TOOLS,
  IDENTITY_HOST_ANSWER,
  DATA_LOCATION_HOST_ANSWER,
  areYouXHostAnswer,
  type AnyEcoTool,
} from "../../../lib/tools";
import type { ToolCallDisplay } from "../../../lib/tool-parser";
import type { StreamPhase } from "../../../stores/chatStore";

// ─── Grounding module mock ─────────────────────────────────────────────────
// The grounding tool composes lookupWikipedia (+ getWikidataStatement). Mock both
// so factual/entity inputs (which now match grounding) never hit the network.
// Tests override these via the hoisted holder.
const groundingMock = vi.hoisted(() => ({
  wikiResult: { found: false, reason: "no-match" } as WikipediaResult,
  wikidata: null as WikidataStatement | null,
  lookupCalls: [] as Array<{ query: string; signal?: AbortSignal }>,
  fulltextResult: null as WikipediaFulltextResult | null,
}));

vi.mock("../../../lib/grounding", () => ({
  DEFAULT_TIMEOUT_MS: 6000,
  lookupWikipedia: vi.fn(
    async (
      query: string,
      opts?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<WikipediaResult> => {
      groundingMock.lookupCalls.push({ query, signal: opts?.signal });
      return groundingMock.wikiResult;
    },
  ),
  getWikidataStatement: vi.fn(
    async (): Promise<WikidataStatement | null> => groundingMock.wikidata,
  ),
  searchWikipediaFulltext: vi.fn(
    async (
      query: string,
      opts?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<WikipediaFulltextResult> => {
      groundingMock.lookupCalls.push({ query, signal: opts?.signal });
      if (groundingMock.fulltextResult) return groundingMock.fulltextResult;
      if (groundingMock.wikiResult.found) {
        return { found: true, pages: [{ title: groundingMock.wikiResult.title }] };
      }
      return { found: false, reason: "no-match" };
    },
  ),
}));

function makeStore() {
  const calls: ToolCallDisplay[] = [];
  const phases: StreamPhase[] = [];
  let cleared = 0;
  const store: ToolStepStore = {
    clearToolState: () => {
      cleared += 1;
      calls.length = 0;
    },
    addToolCall: (call) => {
      calls.push(call);
    },
    updateToolCall: (id, updates) => {
      const idx = calls.findIndex((c) => c.id === id);
      if (idx >= 0) calls[idx] = { ...calls[idx]!, ...updates };
    },
    setStreamPhase: (phase) => {
      phases.push(phase);
    },
  };
  return { store, calls, phases, getCleared: () => cleared };
}

beforeEach(() => {
  groundingMock.wikiResult = { found: false, reason: "no-match" };
  groundingMock.wikidata = null;
  groundingMock.fulltextResult = null;
  groundingMock.lookupCalls.length = 0;
});

describe("runToolStep", () => {
  it("abstains on a clear conversational turn — clears state, no call, no phase flip", async () => {
    const { store, calls, phases, getCleared } = makeStore();
    // A genuine non-match (opinion/creative phrasing the grounding deny-set screens):
    // keeps abstain coverage now that factual entity asks route to grounding.
    const out = await runToolStep("write me a short poem about my day", store);
    expect(out.systemNote).toBeNull();
    expect(out.citation).toBeUndefined();
    expect(out.verification).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(getCleared()).toBe(1);
    // The common path never touches the phase (no "Looking it up…" flash).
    expect(phases).toEqual([]);
  });

  it("abstains and clears on empty user text", async () => {
    const { store, calls, phases } = makeStore();
    const out = await runToolStep("", store);
    expect(out.systemNote).toBeNull();
    expect(calls).toHaveLength(0);
    expect(phases).toEqual([]);
  });

  it("renders running→complete and returns the display as canonicalAnswer (skip generation) for a calculator match", async () => {
    const { store, calls } = makeStore();
    const out = await runToolStep("what is 17 times 23", store);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calculator");
    expect(calls[0]!.status).toBe("complete");
    expect(calls[0]!.type).toBe("tool_complete");
    expect(calls[0]!.result).toBe("17 * 23 = 391");
    expect(calls[0]!.args).toMatchObject({ expression: "17 * 23" });

    // A canonical exact-answer tool hands its `display` back as the answer and
    // SKIPS generation (systemNote null) — the model reliably corrupts the exact
    // value in prose (audit 2026-06-09). The caller persists canonicalAnswer as the
    // message content, so it survives scroll-back and feeds copy/export.
    expect(out.canonicalAnswer).toBe("17 * 23 = 391");
    expect(out.systemNote).toBeNull();
    // Deterministic tools carry neither a citation, a verification marker, nor a
    // decline message.
    expect(out.citation).toBeUndefined();
    expect(out.verification).toBeUndefined();
  });

  it("returns canonicalAnswer (skip generation) for a unit-conversion match too — all tool-block tools", async () => {
    const { store, calls } = makeStore();
    const out = await runToolStep("5 miles in km", store);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("unit-conversion");
    // The unit tool is `presentation:"tool-block"` (default), so it takes the model
    // out of the loop identically to the calculator.
    expect(out.canonicalAnswer).toBe(calls[0]!.result);
    expect(out.canonicalAnswer).toContain("km");
    expect(out.systemNote).toBeNull();
    expect(out.citation).toBeUndefined();
  });

  it("flips the phase to tool-executing around a matched tool's execute", async () => {
    const { store, phases } = makeStore();
    await runToolStep("what is 17 times 23", store);
    // Set once, immediately before the await. The step never restores it — the
    // caller's generation owns the next transition.
    expect(phases).toEqual(["tool-executing"]);
  });

  it("attaches the tool's friendly summary to the rendered call", async () => {
    const { store, calls } = makeStore();
    await runToolStep("5 miles in km", store);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("unit-conversion");
    expect(calls[0]!.summary).toBe("5 miles → kilometers");
    expect(calls[0]!.args).toMatchObject({ family: "length", from: "mi", to: "km" });
  });

  it("renders no summary when the matched tool defines none", async () => {
    const { store, calls } = makeStore();
    const tools = await import("../../../lib/tools");
    const spy = vi.spyOn(tools, "detectTool").mockReturnValue({
      tool: {
        name: "calculator",
        description: "x",
        validate: (): boolean => true,
        match: () => ({}),
        execute: () => ({ display: "ok", forModel: "ok", ok: true }),
        // no `summarize`
      },
      args: {},
    });

    await runToolStep("anything", store);
    expect(calls[0]!.summary).toBeUndefined();
    spy.mockRestore();
  });

  it("survives a throwing summarize — no summary, call still renders", async () => {
    const { store, calls } = makeStore();
    const tools = await import("../../../lib/tools");
    const spy = vi.spyOn(tools, "detectTool").mockReturnValue({
      tool: {
        name: "calculator",
        description: "x",
        validate: (): boolean => true,
        match: () => ({}),
        execute: () => ({ display: "ok", forModel: "ok", ok: true }),
        summarize: () => {
          throw new Error("boom");
        },
      },
      args: {},
    });

    const out = await runToolStep("anything", store);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.summary).toBeUndefined();
    // A tool-block tool (no `presentation` ⇒ default "tool-block") returns its
    // display as canonicalAnswer and skips generation.
    expect(out.canonicalAnswer).toBe("ok");
    expect(out.systemNote).toBeNull();
    spy.mockRestore();
  });

  it("marks the call error (ok:false) and returns the honest failure display as canonicalAnswer (no fabricated number)", async () => {
    const { store, calls } = makeStore();
    // 1/0 → non-finite → the calculator tool returns ok:false.
    const out = await runToolStep("what is 1 / 0", store);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("error");
    expect(calls[0]!.type).toBe("tool_error");
    // The failure display is a complete, honest answer, so we still skip generation
    // (canonicalAnswer set, systemNote null) — taking the model out of the loop is
    // what guarantees it can't fabricate a number next to "doesn't have a finite
    // result".
    expect(out.systemNote).toBeNull();
    expect(out.canonicalAnswer).toBe(calls[0]!.result);
    expect(out.canonicalAnswer).toContain("finite");
  });

  it("awaits an async execute before returning", async () => {
    const order: string[] = [];
    const { store } = makeStore();
    const out = await runToolStep("what is 2 plus 2", store);
    order.push("after");
    expect(out.canonicalAnswer).toContain("2 + 2 = 4");
    expect(out.systemNote).toBeNull();
    expect(order).toEqual(["after"]);
  });

  it("on an unexpected execute throw, marks the call error AND tells the model the tool failed", async () => {
    const { store, calls } = makeStore();
    // Force a throw by mocking the registry's detect to return a throwing tool.
    const tools = await import("../../../lib/tools");
    const spy = vi.spyOn(tools, "detectTool").mockReturnValue({
      tool: {
        name: "calculator",
        description: "x",
        validate: (): boolean => true,
        match: () => ({}),
        execute: () => {
          throw new Error("boom");
        },
      },
      args: {},
    });

    const out = await runToolStep("what is 17 times 23", store);
    // 4b: the model MUST be told the tool failed so it doesn't hallucinate a
    // tool result. A brief note is injected (not null).
    expect(out.systemNote).not.toBeNull();
    expect(out.systemNote?.toLowerCase()).toContain("failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("error");
    expect(calls[0]!.type).toBe("tool_error");
    spy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding G — identity/privacy (presentation:"host-answer") path
//
// The always-on identity tool matches identity/privacy/"are you <product>?" turns
// and hands its host-authored answer back as `hostAnswer`. Unlike the tool-block
// and citation paths, execute is pure/synchronous: NO ToolCallBlock renders and the
// "tool-executing" phase never flips (there is nothing to look up). The caller shows
// `hostAnswer` verbatim and SKIPS generation — the model never states Eco's own
// identity or privacy posture.
// ═══════════════════════════════════════════════════════════════════════════

describe("runToolStep — identity (presentation:'host-answer')", () => {
  it("returns the data-location truth as hostAnswer, systemNote null, no ToolCallBlock, no phase flip", async () => {
    const { store, calls, phases, getCleared } = makeStore();
    const out = await runToolStep("where does my data go?", store);

    expect(out.hostAnswer).toBe(DATA_LOCATION_HOST_ANSWER);
    expect(out.systemNote).toBeNull();
    // No side-channel write, and the phase never flips to "tool-executing".
    expect(calls).toHaveLength(0);
    expect(phases).toEqual([]);
    expect(getCleared()).toBe(1);
    // Mutually exclusive with every other outcome field.
    expect(out.canonicalAnswer).toBeUndefined();
    expect(out.citation).toBeUndefined();
    expect(out.verification).toBeUndefined();
  });

  it("returns the identity truth for 'what are you'", async () => {
    const { store, calls } = makeStore();
    const out = await runToolStep("what are you", store);
    expect(out.hostAnswer).toBe(IDENTITY_HOST_ANSWER);
    expect(out.systemNote).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns the are-you-x denial (with canonical subject) for 'are you ChatGPT?'", async () => {
    const { store, phases } = makeStore();
    const out = await runToolStep("are you ChatGPT?", store);
    expect(out.hostAnswer).toBe(areYouXHostAnswer("ChatGPT"));
    expect(out.systemNote).toBeNull();
    expect(phases).toEqual([]);
  });

  it("still abstains on a look-alike privacy question about a third party (no host answer)", async () => {
    const { store } = makeStore();
    const out = await runToolStep("where does Dropbox store my data?", store);
    expect(out.hostAnswer).toBeUndefined();
    // It routes to grounding (a citation tool), so no hostAnswer — the point is only
    // that the identity tool did not steal it.
    expect(out.systemNote === null || typeof out.systemNote === "string").toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #5 S3 — grounding (presentation:"citation") path
// ═══════════════════════════════════════════════════════════════════════════

describe("runToolStep — grounding (presentation:'citation')", () => {
  it("grounds a factual entity ask: injects note + returns citation, NO ToolCallBlock", async () => {
    // This was a PRE-grounding 'abstain' characterization case ("tell me about
    // Paris"); now it grounds. Assert the new correct behavior.
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
      qid: "Q90",
    };
    const { store, calls, phases } = makeStore();
    const out = await runToolStep("tell me about Paris", store);

    // No ToolCallBlock side-channel write — the model phrases the answer itself.
    expect(calls).toHaveLength(0);
    // The grounding instruction (the FOUND note) is injected for the model.
    expect(out.systemNote).toContain("Paris");
    expect(out.systemNote).toContain("Source:");
    // The structured citation is returned for the caller to map onto the message.
    expect(out.citation).toBeDefined();
    expect(out.citation).toMatchObject({
      source: "Wikipedia",
      title: "Paris",
      url: "https://en.wikipedia.org/wiki/Paris",
    });
    // FOUND carries a citation, NOT a verification marker (they are mutually exclusive).
    expect(out.verification).toBeUndefined();
    // A web lookup names the web: the "looking-up" phase is set during the lookup
    // (single flip), distinct from the on-device tools' "tool-executing".
    expect(phases).toEqual(["looking-up"]);
  });

  it("hard-declines an unknown entity: note set, NO citation, NO ToolCallBlock", async () => {
    groundingMock.wikiResult = { found: false, reason: "no-match" };
    const { store, calls } = makeStore();
    const out = await runToolStep("tell me about Briznor Hollow", store);

    expect(calls).toHaveLength(0);
    expect(out.systemNote).not.toBeNull();
    expect(out.systemNote).toContain("No reliable source");
    // A decline carries no citation — the note alone tells the model to admit it.
    expect(out.citation).toBeUndefined();
    // ...but it DOES carry an "unverified" marker so the host flags the unconfirmed answer.
    expect(out.verification).toEqual({ status: "unverified" });
  });

  it("soft-degrades on a network failure: note set, NO citation", async () => {
    groundingMock.wikiResult = { found: false, reason: "network-error" };
    const { store, calls } = makeStore();
    const out = await runToolStep("tell me about Paris", store);

    expect(calls).toHaveLength(0);
    expect(out.systemNote).toContain("Couldn't reach");
    expect(out.citation).toBeUndefined();
    // A transient reach failure carries the "unreachable" marker (not "unverified").
    expect(out.verification).toEqual({ status: "unreachable" });
  });

  it("threads the abort signal into the grounding execute", async () => {
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    const controller = new AbortController();
    const { store } = makeStore();
    await runToolStep("tell me about Paris", store, controller.signal);

    expect(groundingMock.lookupCalls).toHaveLength(1);
    // The same signal instance reaches the lookup primitive (so a user-stop
    // aborts the in-flight fetch).
    expect(groundingMock.lookupCalls[0]!.signal).toBe(controller.signal);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #5 S5 — the `options.tools` gate (the grounding on/off seam)
// ═══════════════════════════════════════════════════════════════════════════

describe("runToolStep — options.tools gate", () => {
  /** DEFAULT_TOOLS with the citation tool removed — the "grounding OFF" list. */
  const toolsWithoutGrounding = DEFAULT_TOOLS.filter(
    (tool) => tool.presentation !== "citation",
  );

  it("abstains on a factual query when the provided list omits the citation tool — no lookup", async () => {
    // Grounding WOULD find this if it ran; the assertion proves it never does
    // because the citation tool is not in the list passed to detection.
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    const { store, calls, phases } = makeStore();
    const out = await runToolStep("tell me about Paris", store, undefined, {
      tools: toolsWithoutGrounding,
    });

    // Falls through to normal chat: no note, no citation, no side-channel write.
    expect(out.systemNote).toBeNull();
    expect(out.citation).toBeUndefined();
    expect(calls).toHaveLength(0);
    // No grounding lookup ran (no network).
    expect(groundingMock.lookupCalls).toHaveLength(0);
    // The common abstain path never flips the phase.
    expect(phases).toEqual([]);
  });

  it("still fires a deterministic tool from the narrowed list (only grounding is removed)", async () => {
    const { store, calls } = makeStore();
    const out = await runToolStep("what is 17 times 23", store, undefined, {
      tools: toolsWithoutGrounding,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calculator");
    expect(calls[0]!.result).toBe("17 * 23 = 391");
    // Canonical tool-block result → skip generation (canonicalAnswer, systemNote null).
    expect(out.canonicalAnswer).toBe("17 * 23 = 391");
    expect(out.systemNote).toBeNull();
  });

  it("defaults to DEFAULT_TOOLS when options is omitted (existing callers unchanged)", async () => {
    // Same factual query as above, but with the default list grounding fires.
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    const { store } = makeStore();
    const out = await runToolStep("tell me about Paris", store);

    expect(groundingMock.lookupCalls).toHaveLength(1);
    expect(out.citation).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// options.declineTools — web lookups OFF: answer from memory, labelled (2026-08-27)
//
// When web lookups are OFF the caller removes the citation tools from `tools`
// (so they never execute or hit the network) AND passes them as `declineTools`.
// A turn that WOULD have matched a disabled lookup tool gets the from-memory note
// and a `lookups-off` verification, so the model answers and the HOST marks the
// reply as not checked against a source. Detection-only: no execute, no network,
// no ToolCallBlock, no citation.
// ═══════════════════════════════════════════════════════════════════════════

describe("runToolStep — options.declineTools (web lookups off: answer from memory, labelled)", () => {
  /** The "grounding OFF" enabled list, and the disabled citation tools. */
  const enabledTools = DEFAULT_TOOLS.filter((tool) => tool.presentation !== "citation");
  const citationTools = DEFAULT_TOOLS.filter((tool) => tool.presentation === "citation");

  it("lets the model answer from memory with a host 'lookups-off' marker when a disabled lookup tool WOULD have matched — no execute, no network", async () => {
    // "tell me about Paris" matches grounding (a citation tool). With grounding
    // removed from `tools` but passed in `declineTools`, the step hands back a
    // `lookups-off` verification so the HOST draws the "not checked against a
    // source" marker deterministically, and nothing else.
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    const { store, calls, phases } = makeStore();
    const out = await runToolStep("tell me about Paris", store, undefined, {
      tools: enabledTools,
      declineTools: citationTools,
    });

    // The model answers this turn as ordinary chat: no system note, so the
    // cached prompt prefix survives (a per-turn note re-prefilled the window).
    expect(out.systemNote).toBeNull();
    // The host marker is what the user sees; it does not depend on the prose.
    expect(out.verification).toEqual({ status: "lookups-off" });
    // Detection-only: the disabled tool never executed, so no network lookup ran.
    expect(groundingMock.lookupCalls).toHaveLength(0);
    // No ToolCallBlock, no citation, no canonical answer.
    expect(calls).toHaveLength(0);
    expect(out.citation).toBeUndefined();
    expect(out.canonicalAnswer).toBeUndefined();
    // Decline is computed from a pure `match` — the "Looking it up…" phase never flips.
    expect(phases).toEqual([]);
  });

  it("still abstains (no note) on a genuine conversational turn that matches no lookup tool", async () => {
    const { store, calls, phases } = makeStore();
    const out = await runToolStep("write me a short poem about my day", store, undefined, {
      tools: enabledTools,
      declineTools: citationTools,
    });

    expect(out.systemNote).toBeNull();
    expect(out.verification).toBeUndefined();
    expect(out.citation).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(groundingMock.lookupCalls).toHaveLength(0);
    expect(phases).toEqual([]);
  });

  it("lets an enabled deterministic tool win — decline only fires on the abstain branch", async () => {
    const { store, calls } = makeStore();
    const out = await runToolStep("what is 17 times 23", store, undefined, {
      tools: enabledTools,
      declineTools: citationTools,
    });

    // The calculator (enabled) matched first; the decline path never engaged.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calculator");
    // Canonical tool-block result → skip generation; NOT a decline.
    expect(out.canonicalAnswer).toBe("17 * 23 = 391");
    expect(out.systemNote).toBeNull();
    expect(out.verification).toBeUndefined();
  });

  it("adds no note or marker when declineTools is omitted (lookups on — existing behavior)", async () => {
    // With grounding REMOVED and no declineTools, the factual turn abstains to
    // normal chat exactly as before this fix (the #5 S5 contract is unchanged).
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    const { store } = makeStore();
    const out = await runToolStep("tell me about Paris", store, undefined, {
      tools: enabledTools,
    });

    expect(out.systemNote).toBeNull();
    expect(out.verification).toBeUndefined();
    expect(groundingMock.lookupCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// chat #7 W2.2 — options.matchContext forwarding into detection
// ═══════════════════════════════════════════════════════════════════════════

describe("runToolStep — options.matchContext", () => {
  it("forwards matchContext into a tool's match when an explicit list is used", async () => {
    const { store } = makeStore();
    const seen: Array<{ lastGroundedTitle?: string } | undefined> = [];
    // A spy tool that records the context it receives and abstains.
    const spyTool: AnyEcoTool = {
      name: "spy",
      description: "records context",
      validate: (): boolean => true,
      match: (_text: string, context?: { lastGroundedTitle?: string }) => {
        seen.push(context);
        return null;
      },
      execute: () => ({ display: "", forModel: "", ok: true }),
    };

    const out = await runToolStep("how tall is it", store, undefined, {
      tools: [spyTool],
      matchContext: { lastGroundedTitle: "Eiffel Tower" },
    });

    expect(out.systemNote).toBeNull(); // the spy abstained → normal chat
    expect(seen).toEqual([{ lastGroundedTitle: "Eiffel Tower" }]);
  });

  it("forwards matchContext into detection on the default (barrel) path", async () => {
    const { store } = makeStore();
    const tools = await import("../../../lib/tools");
    const spy = vi.spyOn(tools, "detectTool").mockReturnValue(null);

    await runToolStep("how tall is it", store, undefined, {
      matchContext: { lastGroundedTitle: "Paris" },
    });

    // The default path calls the barrel detectTool with (text, context).
    expect(spy).toHaveBeenCalledWith("how tall is it", { lastGroundedTitle: "Paris" });
    spy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// forceMatch — the "Check a source" user action
// ═══════════════════════════════════════════════════════════════════════════

describe("runToolStep — forceMatch (Check a source)", () => {
  it("executes the grounding tool without candidacy detection on a turn the matchers would reject", async () => {
    // "write me a poem" is deny-listed by the normal candidacy matchers, so
    // without forceMatch it would abstain. With forceMatch it goes straight
    // to the grounding tool with forced args. The fulltext search returns a
    // page whose title passes the inverted coverage gate, then the entity
    // lookup resolves the article.
    groundingMock.fulltextResult = {
      found: true,
      pages: [{ title: "Stars" }],
    };
    groundingMock.wikiResult = {
      found: true,
      title: "Stars",
      extract: "Stars are luminous spheroids of plasma.",
      url: "https://en.wikipedia.org/wiki/Stars",
      qid: "Q523",
    };
    const { store, calls, phases } = makeStore();
    const out = await runToolStep("write me a poem about the stars", store, undefined, {
      forceMatch: true,
    });

    // No ToolCallBlock (citation path).
    expect(calls).toHaveLength(0);
    // The forced lookup produced a note and citation.
    expect(out.systemNote).not.toBeNull();
    expect(out.citation).toBeDefined();
    expect(out.citation).toMatchObject({ source: "Wikipedia" });
    expect(out.verification).toBeUndefined();
    // Phase flipped to "looking-up".
    expect(phases).toEqual(["looking-up"]);
  });

  it("returns verification on not-found — the user sees an honest 'couldn't find a source'", async () => {
    groundingMock.wikiResult = { found: false, reason: "no-match" };
    const { store, calls } = makeStore();
    const out = await runToolStep("tell me something obscure about nothing", store, undefined, {
      forceMatch: true,
    });

    expect(calls).toHaveLength(0);
    // The forced path yields the same not-found behavior as organic grounding:
    // a system note for the model and a verification marker for the host.
    expect(out.systemNote).not.toBeNull();
    expect(out.citation).toBeUndefined();
    expect(out.verification).toBeDefined();
  });

  it("returns a safe note when the grounding tool throws", async () => {
    // Simulate a network failure that throws instead of returning a result.
    const { searchWikipediaFulltext } = await import("../../../lib/grounding");
    vi.mocked(searchWikipediaFulltext).mockRejectedValueOnce(new Error("network down"));
    const { store, calls } = makeStore();
    const out = await runToolStep("who is Albert Einstein", store, undefined, {
      forceMatch: true,
    });

    expect(calls).toHaveLength(0);
    expect(out.systemNote).toContain("failed to run");
    expect(out.citation).toBeUndefined();
    expect(out.verification).toBeUndefined();
  });

  it("threads the abort signal into the forced grounding execute", async () => {
    groundingMock.wikiResult = {
      found: true,
      title: "Paris",
      extract: "Paris is the capital of France.",
      url: "https://en.wikipedia.org/wiki/Paris",
    };
    const controller = new AbortController();
    const { store } = makeStore();
    await runToolStep("what is Paris", store, controller.signal, {
      forceMatch: true,
    });

    expect(groundingMock.lookupCalls.length).toBeGreaterThanOrEqual(1);
    expect(groundingMock.lookupCalls[0]!.signal).toBe(controller.signal);
  });
});
