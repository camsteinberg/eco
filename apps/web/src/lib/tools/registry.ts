// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Host-driven deterministic tool registry (#4 Phase 4a).
 *
 * The model is NOT involved in the decision to call a tool, nor in computing the
 * answer. Each {@link EcoTool} owns a host-side `match(userText)` heuristic that is
 * BOTH the candidacy gate AND the argument extractor: it returns validated args
 * only when the user's turn is unambiguously for that tool, otherwise `null`.
 *
 * `match` is the single most important field — it is the over-call defense. At the
 * 1-3B model scale, false positives (a tool firing on a conversational turn that
 * merely contains a trigger word) feel broken, while a missed match simply yields
 * normal chat. So `match` is deliberately conservative: it abstains by default.
 *
 * The shape mirrors the AI-SDK `tool()` shape so the future model-native path
 * (Phase 4b) can reuse the registry, but it adds the `match` field and uses an
 * inline `validate` type-guard instead of a zod schema (zod is not a dependency in
 * `@eco/web`, and we do not add one here — `match` already returns `null` on bad
 * input, so it doubles as the validator).
 */

/**
 * A structured source attribution for a grounded answer. The deterministic tools
 * (calculator/datetime/unit) don't set this — they ARE the authoritative source.
 * The grounding tool sets it on a successful lookup so a later slice can render a
 * source chip without re-fetching. Minimal by design.
 */
export type EcoCitation = {
  /** Which external surface the fact came from ("Wikipedia"/"Wikidata"). */
  source: "Wikipedia" | "Wikidata";
  /** The article / entity title (e.g. "Paris"). */
  title: string;
  /** The desktop article URL to link the chip to. */
  url: string;
  /**
   * The year the fact was recorded (e.g. "2023"), from a Wikidata "point in time"
   * qualifier when present. Omitted when unknown. The date is itself a trust signal.
   */
  asOf?: string;
};

/**
 * A structured "couldn't confirm this" signal set by a grounding tool's no-source
 * outcomes (hedge / hard-decline / soft-degrade), mirroring how the FOUND outcome
 * sets an {@link EcoCitation}. The host renders a deterministic uncertainty marker
 * from it so an unverified answer is never surfaced unmarked — the prose alone (which
 * the small 1–2B models under-write) is not relied on to carry the signal.
 *
 * `"unverified"` = the answer was given/attempted but no source confirmed it (hedge /
 * hard-decline). `"unreachable"` = the sources couldn't be reached (transient/network;
 * soft-degrade).
 */
export type GroundingVerification = { status: "unverified" | "unreachable" };

/**
 * Optional conversation-derived hints passed to a tool's `match`. Lets a tool
 * key its candidacy/extraction on context the latest user turn alone can't carry
 * — e.g. resolving "how tall is it?" against the previously grounded subject.
 *
 * Purely advisory: a tool that ignores it is unaffected (a `match` that accepts
 * fewer parameters stays assignable, the same idiom `execute`'s `opts` uses). The
 * host derives these hints from the chat store at tool-step time; nothing here
 * obliges a tool to consume them.
 */
export type ToolMatchContext = {
  /**
   * The title of the most recently grounded Wikipedia subject in the
   * conversation (e.g. "Eiffel Tower"), when one is recent enough to be a useful
   * antecedent for a pronoun follow-up. Absent when there is no recent grounded
   * turn. Staleness is bounded by the host (see `deriveGroundedMatchContext`).
   */
  lastGroundedTitle?: string;
};

/** The result of running a tool's `execute`. */
export type EcoToolResult = {
  /**
   * The exact, authoritative string rendered to the user (the trustworthy answer,
   * e.g. "17 × 23 = 391"). The pipeline (Task 2) treats this as the source of
   * truth — the model's prose must never override it.
   *
   * For grounding this is only a quiet fallback string (the real UI is a citation
   * chip rendered in a later slice from {@link citation}); the model phrases the
   * answer itself rather than the tool stamping a verbatim number.
   */
  display: string;
  /**
   * A compact string the pipeline injects into the model's context so it can
   * phrase the answer naturally (e.g. "A calculator computed: 17 * 23 = 391. Use
   * this exact value.").
   */
  forModel: string;
  /** `true` when the tool produced a usable answer; `false` on a computation error. */
  ok: boolean;
  /**
   * Optional structured source attribution. Set ONLY when the result is grounded
   * in an external source (the grounding tool's found case). A later slice renders
   * this as a citation chip; the deterministic tools omit it.
   */
  citation?: EcoCitation;
  /** Set by a grounding tool's no-source outcomes (hedge/decline/degrade). The host
   *  renders a deterministic "couldn't confirm this" marker. Absent on FOUND (which
   *  carries `citation` instead), on the deterministic ToolCallBlock tools, and on abstain. */
  verification?: GroundingVerification;
};

/**
 * A deterministic, host-driven tool.
 *
 * @typeParam Args - the shape of the extracted, validated arguments.
 */
export type EcoTool<Args = unknown> = {
  /** Stable id used in the ToolCallBlock (e.g. "calculator", "datetime"). */
  name: string;
  /** One-line description (used later by the 4b model-native path). */
  description: string;
  /**
   * Runtime validator / type-guard for extracted args. Returns `true` only when
   * `value` is a valid `Args`. Used to defend the boundary even though `match`
   * already produces validated args (e.g. when args arrive from the future
   * model-native path).
   */
  validate: (value: unknown) => value is Args;
  /**
   * Host-side candidacy gate AND argument extractor (THE key field). Returns
   * extracted, validated args only when `userText` is unambiguously a request for
   * this tool, otherwise `null`. Conservative by design — abstains on ambiguity.
   *
   * `context` carries OPTIONAL conversation-derived hints (e.g. the previously
   * grounded subject, so a pronoun follow-up resolves). A tool that ignores it is
   * unaffected — a `match` accepting only `userText` stays assignable here (a
   * function accepting fewer parameters is assignable, the same idiom `execute`'s
   * `opts` uses).
   */
  match: (userText: string, context?: ToolMatchContext) => Args | null;
  /**
   * Computes the authoritative answer in TypeScript.
   *
   * `opts.signal` lets the pipeline tie a network-backed tool (grounding) to the
   * generation's AbortController, so a user-stop during the lookup cancels it
   * (#5 S3). The deterministic tools (calculator/datetime/unit) ignore it — they
   * take only `args`, which stays assignable here (a function accepting fewer
   * parameters is assignable to one accepting more).
   */
  execute: (
    args: Args,
    opts?: { signal?: AbortSignal },
  ) => EcoToolResult | Promise<EcoToolResult>;
  /**
   * How the pipeline should surface this tool's result (#5 S3). `"tool-block"`
   * (the default when omitted) renders the authoritative `display` in a
   * `ToolCallBlock` side-channel — the deterministic tools' behavior. `"citation"`
   * suppresses that block entirely: the model phrases the answer itself and the
   * result is surfaced as a source chip (or an honest decline in prose). Grounding
   * uses `"citation"` because its `display` is only a quiet fallback string, not a
   * verbatim answer to stamp. `"host-answer"` (identity/privacy, Finding G) also
   * renders no block: `execute` is pure/synchronous and its `display` is shown
   * VERBATIM as the assistant's markdown reply while generation is SKIPPED — the
   * model never states Eco's own identity or privacy posture.
   */
  presentation?: "tool-block" | "citation" | "host-answer";
  /**
   * Optional human-readable one-line summary of what the tool is doing, derived
   * from the extracted args (e.g. "5 miles → kilometers", "17 × 23"). Rendered as
   * the `ToolCallBlock` headline so the user sees a friendly label instead of raw
   * args JSON. The raw args stay available inside the expanded detail. When
   * omitted, the block falls back to the tool's display name alone.
   */
  summarize?: (args: Args) => string;
};

/**
 * The type-erased view of an {@link EcoTool} used in heterogeneous collections
 * (the registry array / `detectTool`). Because `Args` appears in both
 * contravariant (`execute`/`match` params) and covariant positions, `EcoTool<X>`
 * is invariant and not assignable to `EcoTool<unknown>`. The erased view uses
 * METHOD syntax for the `Args`-dependent members, which TypeScript checks
 * bivariantly even under `strictFunctionTypes`, so any concrete `EcoTool<X>` is
 * assignable to `AnyEcoTool`. Callers narrow `unknown` args via `tool.validate`
 * (or simply hand them straight back to the same `tool.execute`).
 */
export type AnyEcoTool = {
  name: string;
  description: string;
  validate(value: unknown): boolean;
  /**
   * Returns extracted args (any shape) on a confident match, else `null`.
   * `context` is optional conversation-derived hints (see {@link ToolMatchContext});
   * tools that ignore it are unaffected.
   */
  match(userText: string, context?: ToolMatchContext): unknown;
  execute(
    args: unknown,
    opts?: { signal?: AbortSignal },
  ): EcoToolResult | Promise<EcoToolResult>;
  /** Optional friendly one-line summary of the call, derived from args. */
  summarize?(args: unknown): string;
  /** How the pipeline surfaces the result; absent ⇒ `"tool-block"` (see {@link EcoTool}). */
  presentation?: "tool-block" | "citation" | "host-answer";
};

export type EcoToolRegistry = Record<string, AnyEcoTool>;

/** A confident detection: the matched tool plus the args its `match` extracted. */
export type EcoToolDetection = {
  tool: AnyEcoTool;
  args: unknown;
};

/**
 * Run each tool's `match` over `userText` and return the first confident hit.
 *
 * Single-tool / single-turn by design (v1): the first tool whose `match` returns
 * non-null wins. Order in `tools` is the priority order. Returns `null` when no
 * tool confidently matches — the caller then falls back to normal chat.
 *
 * `context` is OPTIONAL conversation-derived hints (see {@link ToolMatchContext}),
 * passed straight through to each tool's `match`. It is the LAST parameter so every
 * existing two-arg call site keeps working; tools that ignore it are unaffected.
 */
export function detectTool(
  userText: string,
  tools: readonly AnyEcoTool[],
  context?: ToolMatchContext,
): EcoToolDetection | null {
  if (typeof userText !== "string" || userText.trim() === "") {
    return null;
  }

  for (const tool of tools) {
    const args = tool.match(userText, context);
    if (args !== null) {
      return { tool, args };
    }
  }

  return null;
}
