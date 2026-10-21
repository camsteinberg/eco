// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import type { SentMessages } from "../../src/local-ai/diagnostics/sent-messages";
import type { GenerationReceipt } from "../../src/local-ai/lifecycle/generation-receipt";
import {
  BUDGET_TURNS,
  CONTEXT_PROMPT,
  ECO_COMPACT_WEBLLM,
  ECO_FAST,
  EDIT_ORIGINAL_PROMPT,
  EDIT_REPLACEMENT_PROMPT,
  FIRST_TOKEN_CEILING_MS,
  INJECTED_FAULT_MESSAGE,
  PASTE_BLOCK,
  SUMMARY_PROMPT,
  TOOL_CASES,
  WEB_SEARCH_STUB_FETCHED_AT,
  judgeAnswered,
  judgeBudgetTurn,
  judgeContextNeverShown,
  judgeContextTurn,
  judgeDraft,
  judgeEdit,
  judgeFirstReply,
  judgeFollowUp,
  judgeInjectedFailure,
  judgeLookupsOff,
  judgeLookupsOn,
  judgeOfflineReload,
  judgeRecall,
  judgeReopened,
  judgeRetry,
  judgeSearchChip,
  judgeSearchOff,
  judgeSearchRequest,
  judgeShorter,
  judgeStopNotPressed,
  judgeStopped,
  judgeSummary,
  judgeSwitch,
  judgeToolCard,
  kvReasonOf,
  outcomeReceipt,
  turnCounts,
  type TurnOutcome,
} from "../lib/tasks";

/**
 * Every judge is given at least one input that PASSes and one that FAILs (or
 * each of its outcomes, where it has more), and the evidence string is pinned
 * as the literal a report row carries. The strings are the walk's own, moved
 * here unchanged from the spec; a change to one is a change to every report
 * that is ever compared against an older run, so it should fail here first.
 */

function receipt(overrides: Partial<GenerationReceipt> = {}): GenerationReceipt {
  return {
    generationId: "gen-1",
    generationRole: "primary",
    modelId: ECO_FAST.modelId,
    timestamp: 0,
    templateName: null,
    systemPromptHash: "hash-off",
    samplingProfile: {},
    promptTokens: 120,
    completionTokens: 40,
    durationMs: 900,
    status: "complete",
    firstTokenMs: 350,
    kvReuse: {
      decision: "miss",
      reason: "equal-or-shorter",
      cachedLen: 100,
      promptLen: 120,
      cacheCommitted: true,
    },
    windowStartIndex: 0,
    ...overrides,
  };
}

function outcome(overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  return {
    prompt: "a prompt",
    storedUserText: null,
    replyText: "A reply.",
    replySource: "indexeddb",
    receipts: [receipt()],
    toolAnswered: false,
    toolCardText: null,
    sent: null,
    ...overrides,
  };
}

/** A turn no generation answered: no receipt at all. */
const noGeneration = (overrides: Partial<TurnOutcome> = {}): TurnOutcome =>
  outcome({ receipts: [], ...overrides });

const COUNTS = "prompt=120 completion=40 cachedLen=100 promptLen=120 commonPrefix=- durationMs=900 windowStart=0";
const NO_COUNTS = "prompt=? completion=? cachedLen=? promptLen=? commonPrefix=- durationMs=? windowStart=?";

describe("the walk's data is what it has always asked", () => {
  it("keeps the prompts the spec carried", () => {
    expect(BUDGET_TURNS).toHaveLength(10);
    expect(BUDGET_TURNS[1]).toBe("My rent is $1,450 a month and I take home about $3,200.");
    expect(PASTE_BLOCK).toHaveLength(4392);
    expect(SUMMARY_PROMPT).toBe(`${PASTE_BLOCK}\n\nSummarise the text above in a few sentences.`);
    expect(CONTEXT_PROMPT).toBe(`${PASTE_BLOCK}\nBriefly, what is this text about?`);
    expect(TOOL_CASES.map((item) => item.expect)).toEqual(["= 11.25", "6 weeks from today is"]);
    expect(EDIT_ORIGINAL_PROMPT).toBe("My name is Priya. Say hello to me by name, in one short sentence.");
    expect(EDIT_REPLACEMENT_PROMPT).toBe("My name is Tomas. Say hello to me by name, in one short sentence.");
    expect(FIRST_TOKEN_CEILING_MS).toBe(30_000);
  });
});

describe("receipt helpers", () => {
  it("reads the last receipt as the one the person saw", () => {
    const repair = receipt({ generationRole: "repair", modelId: "m/repair" });
    expect(outcomeReceipt(outcome({ receipts: [receipt(), repair] }))).toBe(repair);
    expect(outcomeReceipt(noGeneration())).toBeNull();
  });

  it("names the KV decision with its reason", () => {
    expect(kvReasonOf(receipt())).toBe("miss/equal-or-shorter");
    expect(kvReasonOf(receipt({ kvReuse: { decision: "reuse", cachedLen: 1, promptLen: 2, cacheCommitted: true } }))).toBe("reuse");
    expect(kvReasonOf(null)).toBeNull();
  });

  it("prints a turn's counts, with the decoded divergence when there was one", () => {
    expect(turnCounts(outcome())).toBe(COUNTS);
    expect(turnCounts(noGeneration())).toBe(NO_COUNTS);
    const diverged = receipt({
      kvReuse: {
        decision: "miss",
        reason: "not-strict-prefix",
        cachedLen: 10,
        promptLen: 12,
        commonPrefixLen: 8,
        cacheCommitted: true,
        divergence: { at: 8, cachedIds: [1], nextIds: [2], cached: "rent is", next: "rent was" },
      },
    });
    expect(turnCounts(outcome({ receipts: [diverged] }))).toBe(
      'prompt=120 completion=40 cachedLen=10 promptLen=12 commonPrefix=8 durationMs=900 windowStart=0 DIV cached="rent is" next="rent was"',
    );
  });
});

describe("judgeAnswered and judgeFollowUp (tasks 12, 13, 14)", () => {
  it("answers when the reply completed promptly with words and no error card", () => {
    expect(judgeAnswered(outcome(), false)).toEqual({ ok: true, why: "" });
  });

  it("names every reason a reply did not answer", () => {
    const failed = outcome({
      replyText: "  ",
      receipts: [receipt({ status: "error", errorCode: "boom", firstTokenMs: 45_000 })],
    });
    expect(judgeAnswered(failed, true)).toEqual({
      ok: false,
      why: "the reply ended 'error' (boom); the first word took 45000 ms (ceiling 30000 ms); an error card is showing; the reply is empty",
    });
    expect(judgeAnswered(outcome({ receipts: [receipt({ firstTokenMs: null })] }), false).why).toBe(
      "no first word ever arrived",
    );
    expect(judgeAnswered(noGeneration(), false).why).toBe("no generation ran");
  });

  it("writes the follow-up row", () => {
    const next = outcome({ replyText: "Sleep well." });
    expect(judgeFollowUp(next, judgeAnswered(next, false))).toEqual({
      result: "PASS",
      evidence: `answered; ${COUNTS}; reply: Sleep well.`,
    });
    const hung = noGeneration({ replyText: "" });
    expect(judgeFollowUp(hung, judgeAnswered(hung, false))).toEqual({
      result: "FAIL",
      evidence: `did NOT answer: no generation ran; the reply is empty; ${NO_COUNTS}; reply: `,
    });
  });
});

describe("task 1 — cold first run", () => {
  it("passes on a reply and fails on none", () => {
    expect(judgeFirstReply(outcome({ replyText: "Hello there." }), 1234)).toEqual({
      result: "PASS",
      evidence: "chat usable in 1234 ms, no setup error surface; reply: Hello there.",
    });
    expect(judgeFirstReply(outcome({ replyText: " " }), 99)).toEqual({
      result: "FAIL",
      evidence: "chat usable in 99 ms, no setup error surface; reply: ",
    });
  });
});

describe("task 2 — ten-turn budgeting chat", () => {
  it("records an ordinary turn with its counts", () => {
    expect(judgeBudgetTurn(1, BUDGET_TURNS[0] ?? "", outcome({ replyText: "Sure." }))).toEqual({
      result: "RECORDED",
      evidence: `${COUNTS}; reply: Sure.`,
    });
  });

  it("checks the running total on turn 5", () => {
    const prompt = BUDGET_TURNS[4] ?? "";
    expect(judgeBudgetTurn(5, prompt, outcome({ replyText: "That is $2,065." }))).toEqual({
      result: "PASS",
      evidence: `${COUNTS}; running total 2,065 present; reply: That is $2,065.`,
    });
    expect(judgeBudgetTurn(5, prompt, outcome({ replyText: "About $2,000." }))).toEqual({
      result: "FAIL",
      evidence: `${COUNTS}; running total 2,065 absent; reply: About $2,000.`,
    });
  });

  it("checks the rent recall on turn 10", () => {
    const prompt = BUDGET_TURNS[9] ?? "";
    expect(judgeBudgetTurn(10, prompt, outcome({ replyText: "Your rent is 1450." })).result).toBe("PASS");
    expect(judgeBudgetTurn(10, prompt, outcome({ replyText: "I don't know." }))).toEqual({
      result: "FAIL",
      evidence: `${COUNTS}; rent figure from turn 2 lost; reply: I don't know.`,
    });
  });

  it("fails a turn whose stored input is not what was typed, whatever the reply", () => {
    const prompt = BUDGET_TURNS[4] ?? "";
    expect(
      judgeBudgetTurn(5, prompt, outcome({ storedUserText: "something else", replyText: "$2,065" })),
    ).toEqual({
      result: "FAIL",
      evidence: "stored input differs from what was typed: something else",
    });
    expect(judgeBudgetTurn(5, prompt, outcome({ storedUserText: ` ${prompt} `, replyText: "$2,065" })).result).toBe(
      "PASS",
    );
  });
});

describe("task 3 — summary of a paste", () => {
  it("records a shorter summary and fails an empty or longer one", () => {
    expect(judgeSummary(outcome({ replyText: "About gardens." }))).toEqual({
      result: "RECORDED",
      evidence: "14 chars back from 4392 in; summary: About gardens.",
    });
    expect(judgeSummary(outcome({ replyText: "" })).result).toBe("FAIL");
    expect(judgeSummary(outcome({ replyText: `${PASTE_BLOCK}!` })).result).toBe("FAIL");
  });
});

describe("task 4 — tool cards", () => {
  it("passes on the right card", () => {
    expect(judgeToolCard(outcome({ toolAnswered: true, toolCardText: "18% of 62.50 = 11.25", receipts: [] }), "= 11.25")).toEqual({
      result: "PASS",
      evidence: "card: 18% of 62.50 = 11.25",
    });
  });

  it("fails on a wrong card, and on no card at all", () => {
    expect(judgeToolCard(outcome({ toolAnswered: true, toolCardText: "18% of 62.50 = 12", receipts: [] }), "= 11.25")).toEqual({
      result: "FAIL",
      evidence: 'card: 18% of 62.50 = 12 (expected "= 11.25")',
    });
    expect(judgeToolCard(outcome({ replyText: "It is 11.25." }), "= 11.25")).toEqual({
      result: "FAIL",
      evidence: "no tool fired — the model answered instead: It is 11.25.",
    });
  });
});

describe("task 5 — draft, then shorter", () => {
  it("records the draft and checks the shortening", () => {
    const first = outcome({ replyText: "Dear landlord, the tap drips." });
    expect(judgeDraft(first)).toEqual({
      result: "RECORDED",
      evidence: "draft (29 chars): Dear landlord, the tap drips.",
    });
    expect(judgeShorter(first, outcome({ replyText: "Tap drips." }))).toEqual({
      result: "PASS",
      evidence: "10 chars vs 29; reply: Tap drips.",
    });
    expect(judgeShorter(first, outcome({ replyText: "Dear landlord, the kitchen tap drips." })).result).toBe("FAIL");
  });
});

describe("task 6 — the context boundary", () => {
  it("passes once the app says so, and records the turns before", () => {
    expect(judgeContextTurn(outcome(), true, "Older messages are out of view.")).toEqual({
      result: "PASS",
      evidence: "the app says: Older messages are out of view.",
    });
    expect(judgeContextTurn(outcome(), false, "")).toEqual({
      result: "RECORDED",
      evidence: "no boundary shown yet; promptTokens=120",
    });
    expect(judgeContextNeverShown(6)).toEqual({
      result: "RECORDED",
      evidence: "6 pastes of 4392 chars did not surface a divider or notice",
    });
  });
});

describe("task 7 — offline reload", () => {
  it("passes when the offline turn answered, and fails with the worker state when not", () => {
    expect(
      judgeOfflineReload({ usable: true, detail: "reply offline: Yes.", controlling: true, captured: true, capturedAfterS: 2 }),
    ).toEqual({
      result: "PASS",
      evidence: "worker controlling: yes; shell captured: yes (2 s); reply offline: Yes.",
    });
    expect(
      judgeOfflineReload({ usable: false, detail: "net::ERR_INTERNET_DISCONNECTED", controlling: false, captured: false, capturedAfterS: 30 }),
    ).toEqual({
      result: "FAIL",
      evidence:
        "offline reload did not reach a working chat (worker controlling: no; shell captured: no (30 s timeout)): net::ERR_INTERNET_DISCONNECTED",
    });
  });
});

describe("task 8 — switching truthfully", () => {
  const label = "Model: running Eco Compact (Qwen)";
  it("passes when the label and the next receipt both name the target", () => {
    expect(judgeSwitch(label, outcome({ receipts: [receipt({ modelId: ECO_COMPACT_WEBLLM.modelId })] }), ECO_COMPACT_WEBLLM)).toEqual({
      result: "PASS",
      evidence: 'switcher says "Model: running Eco Compact (Qwen)"; the receipt says candidate/qwen3-0.6b-mlc-q0f16',
    });
  });

  it("fails when the runtime ran something else, or nothing", () => {
    expect(judgeSwitch(label, outcome(), ECO_COMPACT_WEBLLM)).toEqual({
      result: "FAIL",
      evidence: 'switcher says "Model: running Eco Compact (Qwen)"; the receipt says candidate/lfm2.5-1.2b-instruct-onnx',
    });
    expect(judgeSwitch("Model: running Eco Fast (Liquid)", noGeneration(), ECO_COMPACT_WEBLLM)).toEqual({
      result: "FAIL",
      evidence: 'switcher says "Model: running Eco Fast (Liquid)"; the receipt says no generation',
    });
  });
});

describe("task 9 — web lookups off, then on", () => {
  const reply = outcome({ replyText: "Mary Shelley." });
  it("records a quiet off arm and fails a leaky one", () => {
    expect(judgeLookupsOff(reply, false, [])).toEqual({
      result: "RECORDED",
      evidence: "no source card, no request left the device; the answer reads: Mary Shelley.",
    });
    expect(judgeLookupsOff(reply, false, ["https://en.wikipedia.org/x"])).toEqual({
      result: "FAIL",
      evidence: "lookups are off, yet 1 request(s) left the device and no card appeared",
    });
    expect(judgeLookupsOff(reply, true, []).evidence).toBe(
      "lookups are off, yet 0 request(s) left the device and a source card appeared",
    );
  });

  it("passes on a card, fails on none when the setting is on, and records it when the setting did not take", () => {
    const requests = ["https://en.wikipedia.org/w/rest.php/v1/search/page?q=Frankenstein"];
    expect(judgeLookupsOn(reply, 1, true, requests)).toEqual({
      result: "PASS",
      evidence:
        "1 source card(s); setting read back as ON; 1 lookup request(s) (first: https://en.wikipedia.org/w/rest.php/v1/search/page?q=Frankenstein); answer: Mary Shelley.",
    });
    expect(judgeLookupsOn(reply, 0, true, [])).toEqual({
      result: "FAIL",
      evidence: "NO source card. setting read back as ON; 0 lookup request(s); answer: Mary Shelley.",
    });
    expect(judgeLookupsOn(reply, 0, false, []).result).toBe("RECORDED");
  });
});

describe("task 10 — reopen after a mid-reply kill", () => {
  it("passes on a reply and fails on none", () => {
    expect(judgeReopened(outcome({ replyText: "Yes." }))).toEqual({
      result: "PASS",
      evidence: "reply after reopening: Yes.",
    });
    expect(judgeReopened(outcome({ replyText: "" })).result).toBe("FAIL");
  });
});

describe("task 11 — Web search off, then on", () => {
  const off = outcome({ replyText: "I can't check live weather." });
  const on = outcome({
    replyText: "Light rain is falling.",
    receipts: [receipt({ systemPromptHash: "hash-on" })],
  });

  it("passes the off arm only with the note, no request and no chip", () => {
    expect(judgeSearchOff(off, { notes: 1, calls: [], chips: 0, settledOff: false })).toEqual({
      result: "PASS",
      evidence:
        "no-live-data note shown, 0 search requests, no chip; setting read back as OFF; answer: I can't check live weather.",
    });
    expect(
      judgeSearchOff(off, { notes: 1, calls: [{ method: "POST", body: '{"q":"x"}' }], chips: 0, settledOff: false }),
    ).toEqual({
      result: "FAIL",
      evidence:
        "expected the no-live-data note and no request: 1 note(s), 1 search request(s), 0 chip(s); answer: I can't check live weather.",
    });
  });

  it("passes one POST carrying only the question", () => {
    expect(
      judgeSearchRequest({ calls: [{ method: "POST", body: '{"q":"is it raining"}' }], settledOn: true, composerSwitch: "true" }),
    ).toEqual({
      result: "PASS",
      evidence: "1 request(s) to the relay; method POST; body keys [q]; setting read back as ON, composer switch aria-checked=true",
    });
  });

  it("fails a body with a second key, an unparsed body, or two requests — and records it when the setting did not take", () => {
    expect(
      judgeSearchRequest({ calls: [{ method: "POST", body: '{"q":"x","conversation":"y"}' }], settledOn: true, composerSwitch: "true" }),
    ).toEqual({
      result: "FAIL",
      evidence:
        "1 request(s) to the relay; method POST; body keys [conversation, q]; setting read back as ON, composer switch aria-checked=true",
    });
    expect(judgeSearchRequest({ calls: [{ method: "POST", body: "q=x" }], settledOn: true, composerSwitch: "true" }).evidence).toBe(
      "1 request(s) to the relay; method POST; body keys [] (unparsed); setting read back as ON, composer switch aria-checked=true",
    );
    const twice = { method: "POST", body: '{"q":"x"}' };
    expect(judgeSearchRequest({ calls: [twice, twice], settledOn: true, composerSwitch: "true" }).result).toBe("FAIL");
    expect(judgeSearchRequest({ calls: [], settledOn: false, composerSwitch: "(absent)" })).toEqual({
      result: "RECORDED",
      evidence:
        "0 request(s) to the relay; method (none); body keys [] (unparsed); setting read back as OFF, composer switch aria-checked=(absent)",
    });
  });

  it("passes the chip only with the stub's fetched-at", () => {
    expect(judgeSearchChip(off, on, { chipCount: 1, fetchedAt: WEB_SEARCH_STUB_FETCHED_AT, settledOn: true })).toEqual({
      result: "PASS",
      evidence:
        "1 chip(s), data-fetched-at 2026-09-11T14:32:00.000Z; system prompt hash hash-off → hash-on (changed, so the searched turn carried a different system prompt); answer: Light rain is falling.",
    });
    expect(judgeSearchChip(off, off, { chipCount: 0, fetchedAt: null, settledOn: true })).toEqual({
      result: "FAIL",
      evidence:
        "0 chip(s), data-fetched-at (absent); system prompt hash hash-off → hash-off (unchanged or unknown); answer: I can't check live weather.",
    });
    expect(judgeSearchChip(off, on, { chipCount: 1, fetchedAt: "2026-01-01T00:00:00.000Z", settledOn: true }).result).toBe(
      "FAIL",
    );
    expect(judgeSearchChip(off, on, { chipCount: 0, fetchedAt: null, settledOn: false }).result).toBe("RECORDED");
  });
});

describe("task 12 — Stop mid-reply", () => {
  it("fails when Stop could not be pressed", () => {
    expect(judgeStopNotPressed("the reply finished before Stop could be pressed")).toEqual({
      result: "FAIL",
      evidence:
        "the reply finished before Stop could be pressed; nothing was stopped, so this task says nothing about Stop",
    });
  });

  it("passes a stopped reply that kept its words, says so, offers Try again and is recorded aborted", () => {
    const stopped = outcome({ receipts: [receipt({ status: "aborted" })] });
    expect(
      judgeStopped(stopped, { settledMs: 140, noticeText: "Stopped", tryAgainOffered: true, kept: "The Roman Empire" }),
    ).toEqual({
      result: "PASS",
      evidence: 'composer back 140 ms after Stop; recorded as \'aborted\'; notice: "Stopped"; 16 chars kept on screen',
    });
  });

  it("fails a stop recorded as complete, with no notice and nothing kept", () => {
    expect(judgeStopped(outcome(), { settledMs: 90, noticeText: "", tryAgainOffered: true, kept: "" })).toEqual({
      result: "FAIL",
      evidence:
        "composer back 90 ms after Stop; recorded as 'complete' (a stopped reply should be 'aborted'); notice: MISSING; the partial reply is GONE",
    });
    const stopped = outcome({ receipts: [receipt({ status: "aborted" })] });
    expect(
      judgeStopped(stopped, { settledMs: 90, noticeText: "Stopped", tryAgainOffered: false, kept: "Rome" }).result,
    ).toBe("FAIL");
    expect(judgeStopped(noGeneration(), { settledMs: 90, noticeText: "", tryAgainOffered: false, kept: "" }).evidence).toBe(
      "composer back 90 ms after Stop; recorded as '(no receipt)' (a stopped reply should be 'aborted'); notice: MISSING; the partial reply is GONE",
    );
  });
});

describe("task 13 — a failed reply, then Try again", () => {
  const injected = outcome({ receipts: [receipt({ status: "error", errorCode: INJECTED_FAULT_MESSAGE })] });

  it("passes the injected failure when it fired once and Try again is offered", () => {
    expect(judgeInjectedFailure(injected, { stillArmed: false, offered: true, card: "Something went wrong. Try again" })).toEqual({
      ourFault: true,
      result: "PASS",
      evidence:
        'failed with the injected fault; fault fired once; the person sees: "Something went wrong. Try again"',
    });
  });

  it("fails a genuine failure, a fault still armed, or no Try again", () => {
    const genuine = outcome({ receipts: [receipt({ status: "error", errorCode: "GPU device lost" })] });
    expect(judgeInjectedFailure(genuine, { stillArmed: true, offered: false, card: "" })).toEqual({
      ourFault: false,
      result: "FAIL",
      evidence:
        "expected the injected fault, got 'error' (GPU device lost); the fault is STILL armed (it should fire once); NO Try again is offered",
    });
    expect(judgeInjectedFailure(outcome(), { stillArmed: false, offered: true, card: "x" }).evidence).toBe(
      'expected the injected fault, got \'complete\'; fault fired once; the person sees: "x"',
    );
    expect(judgeInjectedFailure(injected, { stillArmed: true, offered: true, card: "x" })).toMatchObject({
      ourFault: true,
      result: "FAIL",
    });
  });

  it("passes a retry that answered once, in place", () => {
    const retried = outcome({ replyText: "Read a book." });
    expect(judgeRetry(retried, { ok: true, why: "" }, { askedOnce: true, replacedInPlace: true })).toEqual({
      result: "PASS",
      evidence: `answered; the question shows once; the answer replaced the failed reply; ${COUNTS}; reply: Read a book.`,
    });
  });

  it("fails a retry that duplicated the question or left the failed reply", () => {
    const retried = outcome({ replyText: "Read a book." });
    expect(judgeRetry(retried, { ok: true, why: "" }, { askedOnce: false, replacedInPlace: false })).toEqual({
      result: "FAIL",
      evidence: `answered; the question is DUPLICATED in the transcript; the failed reply was NOT replaced; ${COUNTS}; reply: Read a book.`,
    });
    expect(
      judgeRetry(retried, { ok: false, why: "no generation ran" }, { askedOnce: true, replacedInPlace: true }).result,
    ).toBe("FAIL");
  });
});

describe("task 14 — edit an earlier message", () => {
  const clean = { userTexts: [EDIT_REPLACEMENT_PROMPT], oneReply: true, versionsShown: true };
  const SYSTEM = { role: "system" as const, content: "You are Eco." };
  /** The harness record of what the model was sent, system prompt first. */
  const sentOf = (...messages: { role: "user" | "assistant"; content: string }[]): SentMessages => ({
    seq: 3,
    modelId: "local/model",
    messages: [SYSTEM, ...messages],
  });

  it("passes an edit answered from the edited text", () => {
    const edited = outcome({
      storedUserText: EDIT_REPLACEMENT_PROMPT,
      replyText: "Hello, Tomas!",
      sent: sentOf({ role: "user", content: EDIT_REPLACEMENT_PROMPT }),
    });
    expect(judgeEdit(edited, { ok: true, why: "" }, clean)).toEqual({
      result: "PASS",
      evidence:
        "answered; the transcript shows the edited message; the later exchange left the transcript; one reply; the earlier version is one tap away; storage holds the edit; the model was sent the edit and nothing from before it; the reply uses the edited name; reply: Hello, Tomas!",
    });
  });

  it("fails when what the model was sent could not be read, though everything else holds", () => {
    // The blind spot this witness closes: a nameless reply used to pass with
    // the edit's content unchecked. A missing record now fails the row.
    const edited = outcome({ storedUserText: EDIT_REPLACEMENT_PROMPT, replyText: "Hello!" });
    const verdict = judgeEdit(edited, { ok: true, why: "" }, clean);
    expect(verdict.result).toBe("FAIL");
    expect(verdict.evidence).toContain("what the model was sent could NOT be read, so the edit's content is unchecked");
  });

  it("fails a reply generated from the discarded text, whatever the screen shows", () => {
    expect(judgeEdit(outcome({ replyText: "Hello, Priya!" }), { ok: true, why: "" }, clean)).toEqual({
      result: "FAIL",
      evidence:
        "answered; the transcript shows the edited message; the later exchange left the transcript; one reply; the earlier version is one tap away; storage holds the edit; what the model was sent could NOT be read, so the edit's content is unchecked; the reply uses the name from BEFORE the edit, so it was generated from the discarded text; reply: Hello, Priya!",
    });
  });

  it("fails when the screen or storage did not take the edit", () => {
    const edited = outcome({ storedUserText: EDIT_ORIGINAL_PROMPT, replyText: "Hello, Tomas!" });
    const observed = {
      userTexts: [EDIT_ORIGINAL_PROMPT, "Suggest one name for a pet goldfish."],
      oneReply: false,
      versionsShown: false,
    };
    expect(judgeEdit(edited, { ok: true, why: "" }, observed)).toEqual({
      result: "FAIL",
      evidence:
        'answered; the transcript shows ["My name is Priya. Say hello to me by na…","Suggest one name for a pet goldfish."]; the later exchange is STILL showing; more than one reply is showing; NO way back to the earlier version; storage holds "My name is Priya. Say hello to me by name, in one short sen…"; what the model was sent could NOT be read, so the edit\'s content is unchecked; the reply uses the edited name; reply: Hello, Tomas!',
    });
  });

  it("passes an edit the model was sent, and no longer calls a nameless reply unchecked", () => {
    const edited = outcome({
      storedUserText: EDIT_REPLACEMENT_PROMPT,
      replyText: "Hello there!",
      sent: sentOf({ role: "user", content: EDIT_REPLACEMENT_PROMPT }),
    });
    const verdict = judgeEdit(edited, { ok: true, why: "" }, clean);
    expect(verdict.result).toBe("PASS");
    expect(verdict.evidence).toContain(
      "storage holds the edit; the model was sent the edit and nothing from before it; the reply did not use a name; reply: Hello there!",
    );
  });

  it("fails an edit whose model was sent the text from before it, though the reply uses no name", () => {
    // The planted "edit ignored" defect: the screen and storage show the edit,
    // the model is sent the original, and the reply names nobody.
    const edited = outcome({
      storedUserText: EDIT_REPLACEMENT_PROMPT,
      replyText: "Hello there!",
      sent: sentOf({ role: "user", content: EDIT_ORIGINAL_PROMPT }),
    });
    const verdict = judgeEdit(edited, { ok: true, why: "" }, clean);
    expect(verdict.result).toBe("FAIL");
    expect(verdict.evidence).toContain("the model was sent the text from before the edit");
  });

  it("fails when the original reaches the model in an earlier message, even with the edit last", () => {
    const edited = outcome({
      storedUserText: EDIT_REPLACEMENT_PROMPT,
      replyText: "Hello, Tomas!",
      sent: sentOf(
        { role: "user", content: EDIT_ORIGINAL_PROMPT },
        { role: "assistant", content: "Hello, Priya!" },
        { role: "user", content: EDIT_REPLACEMENT_PROMPT },
      ),
    });
    const verdict = judgeEdit(edited, { ok: true, why: "" }, clean);
    expect(verdict.result).toBe("FAIL");
    expect(verdict.evidence).toContain("the model was sent the text from before the edit");
  });

  it("fails when the model was sent something other than the edit", () => {
    const edited = outcome({
      storedUserText: EDIT_REPLACEMENT_PROMPT,
      replyText: "Hello, Tomas!",
      sent: sentOf({ role: "user", content: "Suggest one name for a pet goldfish." }),
    });
    const verdict = judgeEdit(edited, { ok: true, why: "" }, clean);
    expect(verdict.result).toBe("FAIL");
    expect(verdict.evidence).toContain('the model was sent "Suggest one name for a pet goldfish.", not the edit');
  });

  it("accepts the edit with a directive or recap after a blank line", () => {
    const edited = outcome({
      storedUserText: EDIT_REPLACEMENT_PROMPT,
      replyText: "Hello, Tomas!",
      sent: sentOf({ role: "user", content: `${EDIT_REPLACEMENT_PROMPT}\n\nKeep it short.` }),
    });
    const verdict = judgeEdit(edited, { ok: true, why: "" }, clean);
    expect(verdict.result).toBe("PASS");
    expect(verdict.evidence).toContain("the model was sent the edit and nothing from before it");
  });

  it("fails the recall when its model was sent the name from before the edit", () => {
    const recall = outcome({
      replyText: "I don't know your name.",
      sent: sentOf(
        { role: "user", content: EDIT_REPLACEMENT_PROMPT },
        { role: "assistant", content: "Hello, Priya!" },
        { role: "user", content: "What is my name?" },
      ),
    });
    expect(judgeRecall(recall)).toEqual({
      result: "FAIL",
      evidence: `the model was sent the name from BEFORE the edit, so the discarded text reached the model; the model did not recall either name — a recall reading, not an edit failure; ${COUNTS}; reply: I don't know your name.`,
    });
  });

  it("fails the recall when what it was sent does not carry the edit", () => {
    const recall = outcome({
      replyText: "I don't know your name.",
      sent: sentOf({ role: "user", content: "What is my name?" }),
    });
    const verdict = judgeRecall(recall);
    expect(verdict.result).toBe("FAIL");
    expect(verdict.evidence).toContain("the conversation sent for the recall does not carry the edit");
  });

  it("records a recall that was sent the edit and named nobody", () => {
    const recall = outcome({
      replyText: "I don't know your name.",
      sent: sentOf(
        { role: "user", content: EDIT_REPLACEMENT_PROMPT },
        { role: "assistant", content: "Hello, Tomas!" },
        { role: "user", content: "What is my name?" },
      ),
    });
    expect(judgeRecall(recall)).toEqual({
      result: "RECORDED",
      evidence: `what was sent carries the edit; the model did not recall either name — a recall reading, not an edit failure; ${COUNTS}; reply: I don't know your name.`,
    });
  });

  it("judges the recall three ways", () => {
    expect(judgeRecall(outcome({ replyText: "Your name is Tomas." }))).toEqual({
      result: "PASS",
      evidence: `what was sent could not be read; the reply uses the edited name; ${COUNTS}; reply: Your name is Tomas.`,
    });
    expect(judgeRecall(outcome({ replyText: "Your name is Priya." }))).toEqual({
      result: "FAIL",
      evidence: `what was sent could not be read; the reply uses the name from BEFORE the edit, so the discarded text reached the model; ${COUNTS}; reply: Your name is Priya.`,
    });
    expect(judgeRecall(outcome({ replyText: "I don't know your name." }))).toEqual({
      result: "RECORDED",
      evidence: `what was sent could not be read; the model did not recall either name — a recall reading, not an edit failure; ${COUNTS}; reply: I don't know your name.`,
    });
  });
});
