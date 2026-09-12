// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Host-driven tool step for the on-device generation pipeline (#4 Phase 4a Task 2).
 *
 * Sits in `streamResponse` BETWEEN `buildPrompt` and the primary `runGeneration`:
 * it runs the deterministic tool registry over the latest user turn and, on a
 * confident match, executes the tool and returns the authoritative result so the
 * caller can (a) render it via the `ToolCallBlock` side-channel and (b) inject
 * `forModel` into the single generation's system prompt.
 *
 * Design invariants (from the locked Phase-4a approach):
 *  - Host decides, deterministic TS executes — the model never picks the tool nor
 *    computes the answer. `detectTool` abstains by default.
 *  - The displayed `result.display` (rendered in `ToolCallBlock`) is the source of
 *    truth. `forModel` is only the conversational wrapper hint; the model's prose
 *    must not override the displayed number.
 *  - Single generation. No second pass — we inject the result into the one
 *    generation that follows.
 *  - Zero overhead on the common no-tool path: detection is one regex sweep, and
 *    on no-match we only clear any lingering tool state from a prior turn.
 *
 * This module is intentionally store-agnostic: it takes the exact `chatStore`
 * tool actions it needs as parameters, so it is trivial to unit-test and cannot
 * reach into unrelated store state.
 */

import { detectTool, detectToolFrom, wikipediaGroundingTool, buildForcedGroundingArgs } from "../../lib/tools";
import type {
  AnyEcoTool,
  EcoCitation,
  GroundingVerification,
  ToolMatchContext,
} from "../../lib/tools";
import { isRealTimeAsk } from "../../lib/real-time/detect-real-time";
import { buildWebSnippetNote } from "../../lib/grounding/web-snippet-note";
import type { WebSnippet } from "../../lib/grounding/web-snippet-note";
import type { ToolCallDisplay } from "../../lib/tool-parser";
import type { StreamPhase } from "../../stores/chatStore";

/** The narrow slice of `chatStore` tool actions the step writes through. */
export type ToolStepStore = {
  /** Clear any tool calls left over from a previous turn (transient side-channel). */
  clearToolState: () => void;
  /** Add the running tool call so `ToolCallBlock` shows the in-progress state. */
  addToolCall: (call: ToolCallDisplay) => void;
  /** Flip the running call to complete/error with the authoritative display string. */
  updateToolCall: (id: string, updates: Partial<ToolCallDisplay>) => void;
  /**
   * Set the stream phase ONLY while a matched tool's `execute` is awaited (#5 S3):
   * `"looking-up"` for a web lookup (grounding — a real fetch leaves the device, so
   * the UI names the web) and `"tool-executing"` for the on-device
   * calculator/date/unit tools. The step never restores the phase —
   * `streamResponse` owns the next transition (the generation flips it to
   * generating/thinking on its first token), so there is no flash on the common
   * no-match path and no stuck phase after a real match.
   */
  setStreamPhase: (phase: StreamPhase) => void;
};

/**
 * The outcome of the tool step for one turn.
 *
 * `systemNote` is the `forModel` string to append to the generation's system
 * prompt, or `null` when no tool fired (the common path). When present, the tool
 * call has already been rendered to the side-channel (running → complete/error)
 * and the authoritative answer lives in the `ToolCallBlock`.
 */
export type ToolStepResult = {
  /** The note to inject into this generation's system prompt, or null on abstain. */
  systemNote: string | null;
  /**
   * The structured source attribution for a grounded answer, set ONLY by a
   * `presentation:"citation"` tool's FOUND case (#5 S3). The caller maps this onto
   * the assistant message so the citation chip renders. Absent on abstain, on the
   * deterministic ToolCallBlock tools, and on grounding's decline/degraded cases
   * (those carry no source — the note alone instructs the model to admit it).
   */
  citation?: EcoCitation;
  /**
   * The sources of a WEB SEARCH turn (slice 2): one entry per result the relay
   * returned, in the order the model saw them in the note. Separate from
   * {@link citation} because a search returns several sources and the chip names
   * all of them, where grounding's invariant is a single article. Mutually
   * exclusive with `citation` by construction — the two paths never both fire on
   * one turn.
   */
  citations?: readonly WebSearchCitation[];
  /**
   * Set by a grounding tool's no-source outcomes, and by the lookups-off path
   * (`status:"lookups-off"`); the caller maps it onto the assistant message so the
   * host renders the uncertainty marker. Absent on FOUND (which carries `citation`)
   * and on abstain.
   */
  verification?: GroundingVerification;
  /**
   * Set ONLY when a CANONICAL exact-answer tool (calculator/datetime/unit —
   * `presentation:"tool-block"`) produced a result: the host-computed `display`
   * string ("2 + 2 = 4", "5 miles = 8.05 kilometers", or the honest "Couldn't
   * compute…" on `ok:false`) shown verbatim AS the assistant's answer, with NO
   * model generation. Same rationale as {@link hostAnswer}: the host holds
   * the exact answer and a sub-1B model reliably corrupts it in prose ("2 + 2 = 5"),
   * so we take the model out of the loop. The caller sets this as the message
   * content, marks the message canonical, finalizes, and SKIPS generation — which
   * persists the correct value (surviving scroll-back and feeding copy/export) and
   * closes the "model elaborates a contradicting worked breakdown" watch item
   * (calculator-tool.ts RC1). Set for BOTH ok and failure: each `display` is a
   * complete, honest answer. Mutually exclusive with `systemNote` (null here),
   * `citation`, `verification`, and `hostAnswer`.
   */
  canonicalAnswer?: string;
  /**
   * Set ONLY when the always-on `presentation:"host-answer"` identity tool matched
   * (Finding G, launch-bar 2026-07-03; engineering-review Corollary): the host-
   * authored on-device truth for an identity / privacy / "are you <product>?" turn,
   * shown VERBATIM as the assistant's markdown reply with NO model generation. Same
   * rationale as {@link canonicalAnswer}: the model must
   * not narrate Eco's own identity or privacy posture — the 350m starter fabricates
   * false cloud-privacy claims ("your data goes to Amazon S3") and invents base
   * identities, inverting a privacy-first product's core promise. Taking the model
   * out of the loop makes fabrication impossible. Unlike `canonicalAnswer` this
   * renders as normal Markdown (prose, not a computed value), so the caller does NOT
   * set `canonicalToolAnswer`; it is stored like the decline path, so the answer
   * persists, is copyable, and survives scroll-back. Mutually exclusive with `systemNote` (null here), `citation`,
   * `verification`, and `canonicalAnswer`.
   */
  hostAnswer?: string;
};

/**
 * One source of a web-searched turn. Deliberately NOT an {@link EcoCitation}:
 * that type's `source` names the two browser-direct encyclopedia surfaces, and a
 * relayed search result is a different provenance claim — the person's device
 * never talked to the engine, Eco's relay did.
 */
/**
 * One relay result: a {@link WebSnippet} (what the note builder reads — the note
 * deliberately carries NO urls) plus the url the chip links to.
 */
type SearchResult = WebSnippet & { readonly url: string };

export type WebSearchCitation = {
  readonly source: "Web search";
  readonly title: string;
  readonly url: string;
  /** The relay's `fetchedAt`, ISO 8601 — what the chip's time is read from. */
  readonly asOf: string;
};

/** The minimal `fetch` this module needs; injectable so tests never touch the network. */
export type WebSearchFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

/**
 * Whole-request budget for the search, generously above the relay's own (4 s plus
 * one retry). This is the backstop for a relay that accepts the connection and
 * then says nothing: past it we stop waiting and answer honestly from memory
 * rather than leave the person watching "Looking it up…" indefinitely.
 */
const WEB_SEARCH_TIMEOUT_MS = 10_000;

/**
 * Every web-search failure — relay down, rate-limited, timed out, garbage body,
 * nothing found — lands on the EXISTING "couldn't reach its sources just now"
 * marker. One honest outcome, no new copy, and nothing invented: the model still
 * answers from memory and the host says the sources were not reached.
 */
const VERIFICATION_UNREACHABLE: GroundingVerification = { status: "unreachable" };

/**
 * Longest question the relay will accept, mirrored here.
 *
 * MUST equal `MAX_QUERY_LENGTH` in `apps/api/src/routes/search.ts`. It is
 * duplicated rather than imported because the api and the web app are separate
 * tsconfig projects and separate deploy artifacts — the same reason that file
 * re-implements the fence-marker stripper instead of importing it. The test in
 * `__tests__/tool-step-web-search.test.ts` pins the value so a change on one
 * side is visible on this one.
 *
 * Why guard at all: past this the relay answers 400, which renders as "couldn't
 * reach its sources just now" — an honest outcome reached by a dishonest route
 * (nothing was unreachable; we sent something it could not accept). Checking here
 * reaches the same marker without spending a request.
 */
export const WEB_SEARCH_MAX_QUERY_CHARS = 200;

/** A result url the chip may link to. Mirrors the relay's own scheme allowlist. */
function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

let toolCallSeq = 0;

/** Stable, collision-free id for a turn's tool call (transient side-channel only). */
function nextToolCallId(): string {
  toolCallSeq += 1;
  return `tool-${Date.now().toString(36)}-${toolCallSeq.toString(36)}`;
}

/**
 * No system note on a lookups-off turn (2026-09-04). Earlier cuts told the model
 * to decline (it fabricated sources), then answered with a canned host decline
 * (it refused ordinary questions), then appended a from-memory note to the
 * system prompt for that turn only. Measured on the production build: every
 * such turn rewrote the cached prefix and re-prefilled the whole window
 * (10-13 s to first token on the 2.6B). The host draws the `lookups-off`
 * marker deterministically, so provenance honesty never rode on the prose;
 * the note is gone and the system prompt stays identical turn to turn.
 */

/** The verification carried by every lookups-off turn — the host draws the marker. */
const VERIFICATION_LOOKUPS_OFF: GroundingVerification = { status: "lookups-off" };

/**
 * The verification carried by a real-time ask. Same posture as the lookups-off
 * marker above and for the same measured reason: NO system note, so the cached
 * prompt prefix survives and the reply is generated exactly as it is today. Only
 * what the host draws underneath changes — an honest line plus a search link the
 * user may click.
 *
 * It carries the user's question because the note's link is built from it.
 */
function verificationNoLiveData(query: string): GroundingVerification {
  return { status: "no-live-data", query };
}

/**
 * Run the host-driven tool step for the current turn.
 *
 * Always clears prior-turn tool state first (so a previous turn's call never
 * lingers on the new streaming reply). On a confident `detectTool` match it
 * flips the phase to `"tool-executing"`, awaits the tool's `execute` (passing the
 * generation's abort signal), and returns the `forModel` note for injection. On no
 * match it returns `{ systemNote: null }` and the caller proceeds with normal
 * generation, unchanged — the phase is NOT touched, so there is no flash.
 *
 * Two render paths, keyed by the matched tool's `presentation`:
 *  - `"tool-block"` (default — the deterministic tools): render a running tool
 *    call, then flip it to complete/error with the authoritative `display`.
 *  - `"citation"` (grounding): NO ToolCallBlock. The model phrases the answer; on
 *    the FOUND case the tool's `citation` is returned so the caller maps it onto
 *    the assistant message (decline/degraded carry none, only a note).
 *
 * The phase is set to `"tool-executing"` only around the `await`; the step never
 * restores it (the caller's generation owns the next transition).
 *
 * @param latestUserText - the latest `role:"user"` turn's content.
 * @param store - the narrow set of chat-store tool actions to write through.
 * @param signal - the active generation's abort signal, threaded into `execute` so
 *   a user-stop during a network-backed lookup cancels it.
 * @param options.tools - the tool list to detect against. Defaults to
 *   {@link DEFAULT_TOOLS} (preserving every existing caller). The chat pipeline
 *   passes a narrowed list (e.g. grounding removed when the setting is off, #5 S5)
 *   so a disabled tool never matches, executes, or hits the network. The step stays
 *   store-agnostic — the gate decision is made by the caller, not here.
 * @param options.declineTools - OPTIONAL tools that are currently DISABLED (e.g. the
 *   citation tools when web lookups are off). When the enabled `tools` abstain, the
 *   step runs detection over these (pure `match`, no execute, no network) — after
 *   the real-time check, which wins when both would fire; a
 *   would-be match yields a `lookups-off` `verification` (and no system note, so
 *   the cached prompt prefix survives), and the host marks the reply as not
 *   checked against a source. Omit it (lookups on) and the abstain path is
 *   exactly as before.
 * @param options.matchContext - OPTIONAL conversation-derived hints forwarded into
 *   detection (each tool's `match`), e.g. the previously grounded subject so a
 *   pronoun follow-up resolves. The caller derives it from the chat store; tools
 *   that ignore it are unaffected. Absent ⇒ detection runs context-free as before.
 * @param options.forceMatch - when `true`, bypass all candidacy detection and force
 *   the grounding tool with args built from the user text via
 *   {@link buildForcedGroundingArgs}. Used by the "Check a source" user action.
 * @param options.webSearch - the person's Web switch, resolved by the caller
 *   (loaded settings AND on). When `true`, a turn the host reads as a question
 *   about right now is SEARCHED through Eco's relay before the reply instead of
 *   being answered with the "can't check live information" note. When `false` or
 *   omitted, this module behaves exactly as it did: no request is made and the
 *   no-live-data path is untouched.
 * @param options.webSearchFetch - test seam for the search request. Omitted in
 *   production, where the global same-origin `fetch` is used.
 */
export async function runToolStep(
  latestUserText: string,
  store: ToolStepStore,
  signal?: AbortSignal,
  options?: {
    tools?: readonly AnyEcoTool[];
    declineTools?: readonly AnyEcoTool[];
    matchContext?: ToolMatchContext;
    forceMatch?: boolean;
    webSearch?: boolean;
    webSearchFetch?: WebSearchFetch;
  },
): Promise<ToolStepResult> {
  // Clear any tool calls from a prior turn BEFORE detection. This is the single
  // point that satisfies both "a no-tool turn clears the previous call" and "a
  // tool turn doesn't show the prior turn's call". In edit/regenerate paths the
  // store's setMessages already cleared activeToolCalls; this is idempotent.
  store.clearToolState();

  // ── Forced grounding ("Check a source") ─────────────────────────────────
  // When the caller sets `forceMatch`, skip all candidacy detection and execute
  // the grounding tool directly with args built from the user's question. The
  // execution, phase flip, citation/verification return, and error handling are
  // IDENTICAL to the organic citation path below — only the detection is bypassed.
  if (options?.forceMatch) {
    const forcedArgs = buildForcedGroundingArgs(latestUserText, options.matchContext);
    store.setStreamPhase("looking-up");
    let result: Awaited<ReturnType<typeof wikipediaGroundingTool.execute>>;
    try {
      result = await wikipediaGroundingTool.execute(forcedArgs, { signal });
    } catch {
      return {
        systemNote:
          "A tool was attempted but failed to run; answer the user normally without it, and do not claim a tool result.",
      };
    }
    return {
      systemNote: result.forModel === "" ? null : result.forModel,
      ...(result.citation !== undefined ? { citation: result.citation } : {}),
      ...(result.verification !== undefined ? { verification: result.verification } : {}),
    };
  }

  // No explicit list ⇒ the barrel `detectTool` (over DEFAULT_TOOLS) — the original
  // path, so existing `vi.spyOn(tools, "detectTool")` seams still intercept. An
  // explicit list (the grounding on/off gate, #5 S5) uses the list form. Either
  // way `matchContext` (optional conversation hints) is forwarded into detection.
  const detection = options?.tools
    ? detectToolFrom(latestUserText, options.tools, options.matchContext)
    : detectTool(latestUserText, options?.matchContext);
  if (!detection) {
    // Before falling through to normal chat, check whether this turn WOULD have
    // matched a currently-DISABLED browser-direct lookup tool (web lookups off).
    // If so, let the model answer from memory and hand back the `lookups-off`
    // verification so the host marks the reply as unchecked. No system note: a
    // per-turn note rewrites the cached prompt prefix (measured 2026-09-04).
    // This is detection-ONLY: `match` is a pure heuristic, so nothing executes, no
    // network is hit, no ToolCallBlock renders, and no citation is set. The caller
    // supplies `declineTools` only when the setting is off; omitted ⇒ no-op (the
    // abstain path is exactly as before).
    // A real-time ask wins over the lookups-off marker, and is checked whether
    // lookups are on or off. The old marker said "answered from memory — web
    // lookups are off", which on a live question is both misleading (turning
    // them on would fetch an encyclopedia article, never live data) and drawn
    // only where the Wikipedia matcher happened to claim the turn — five of the
    // seven measured inventions rendered with no marker at all (2026-09-09).
    if (isRealTimeAsk(latestUserText)) {
      // Web switch on: look it up instead of declining. Same detection, same
      // turn — only what the host does about it changes.
      if (options?.webSearch) {
        return await webSearchStep(latestUserText, store, signal, options.webSearchFetch);
      }
      return { systemNote: null, verification: verificationNoLiveData(latestUserText) };
    }
    if (options?.declineTools && options.declineTools.length > 0) {
      const wouldHaveMatched = detectToolFrom(
        latestUserText,
        options.declineTools,
        options.matchContext,
      );
      if (wouldHaveMatched) {
        return { systemNote: null, verification: VERIFICATION_LOOKUPS_OFF };
      }
    }
    // Common path: abstain → normal chat, zero further work. The phase stays as
    // the caller set it (loading/thinking) — never flips to tool-executing.
    return { systemNote: null };
  }

  const { tool, args } = detection;

  // Host-authoritative answer (identity/privacy — Finding G). The host states Eco's
  // on-device truth verbatim and the model NEVER generates. `execute` is pure and
  // synchronous (a constant-string return — no network, no I/O), so unlike the
  // citation and tool-block paths there is nothing to look up: we render NO
  // ToolCallBlock and never flip the phase to "tool-executing" (which would flash a
  // spurious "Looking it up…"). Hand the
  // `display` back as `hostAnswer` and let the caller show it verbatim and SKIP
  // generation. No citation/verification/canonical applies.
  if (tool.presentation === "host-answer") {
    const result = await tool.execute(args, { signal });
    return { systemNote: null, hostAnswer: result.display };
  }

  // `"citation"` tools (grounding) render no ToolCallBlock — the model phrases the
  // answer and the source is a citation chip; absent ⇒ "tool-block" (default).
  const isCitation = tool.presentation === "citation";

  // A live question never gets an encyclopedia article. The grounding matcher
  // claims most real-time asks ("weather in chicago", "the next yankees home
  // game") and, with lookups on, would fetch the Wikipedia page for the extracted
  // entity and present it as a source for a question about right now. So we stop
  // BEFORE `execute`: nothing leaves the device, no citation is set, and the host
  // draws the honest note instead. The deterministic tools are unaffected — they
  // matched above and returned, which is the "a calculator/date answer still
  // wins" rule.
  if (isCitation && isRealTimeAsk(latestUserText)) {
    // With the Web switch on the live question gets a real search (through Eco's
    // relay) rather than the encyclopedia article the grounding matcher wanted.
    if (options?.webSearch) {
      return await webSearchStep(latestUserText, store, signal, options.webSearchFetch);
    }
    return { systemNote: null, verification: verificationNoLiveData(latestUserText) };
  }

  const id = nextToolCallId();

  if (!isCitation) {
    // Friendly, human-readable headline (e.g. "5 miles → kilometers") derived from
    // the extracted args. Optional per tool; a throwing/missing `summarize` must
    // never break the turn, so we guard it and fall back to no summary.
    const summary = safeSummarize(tool, args);

    // Render the running state on the streaming assistant message. Stamp the
    // tool's `presentation` so the renderer knows this block carries a CANONICAL
    // exact answer (calculator/datetime/unit are `"tool-block"`): the host-computed
    // `result` is authoritative and the model's prose is suppressed in its favour.
    store.addToolCall({
      id,
      type: "tool_start",
      name: tool.name,
      status: "running",
      presentation: tool.presentation ?? "tool-block",
      ...(isRecord(args) ? { args } : {}),
      ...(summary !== null ? { summary } : {}),
    });
  }

  // Flip the phase ONLY while the matched tool's execute is awaited (the seedling
  // affordance). A web lookup names the web ("looking-up" → "Looking this up on the
  // web…"); the on-device tools stay generic ("tool-executing"). Set immediately
  // before the await; never restored here — the generation's first token flips it to
  // generating/thinking.
  store.setStreamPhase(isCitation ? "looking-up" : "tool-executing");

  // Execute (may be async, may hit the network). On an unexpected throw, surface a
  // tool error AND tell the model the tool couldn't run, so it answers normally
  // instead of silently hallucinating a tool result. A `"citation"` tool shows no
  // block, so on its throw we only return the safe note.
  let result: Awaited<ReturnType<typeof tool.execute>>;
  try {
    result = await tool.execute(args, { signal });
  } catch {
    if (!isCitation) {
      store.updateToolCall(id, {
        type: "tool_error",
        status: "error",
        result: "The tool failed to run.",
      });
    }
    return {
      systemNote:
        "A tool was attempted but failed to run; answer the user normally without it, and do not claim a tool result.",
    };
  }

  if (!isCitation) {
    store.updateToolCall(id, {
      type: result.ok ? "tool_complete" : "tool_error",
      status: result.ok ? "complete" : "error",
      result: result.display,
    });
    // Canonical exact-answer tool: the host computed the authoritative answer and a
    // sub-1B model reliably corrupts it in prose. Mirror the host-answer seam — hand
    // the `display` back as the answer and SKIP generation (`systemNote` null). Set
    // for BOTH ok and failure: each `display` is a complete, honest reply, so the
    // model never runs and can never fabricate/contradict a number. The caller
    // persists this as the message content, so it survives scroll-back and feeds
    // copy/export. No citation/verification applies (those are citation-tool only).
    return { systemNote: null, canonicalAnswer: result.display };
  }

  // Citation tools (grounding): the model phrases the answer itself. Carry
  // the citation only when the tool produced one (grounding's FOUND case). An empty
  // forModel is a deliberate post-execute ABSTAIN (grounding's low-confidence path
  // when the resolved title doesn't cover the entity) — normalize it to null so the
  // caller treats the turn as a normal no-tool chat.
  return {
    systemNote: result.forModel === "" ? null : result.forModel,
    ...(result.citation !== undefined ? { citation: result.citation } : {}),
    ...(result.verification !== undefined ? { verification: result.verification } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read the relay's response into the shape the note builder takes, or `null` when
 * the body is not what we expect.
 *
 * Defensive on purpose: this is the one place third-party text enters the prompt,
 * so a result missing any of its fields is DROPPED rather than rendered as a
 * half-line, and a body that yields nothing usable is a failure (the caller turns
 * it into the honest "couldn't reach" marker), never a silent empty note.
 */
function parseSearchResponse(
  payload: unknown,
): { fetchedAt: string; results: SearchResult[] } | null {
  if (!isRecord(payload)) return null;
  if (!isNonEmptyString(payload.fetchedAt)) return null;
  if (!Array.isArray(payload.results)) return null;

  const results: SearchResult[] = [];
  for (const raw of payload.results) {
    if (!isRecord(raw)) continue;
    if (
      !isNonEmptyString(raw.title) ||
      !isNonEmptyString(raw.url) ||
      !isNonEmptyString(raw.snippet) ||
      !isNonEmptyString(raw.domain)
    ) {
      continue;
    }
    // The relay already drops anything but http(s); this is the same rule applied
    // where the url actually becomes a chip href, so the guard does not depend on
    // one deploy of the api being ahead of the web app.
    if (!isHttpUrl(raw.url)) continue;
    results.push({
      title: raw.title,
      url: raw.url,
      snippet: raw.snippet,
      domain: raw.domain,
      ...(isNonEmptyString(raw.published) ? { published: raw.published } : {}),
    });
  }
  if (results.length === 0) return null;
  return { fetchedAt: payload.fetchedAt, results };
}

/**
 * Combine the generation's abort signal with the request budget, without relying
 * on `AbortSignal.any` (absent in some of the environments this runs under).
 */
function withRequestBudget(signal: AbortSignal | undefined, ms: number): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("web search timed out"));
  }, ms);
  const onAbort = () => {
    controller.abort(signal?.reason);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Search the web for a live question, through Eco's own relay, BEFORE the reply.
 *
 * Runs only where the host already decided the turn is a question about right now
 * AND the person's Web switch is on. The request body is `{ q }` and nothing else
 * — no conversation, no message ids, no model, nothing that could identify the
 * person or the chat. The call is same-origin (`next.config.ts` rewrites `/v1/*`
 * to the api), so it carries no third-party anything.
 *
 * On success the results become the SAME fenced note the s46 fixture arm
 * measured, plus one citation per result for the chip. On ANY failure the turn
 * falls back to the existing `unreachable` marker and the model answers from
 * memory — never an invented live answer.
 *
 * On a user stop mid-search there is nothing to say: the caller's post-step
 * `signal.aborted` check finalizes the message and skips generation, exactly as
 * it does for a stopped Wikipedia lookup.
 */
async function webSearchStep(
  query: string,
  store: ToolStepStore,
  signal?: AbortSignal,
  fetchImpl?: WebSearchFetch,
): Promise<ToolStepResult> {
  // Too long for the relay to accept: take the honest "couldn't reach" marker
  // without the round trip, and never flash "Looking it up…" for a lookup that
  // does not happen (same reasoning as the switch-off path).
  if (query.trim().length > WEB_SEARCH_MAX_QUERY_CHARS) {
    return { systemNote: null, verification: VERIFICATION_UNREACHABLE };
  }

  store.setStreamPhase("looking-up");

  const doFetch: WebSearchFetch =
    fetchImpl ?? ((input, init) => fetch(input, init));
  const budget = withRequestBudget(signal, WEB_SEARCH_TIMEOUT_MS);

  try {
    const response = await doFetch("/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: query }),
      signal: budget.signal,
    });
    if (!response.ok) return { systemNote: null, verification: VERIFICATION_UNREACHABLE };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { systemNote: null, verification: VERIFICATION_UNREACHABLE };
    }

    const parsed = parseSearchResponse(payload);
    if (!parsed) return { systemNote: null, verification: VERIFICATION_UNREACHABLE };

    return {
      systemNote: buildWebSnippetNote(parsed),
      citations: parsed.results.map((result) => ({
        source: "Web search" as const,
        title: result.title,
        url: result.url,
        asOf: parsed.fetchedAt,
      })),
    };
  } catch {
    // The user pressed Stop: the caller will not generate, so say nothing.
    if (signal?.aborted) return { systemNote: null };
    return { systemNote: null, verification: VERIFICATION_UNREACHABLE };
  } finally {
    budget.release();
  }
}

/**
 * Compute the tool's friendly headline summary, defensively. Returns the summary
 * string, or `null` when the tool exposes no `summarize`, it produces an empty
 * string, or it throws. A bad summary must never fail the turn — the block falls
 * back to the tool's display name alone.
 */
function safeSummarize(
  tool: { summarize?: (args: unknown) => string },
  args: unknown,
): string | null {
  if (typeof tool.summarize !== "function") {
    return null;
  }
  try {
    const summary = tool.summarize(args);
    return typeof summary === "string" && summary.trim() !== "" ? summary : null;
  } catch {
    return null;
  }
}
