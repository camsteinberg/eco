// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * What the acceptance walk asks and how it judges the answers, with no browser
 * in sight.
 *
 * Every prompt, expected value, threshold and verdict rule lives here, as
 * plain data and pure functions over what a task observed. The walk itself
 * (`../acceptance.spec.ts`) is the hands: it drives a real browser, reads the
 * page and the receipts, and hands those observations to a judge. Keeping the
 * two apart is what lets a walk in another browser, driven another way, reach
 * the same verdicts by the same rules instead of a copy that drifts.
 *
 * Each judge returns the row's verdict and evidence exactly as the walk has
 * always written them; `__tests__/tasks.test.ts` pins both.
 *
 * Nothing here may import the walk or the Playwright helpers (`./walk`): this
 * module is the shared ground both depend on.
 */

import { VALIDATION_GENERATION_FAULT_MESSAGE } from "../../src/lib/validation-harness";
import type { SentMessages } from "../../src/local-ai/diagnostics/sent-messages";
import type { GenerationReceipt } from "../../src/local-ai/lifecycle/generation-receipt";
import { clip, type RowResult } from "./report";

export type SlotName = "eco-fast" | "eco-smart";

export type Pick = {
  /** Catalog id. */
  modelId: string;
  /** The slot this model is the shipping choice for. */
  slot: SlotName;
  /** The name on its tile in the model switcher. */
  tileName: string;
  /** The name the switcher trigger's accessible label uses. */
  friendlyName: string;
};

/**
 * The two shipping picks, one per slot. Ids and slots come from the catalog
 * (`local-ai/catalog/catalog-data.json`); the tile names are the curated
 * welcome copy the switcher shows, and the friendly names are the branded
 * names the switcher's accessible label uses — the catalog's `display`
 * block, not its raw `friendlyName`, which is the model's technical name and
 * never reaches the UI.
 */
export const ECO_FAST: Pick = {
  modelId: "candidate/lfm2.5-1.2b-instruct-onnx",
  slot: "eco-fast",
  tileName: "Eco Fast",
  friendlyName: "Eco Fast (Liquid)",
};
export const ECO_DEEPER: Pick = {
  modelId: "candidate/lfm2-2.6b-onnx",
  slot: "eco-smart",
  tileName: "Eco Deeper",
  friendlyName: "Eco Deeper (Liquid)",
};

/**
 * The two models the app serves desktop Safari, both on WebLLM: Eco Compact
 * first, Eco Mobile as its fallback. Each is walked alone in the everyday slot,
 * the slot a desktop-Safari device fills first.
 */
export const ECO_COMPACT_WEBLLM: Pick = {
  modelId: "candidate/qwen3-0.6b-mlc-q0f16",
  slot: "eco-fast",
  tileName: "Eco Compact",
  friendlyName: "Eco Compact (Qwen)",
};
export const ECO_MOBILE_WEBLLM: Pick = {
  modelId: "candidate/qwen2.5-0.5b-mlc",
  slot: "eco-fast",
  tileName: "Eco Mobile",
  friendlyName: "Eco Mobile (Qwen)",
};

export type TurnOutcome = {
  prompt: string;
  /** What the app STORED as the user's message. Judge a reply only against this. */
  storedUserText: string | null;
  replyText: string;
  replySource: "indexeddb" | "dom";
  /** Every receipt this turn produced, in execution order. Empty on a tool answer. */
  receipts: GenerationReceipt[];
  /** True when the turn was answered by a deterministic tool, not by generation. */
  toolAnswered: boolean;
  /** The exact-answer card's text when the turn produced one. */
  toolCardText: string | null;
  /**
   * What the chat handed the runtime for this turn's final generation. Null
   * when it was not read (the final receipt is not `complete`) or could not be.
   */
  sent: SentMessages | null;
};

/** The receipt whose output the person saw, or null on a tool-answered turn. */
export function outcomeReceipt(outcome: TurnOutcome): GenerationReceipt | null {
  return outcome.receipts[outcome.receipts.length - 1] ?? null;
}

export function kvReasonOf(receipt: GenerationReceipt | null): string | null {
  const kv = receipt?.kvReuse;
  if (!kv) return null;
  return kv.reason ? `${kv.decision}/${kv.reason}` : kv.decision;
}

/** A row's verdict and the evidence it rests on. */
export type Verdict = { result: RowResult; evidence: string };

// ── Timings ────────────────────────────────────────────────────────────────

/** A long generation, so there is time to kill the tab mid-reply (task 10). */
export const LONG_TURN_TIMEOUT_MS = 480_000;

/**
 * The slowest first token a reply after a Stop or a retry may take and still
 * count as answered. Measured after the fix, those first tokens arrive in well
 * under two seconds; the defect this guards against never produced one, and
 * the chat gave up after 90 s. Thirty seconds separates the two with room.
 */
export const FIRST_TOKEN_CEILING_MS = 30_000;

/** How long a stopped turn gets to record its receipt. */
export const STOPPED_RECEIPT_TIMEOUT_MS = 30_000;

// ── Shared evidence ────────────────────────────────────────────────────────

/**
 * The numeric side of one turn, for the evidence column: what the prompt and
 * reply cost, what the KV gate saw, and where the history window started.
 *
 * A ten-turn chat that loses a figure is only diagnosable with these: the same
 * `windowStart` as the previous turn with an `equal-or-shorter` miss is
 * re-tokenization, a moved `windowStart` is eviction, and the decoded
 * divergence says which tokens differed. Missing fields print as `?` rather
 * than being omitted, so the columns line up across turns.
 */
export function turnCounts(outcome: TurnOutcome): string {
  const receipt = outcomeReceipt(outcome);
  const kv = receipt?.kvReuse;
  const parts = [
    `prompt=${receipt?.promptTokens ?? "?"}`,
    `completion=${receipt?.completionTokens ?? "?"}`,
    `cachedLen=${kv?.cachedLen ?? "?"}`,
    `promptLen=${kv?.promptLen ?? "?"}`,
    `commonPrefix=${kv?.commonPrefixLen ?? "-"}`,
    `durationMs=${receipt?.durationMs ?? "?"}`,
    `windowStart=${receipt?.windowStartIndex ?? "?"}`,
  ];
  const divergence = kv?.divergence;
  if (divergence) {
    parts.push(
      `DIV cached=${JSON.stringify(clip(divergence.cached, 80))}`,
      `next=${JSON.stringify(clip(divergence.next, 80))}`,
    );
  }
  return parts.join(" ");
}

const contains = (text: string, ...needles: string[]): boolean =>
  needles.some((needle) => text.includes(needle));

/**
 * Did this turn answer, the way a person would judge it: a reply that
 * finished, whose first words came promptly, with no error card. Each
 * reason it did not is named, so a FAIL row says what went wrong.
 *
 * `errorCardShowing` is the one thing read from the page: whether the reply's
 * bubble carries an alert.
 */
export function judgeAnswered(
  outcome: TurnOutcome,
  errorCardShowing: boolean,
): { ok: boolean; why: string } {
  const receipt = outcomeReceipt(outcome);
  const problems: string[] = [];
  if (!receipt) {
    problems.push("no generation ran");
  } else {
    if (receipt.status !== "complete") {
      problems.push(
        `the reply ended '${receipt.status}'${
          receipt.errorCode ? ` (${clip(receipt.errorCode, 90)})` : ""
        }`,
      );
    }
    if (receipt.firstTokenMs == null) {
      problems.push("no first word ever arrived");
    } else if (receipt.firstTokenMs > FIRST_TOKEN_CEILING_MS) {
      problems.push(
        `the first word took ${Math.round(receipt.firstTokenMs)} ms (ceiling ${FIRST_TOKEN_CEILING_MS} ms)`,
      );
    }
  }
  if (errorCardShowing) {
    problems.push("an error card is showing");
  }
  if (outcome.replyText.trim().length === 0) problems.push("the reply is empty");
  return { ok: problems.length === 0, why: problems.join("; ") };
}

/** The row for a message that has to answer after a Stop or a retry (12.2, 13.3). */
export function judgeFollowUp(
  outcome: TurnOutcome,
  check: { ok: boolean; why: string },
): Verdict {
  return {
    result: check.ok ? "PASS" : "FAIL",
    evidence: `${check.ok ? "answered" : `did NOT answer: ${check.why}`}; ${turnCounts(outcome)}; reply: ${clip(
      outcome.replyText,
    )}`,
  };
}

// ── 1. Cold first run ──────────────────────────────────────────────────────

export const FIRST_RUN_PROMPT = "Hi — what can you help me with?";

export function judgeFirstReply(outcome: TurnOutcome, toChatMs: number): Verdict {
  return {
    result: outcome.replyText.trim().length > 0 ? "PASS" : "FAIL",
    evidence: `chat usable in ${toChatMs} ms, no setup error surface; reply: ${clip(
      outcome.replyText,
    )}`,
  };
}

// ── 2. Ten-turn budgeting chat ─────────────────────────────────────────────

/** The ten-turn budgeting conversation. Turn 5 checks a running total, turn 10 a recall. */
export const BUDGET_TURNS: readonly string[] = [
  "I want to get my monthly budget under control.",
  "My rent is $1,450 a month and I take home about $3,200.",
  "Groceries run me around $400, and I spend $120 on transit.",
  "My phone and internet come to $95 together.",
  "Adding those up, what am I spending each month so far?",
  "I'd like to put $300 into savings every month.",
  "Does that still leave me anything?",
  "What would you cut first?",
  "Give me one habit that would help me stick to this.",
  "What was my rent again?",
];

/** Turn numbers inside task 2 that carry a mechanical check. */
export const RUNNING_TOTAL_TURN = 5;
export const RENT_RECALL_TURN = 10;

/** One budgeting turn (1-based). Most turns are RECORDED; turns 5 and 10 carry a check. */
export function judgeBudgetTurn(turn: number, prompt: string, outcome: TurnOutcome): Verdict {
  const stored = outcome.storedUserText;
  // The input can be the defect. A reply is only evidence about the
  // model if the app stored the sentence we meant to send.
  const inputIntact = stored === null || stored.trim() === prompt.trim();
  let result: RowResult = "RECORDED";
  // The counts are the point of this task as an instrument: a lost
  // figure is diagnosable only alongside what the window held and
  // whether the cache was reused on the turn that lost it.
  const counts = turnCounts(outcome);
  let evidence = `${counts}; reply: ${clip(outcome.replyText)}`;
  if (!inputIntact) {
    result = "FAIL";
    evidence = `stored input differs from what was typed: ${clip(stored ?? "")}`;
  } else if (turn === RUNNING_TOTAL_TURN) {
    const ok = contains(outcome.replyText, "2,065", "2065");
    result = ok ? "PASS" : "FAIL";
    evidence = `${counts}; running total 2,065 ${ok ? "present" : "absent"}; reply: ${clip(
      outcome.replyText,
    )}`;
  } else if (turn === RENT_RECALL_TURN) {
    const ok = contains(outcome.replyText, "1,450", "1450");
    result = ok ? "PASS" : "FAIL";
    evidence = `${counts}; rent figure from turn 2 ${ok ? "recalled" : "lost"}; reply: ${clip(
      outcome.replyText,
    )}`;
  }
  return { result, evidence };
}

// ── 3. Paste ~2 pages, ask for a summary ───────────────────────────────────

/** ~4,400 chars ≈ 1,100 estimator-tokens. Plain prose, not a token-stuffer. */
export const PASTE_BLOCK = (
  "The greenhouse effect of a well-tended garden is easy to underestimate. "
  + "Raised beds warm earlier in the year than open ground, and a gardener who "
  + "plans the season around that difference can start harvesting weeks ahead of "
  + "the almanac. Companion planting matters too: beans fix nitrogen that heavy "
  + "feeders like squash consume, while marigolds keep certain pests away from "
  + "tomatoes. Water management is the quiet discipline underneath all of it — "
  + "deep, infrequent watering trains roots downward, while daily sprinkling "
  + "keeps them shallow and fragile. "
).repeat(8);

export const SUMMARY_PROMPT = `${PASTE_BLOCK}\n\nSummarise the text above in a few sentences.`;

export function judgeSummary(outcome: TurnOutcome): Verdict {
  const shorter = outcome.replyText.length < PASTE_BLOCK.length;
  return {
    result: shorter && outcome.replyText.trim().length > 0 ? "RECORDED" : "FAIL",
    evidence: `${outcome.replyText.length} chars back from ${PASTE_BLOCK.length} in; summary: ${clip(
      outcome.replyText,
      240,
    )}`,
  };
}

// ── 4. The exact-answer tools ──────────────────────────────────────────────

export const TOOL_CASES: readonly { prompt: string; expect: string }[] = [
  { prompt: "What's 18% of $62.50", expect: "= 11.25" },
  { prompt: "what date is 6 weeks from today", expect: "6 weeks from today is" },
];

export function judgeToolCard(outcome: TurnOutcome, expected: string): Verdict {
  const card = outcome.toolCardText ?? "";
  const ok = outcome.toolAnswered && card.includes(expected);
  return {
    result: ok ? "PASS" : "FAIL",
    evidence: outcome.toolAnswered
      ? `card: ${clip(card)}${card.includes(expected) ? "" : ` (expected "${expected}")`}`
      : `no tool fired — the model answered instead: ${clip(outcome.replyText)}`,
  };
}

// ── 5. Draft an email, then shorten it ─────────────────────────────────────

export const EMAIL_BRIEF = [
  "Draft a short email to my landlord from these three points:",
  "- the kitchen tap has been dripping for a week",
  "- I am home on Thursday afternoon",
  "- ask when a plumber can come",
].join("\n");

export const SHORTER_PROMPT = "Can you make that shorter?";

export function judgeDraft(first: TurnOutcome): Verdict {
  return {
    result: "RECORDED",
    evidence: `draft (${first.replyText.length} chars): ${clip(first.replyText, 240)}`,
  };
}

export function judgeShorter(first: TurnOutcome, second: TurnOutcome): Verdict {
  const shorter = second.replyText.length < first.replyText.length;
  return {
    result: shorter ? "PASS" : "FAIL",
    evidence: `${second.replyText.length} chars vs ${first.replyText.length}; reply: ${clip(
      second.replyText,
      240,
    )}`,
  };
}

// ── 6. Long chat until the context boundary is admitted ────────────────────

export const CONTEXT_MAX_TURNS = 6;

export const CONTEXT_PROMPT = `${PASTE_BLOCK}\nBriefly, what is this text about?`;

/** One paste turn: PASS once the app admits the boundary, RECORDED until then. */
export function judgeContextTurn(
  outcome: TurnOutcome,
  announced: boolean,
  copy: string,
): Verdict {
  return {
    result: announced ? "PASS" : "RECORDED",
    evidence: announced
      ? `the app says: ${clip(copy)}`
      : `no boundary shown yet; promptTokens=${
          outcomeReceipt(outcome)?.promptTokens ?? "?"
        }`,
  };
}

/** The closing row when no paste surfaced a divider or a notice. */
export function judgeContextNeverShown(maxTurns: number): Verdict {
  return {
    result: "RECORDED",
    evidence: `${maxTurns} pastes of ${PASTE_BLOCK.length} chars did not surface a divider or notice`,
  };
}

// ── 7. Offline reload ──────────────────────────────────────────────────────

export const OFFLINE_PROMPT = "Still working offline?";

export type OfflineObservation = {
  /** A turn sent after the offline reload got a reply. */
  usable: boolean;
  /** The reply, or why the walk never got one. */
  detail: string;
  /** The service worker was controlling the tab after the online reload. */
  controlling: boolean;
  /** The chat shell was in the worker's cache before going offline. */
  captured: boolean;
  capturedAfterS: number;
};

export function judgeOfflineReload(observed: OfflineObservation): Verdict {
  const state = `worker controlling: ${observed.controlling ? "yes" : "no"}; `
    + `shell captured: ${observed.captured ? `yes (${observed.capturedAfterS} s)` : "no (30 s timeout)"}`;
  return {
    result: observed.usable ? "PASS" : "FAIL",
    evidence: observed.usable
      ? `${state}; ${observed.detail}`
      : `offline reload did not reach a working chat (${state}): ${observed.detail}`,
  };
}

// ── 8. Switch between models ───────────────────────────────────────────────

export const SWITCH_PROMPT = "In one line, say hello.";
export const SWITCH_BACK_PROMPT = "In one line, say hello again.";

/** Truthful means the switcher names the target AND the next receipt ran it. */
export function judgeSwitch(label: string, outcome: TurnOutcome, target: Pick): Verdict {
  const receipt = outcomeReceipt(outcome);
  const truthful = label.includes(target.friendlyName) && receipt?.modelId === target.modelId;
  return {
    result: truthful ? "PASS" : "FAIL",
    evidence: `switcher says "${clip(label, 80)}"; the receipt says ${
      receipt?.modelId ?? "no generation"
    }`,
  };
}

// ── 9. A factual question, lookups off then on ─────────────────────────────

export const LOOKUP_QUESTION = "Who wrote the novel Frankenstein?";

/** Lookups off: a source card, or any request to the sources, is a FAIL. */
export function judgeLookupsOff(
  outcome: TurnOutcome,
  sourceCardShown: boolean,
  requests: readonly string[],
): Verdict {
  const leaked = sourceCardShown || requests.length > 0;
  return {
    result: leaked ? "FAIL" : "RECORDED",
    evidence: leaked
      ? `lookups are off, yet ${requests.length} request(s) left the device and `
        + `${sourceCardShown ? "a source card appeared" : "no card appeared"}`
      : `no source card, no request left the device; the answer reads: ${clip(
          outcome.replyText,
          220,
        )}`,
  };
}

/** Lookups on: a source card PASSes; none FAILs only if the setting read back as on. */
export function judgeLookupsOn(
  outcome: TurnOutcome,
  sourceCards: number,
  lookupsOn: boolean,
  requests: readonly string[],
): Verdict {
  const witness =
    `setting read back as ${lookupsOn ? "ON" : "OFF"}; `
    + `${requests.length} lookup request(s)`
    + (requests[0] ? ` (first: ${clip(requests[0], 70)})` : "");
  return {
    result: sourceCards > 0 ? "PASS" : lookupsOn ? "FAIL" : "RECORDED",
    evidence:
      sourceCards > 0
        ? `${sourceCards} source card(s); ${witness}; answer: ${clip(outcome.replyText, 160)}`
        : `NO source card. ${witness}; answer: ${clip(outcome.replyText, 160)}`,
  };
}

// ── 10. Kill the tab mid-generation, reopen ────────────────────────────────

export const KILL_PROMPT = "Write a detailed paragraph about the history of the bicycle.";
export const KILL_NOT_STARTED = "generation never started, so nothing was killed mid-reply";
export const REOPEN_PROMPT = "Are you still there?";

export function judgeReopened(outcome: TurnOutcome): Verdict {
  return {
    result: outcome.replyText.trim().length > 0 ? "PASS" : "FAIL",
    evidence: `reply after reopening: ${clip(outcome.replyText)}`,
  };
}

// ── 11. A live question, Web search off then on ────────────────────────────

export const SEARCH_QUESTION = "is it raining in Chicago right now";

/** The fetched-at the stubbed relay reports, so the chip's value is checkable. */
export const WEB_SEARCH_STUB_FETCHED_AT = "2026-09-11T14:32:00.000Z";

/** Three results in the relay's own shape (`apps/api/src/routes/search.ts`). */
export const WEB_SEARCH_STUB_RESULTS = [
  {
    title: "Chicago weather — current conditions",
    url: "https://example.invalid/chicago-weather",
    snippet: "Light rain is falling across the Chicago area this afternoon.",
    domain: "example.invalid",
  },
  {
    title: "Chicago radar",
    url: "https://example.invalid/chicago-radar",
    snippet: "Radar shows a band of showers moving east over the city.",
    domain: "example.invalid",
  },
  {
    title: "Illinois forecast",
    url: "https://example.invalid/illinois-forecast",
    snippet: "Showers taper off this evening with clearing overnight.",
    domain: "example.invalid",
  },
] as const;

/** One call the app made to the relay, as the route handler saw it. */
export type SearchRelayCall = {
  method: string;
  /** The raw request body, so a task can assert what was in it, not just that it went. */
  body: string | null;
};

/** Web search off: the honest no-live-data note, no request and no chip. */
export function judgeSearchOff(
  outcome: TurnOutcome,
  observed: { notes: number; calls: readonly SearchRelayCall[]; chips: number; settledOff: boolean },
): Verdict {
  const offClean = observed.notes > 0 && observed.calls.length === 0 && observed.chips === 0;
  return {
    result: offClean ? "PASS" : "FAIL",
    evidence: offClean
      ? "no-live-data note shown, 0 search requests, no chip; setting read back as "
        + `${observed.settledOff ? "ON (wrong)" : "OFF"}; answer: ${clip(outcome.replyText, 160)}`
      : `expected the no-live-data note and no request: ${observed.notes} note(s), `
        + `${observed.calls.length} search request(s), ${observed.chips} chip(s); `
        + `answer: ${clip(outcome.replyText, 160)}`,
  };
}

/**
 * The privacy claim, as a mechanical check: exactly one POST, and its
 * body carries the question as typed and NOTHING else. A body that grew a
 * second key is what this row exists to catch.
 */
export function judgeSearchRequest(observed: {
  calls: readonly SearchRelayCall[];
  settledOn: boolean;
  composerSwitch: string;
}): Verdict {
  const { calls } = observed;
  const [call] = calls;
  let bodyKeys: string[] = [];
  let parsed = false;
  try {
    const json: unknown = JSON.parse(call?.body ?? "");
    if (json !== null && typeof json === "object") {
      bodyKeys = Object.keys(json as Record<string, unknown>).sort();
      parsed = true;
    }
  } catch {
    parsed = false;
  }
  const onlyQuery =
    calls.length === 1
    && call?.method === "POST"
    && parsed
    && bodyKeys.length === 1
    && bodyKeys[0] === "q";
  return {
    result: onlyQuery ? "PASS" : observed.settledOn ? "FAIL" : "RECORDED",
    evidence: `${calls.length} request(s) to the relay; method ${call?.method ?? "(none)"}; `
      + `body keys [${bodyKeys.join(", ")}]${parsed ? "" : " (unparsed)"}; `
      + `setting read back as ${observed.settledOn ? "ON" : "OFF"}, `
      + `composer switch aria-checked=${observed.composerSwitch}`,
  };
}

/**
 * The chip is how a person tells a searched turn from an unsearched one, so
 * its absence is a product failure even when the search ran.
 *
 * A receipt carries no prompt TEXT — only `systemPromptHash` — so "the
 * snippet note reached the prompt" is witnessed by that hash differing from
 * the unsearched turn's, not by reading the note back.
 */
export function judgeSearchChip(
  off: TurnOutcome,
  on: TurnOutcome,
  observed: { chipCount: number; fetchedAt: string | null; settledOn: boolean },
): Verdict {
  const offHash = outcomeReceipt(off)?.systemPromptHash ?? null;
  const onHash = outcomeReceipt(on)?.systemPromptHash ?? null;
  const promptMoved =
    offHash !== null && onHash !== null && offHash !== onHash
      ? "changed, so the searched turn carried a different system prompt"
      : "unchanged or unknown";
  const chipOk = observed.chipCount > 0 && observed.fetchedAt === WEB_SEARCH_STUB_FETCHED_AT;
  return {
    result: chipOk ? "PASS" : observed.settledOn ? "FAIL" : "RECORDED",
    evidence: `${observed.chipCount} chip(s), data-fetched-at ${observed.fetchedAt ?? "(absent)"}; `
      + `system prompt hash ${offHash ?? "?"} → ${onHash ?? "?"} (${promptMoved}); `
      + `answer: ${clip(on.replyText, 160)}`,
  };
}

// ── 12. Stop mid-reply, then the next message ──────────────────────────────

export const STOP_PROMPT =
  "Write a long, detailed essay on the history of the Roman Empire, at least 1500 words.";
export const AFTER_STOP_PROMPT = "Give me some tips for better sleep.";

/** Stop could not be pressed: the task says so rather than passing. */
export function judgeStopNotPressed(reason: string): Verdict {
  return {
    result: "FAIL",
    evidence: `${reason}; nothing was stopped, so this task says nothing about Stop`,
  };
}

export type StoppedObservation = {
  /** How long the composer took to come back after Stop was pressed. */
  settledMs: number;
  /** The "stopped" status line on the bubble, or "" when there is none. */
  noticeText: string;
  tryAgainOffered: boolean;
  /** The bubble's words with the notice removed. */
  kept: string;
};

/** The stopped reply keeps its words, says it was stopped, offers Try again, and is recorded `aborted`. */
export function judgeStopped(stopped: TurnOutcome, observed: StoppedObservation): Verdict {
  const stoppedReceipt = outcomeReceipt(stopped);
  const recordedAsStopped = stoppedReceipt?.status === "aborted";
  const { noticeText, kept } = observed;
  const stopOk = recordedAsStopped && noticeText !== "" && observed.tryAgainOffered && kept !== "";
  return {
    result: stopOk ? "PASS" : "FAIL",
    evidence: `composer back ${observed.settledMs} ms after Stop; recorded as '${
      stoppedReceipt?.status ?? "(no receipt)"
    }'${recordedAsStopped ? "" : " (a stopped reply should be 'aborted')"}; notice: ${
      noticeText ? JSON.stringify(clip(noticeText, 60)) : "MISSING"
    }; ${kept ? `${kept.length} chars kept on screen` : "the partial reply is GONE"}`,
  };
}

// ── 13. A reply fails part-way; Try again answers ──────────────────────────

/** The text a reply failed by the harness carries, so its receipt can be told from a genuine failure. */
export const INJECTED_FAULT_MESSAGE = VALIDATION_GENERATION_FAULT_MESSAGE;

export const FAULT_PROMPT = "Give me three ideas for a quiet weekend at home.";
export const AFTER_RETRY_PROMPT = "Thanks. One more idea, please.";

/**
 * The reply failed with the harness's injected fault (not a genuine failure),
 * the fault fired once, and Try again is offered. `ourFault` is returned too:
 * the walk does not retry a reply that failed for some other reason.
 */
export function judgeInjectedFailure(
  failed: TurnOutcome,
  observed: { stillArmed: boolean; offered: boolean; card: string },
): Verdict & { ourFault: boolean } {
  const failedReceipt = outcomeReceipt(failed);
  const ourFault =
    failedReceipt?.status === "error"
    && (failedReceipt.errorCode ?? "").startsWith(INJECTED_FAULT_MESSAGE.slice(0, 80));
  const { stillArmed, offered, card } = observed;
  return {
    ourFault,
    result: ourFault && offered && !stillArmed ? "PASS" : "FAIL",
    evidence: [
      ourFault
        ? "failed with the injected fault"
        : `expected the injected fault, got '${failedReceipt?.status ?? "no receipt"}'${
            failedReceipt?.errorCode ? ` (${clip(failedReceipt.errorCode, 80)})` : ""
          }`,
      stillArmed ? "the fault is STILL armed (it should fire once)" : "fault fired once",
      offered ? `the person sees: ${JSON.stringify(card)}` : "NO Try again is offered",
    ].join("; "),
  };
}

/** The retry answers, the question shows once, and the answer replaced the failed reply. */
export function judgeRetry(
  retried: TurnOutcome,
  check: { ok: boolean; why: string },
  observed: { askedOnce: boolean; replacedInPlace: boolean },
): Verdict {
  const { askedOnce, replacedInPlace } = observed;
  const retryOk = check.ok && askedOnce && replacedInPlace;
  return {
    result: retryOk ? "PASS" : "FAIL",
    evidence: [
      check.ok ? "answered" : `did NOT answer: ${check.why}`,
      askedOnce ? "the question shows once" : "the question is DUPLICATED in the transcript",
      replacedInPlace ? "the answer replaced the failed reply" : "the failed reply was NOT replaced",
      turnCounts(retried),
      `reply: ${clip(retried.replyText)}`,
    ].join("; "),
  };
}

// ── 14. Edit an earlier message and resend ─────────────────────────────────

/** The name only the discarded original carries. */
export const ORIGINAL_NAME = "Priya";
/** The name only the edit carries. */
export const EDITED_NAME = "Tomas";

export const EDIT_ORIGINAL_PROMPT = `My name is ${ORIGINAL_NAME}. Say hello to me by name, in one short sentence.`;
export const EDIT_LATER_PROMPT = "Suggest one name for a pet goldfish.";
/** A word only the later exchange carries, so its leaving the transcript is checkable. */
export const EDIT_LATER_MARKER = "goldfish";
export const EDIT_REPLACEMENT_PROMPT = `My name is ${EDITED_NAME}. Say hello to me by name, in one short sentence.`;
export const RECALL_PROMPT = "What is my name?";

export type EditObservation = {
  /** Every user message the transcript shows after the edit. */
  userTexts: readonly string[];
  /** Exactly one assistant reply is showing. */
  oneReply: boolean;
  /** The edited message offers its earlier version. */
  versionsShown: boolean;
};

/**
 * What a turn's model was sent, when the harness record was read: the last
 * user message, and whether any message carries the name from before the edit.
 * The last user message may carry a directive or recap after a blank line
 * (`appendTurnDirective`, the detail recaps), so the edit is the text up to it.
 */
function readSent(outcome: TurnOutcome): {
  lastUser: string | null;
  sentEdit: boolean;
  sentOriginal: boolean;
  sentEditedName: boolean;
} | null {
  const sent = outcome.sent;
  if (sent === null) return null;
  const lastUser = [...sent.messages].reverse().find((m) => m.role === "user")?.content ?? null;
  return {
    lastUser,
    sentEdit:
      lastUser !== null
      && (lastUser === EDIT_REPLACEMENT_PROMPT || lastUser.startsWith(`${EDIT_REPLACEMENT_PROMPT}\n\n`)),
    sentOriginal: sent.messages.some((m) => m.content.includes(ORIGINAL_NAME)),
    sentEditedName: sent.messages.some((m) => m.content.includes(EDITED_NAME)),
  };
}

/**
 * The edited message is resent and answered. Two witnesses: what the model
 * was SENT (the harness record), and the reply's own words. Either one
 * carrying the original name means the edited turn was generated from the
 * discarded text — the edit is broken whatever the screen shows. When what
 * was sent cannot be read and the reply uses neither name, the content is
 * unchecked, not failed.
 */
export function judgeEdit(
  edited: TurnOutcome,
  check: { ok: boolean; why: string },
  observed: EditObservation,
): Verdict {
  const { userTexts, oneReply, versionsShown } = observed;
  const showsEdit = userTexts.length === 1 && (userTexts[0] ?? "").includes(EDITED_NAME);
  const laterTurnGone = !userTexts.some((text) => text.includes(EDIT_LATER_MARKER));
  // Null means nothing could be read from storage; only a mismatch fails.
  const storedEdit =
    edited.storedUserText === null || edited.storedUserText.trim() === EDIT_REPLACEMENT_PROMPT;
  const sent = readSent(edited);
  // Null means the record could not be read; only what it shows can fail.
  const sentOk = sent === null || (sent.sentEdit && !sent.sentOriginal);
  const replyLeakedOriginal = edited.replyText.includes(ORIGINAL_NAME);
  const replyUsedEdit = edited.replyText.includes(EDITED_NAME);
  const editOk =
    check.ok
    && showsEdit
    && laterTurnGone
    && oneReply
    && versionsShown
    && storedEdit
    && sentOk
    && !replyLeakedOriginal;
  return {
    result: editOk ? "PASS" : "FAIL",
    evidence: [
      check.ok ? "answered" : `did NOT answer: ${check.why}`,
      showsEdit ? "the transcript shows the edited message" : `the transcript shows ${JSON.stringify(userTexts.map((text) => clip(text, 40)))}`,
      laterTurnGone ? "the later exchange left the transcript" : "the later exchange is STILL showing",
      oneReply ? "one reply" : "more than one reply is showing",
      versionsShown ? "the earlier version is one tap away" : "NO way back to the earlier version",
      storedEdit ? "storage holds the edit" : `storage holds ${JSON.stringify(clip(edited.storedUserText ?? "", 60))}`,
      sent === null
        ? "what was sent could not be read"
        : sent.sentOriginal
          ? "the model was sent the text from before the edit"
          : !sent.sentEdit
            ? `the model was sent ${JSON.stringify(clip(sent.lastUser ?? "(no user message)", 60))}, not the edit`
            : "the model was sent the edit and nothing from before it",
      replyLeakedOriginal
        ? "the reply uses the name from BEFORE the edit, so it was generated from the discarded text"
        : replyUsedEdit
          ? "the reply uses the edited name"
          : sent === null
            ? "the reply did not use a name — the edit's content is unchecked on this run"
            : "the reply did not use a name",
      `reply: ${clip(edited.replyText)}`,
    ].join("; "),
  };
}

/**
 * Judged in this order. What the recall's model was sent (when the harness
 * record was read) carrying the original name, or not carrying the edited
 * one, means the conversation did not continue from the edit — FAIL. The
 * original name in the reply means the discarded text reached the model —
 * FAIL. The edited name PASSes. Neither name (a small model saying it
 * doesn't know) is RECORDED: a reading on the model's recall, not evidence
 * about the edit.
 */
export function judgeRecall(recall: TurnOutcome): Verdict {
  const sent = readSent(recall);
  const sentLeaked = sent !== null && sent.sentOriginal;
  const sentLacksEdit = sent !== null && !sent.sentEditedName;
  const leakedOriginal = recall.replyText.includes(ORIGINAL_NAME);
  const recalled = recall.replyText.includes(EDITED_NAME);
  return {
    result: sentLeaked || sentLacksEdit || leakedOriginal ? "FAIL" : recalled ? "PASS" : "RECORDED",
    evidence: `${
      sent === null
        ? "what was sent could not be read"
        : sentLeaked
          ? "the model was sent the name from BEFORE the edit, so the discarded text reached the model"
          : sentLacksEdit
            ? "the conversation sent for the recall does not carry the edit"
            : "what was sent carries the edit"
    }; ${
      leakedOriginal
        ? "the reply uses the name from BEFORE the edit, so the discarded text reached the model"
        : recalled
          ? "the reply uses the edited name"
          : "the model did not recall either name — a recall reading, not an edit failure"
    }; ${turnCounts(recall)}; reply: ${clip(recall.replyText)}`,
  };
}
